-- Pricing, reference rules and finalization for provider-backed POS payments.
--
-- Three problems this solves, all found by reading checkout_pos_sale rather
-- than assuming what it did:
--
--   1. The total is NOT the sum of the line prices. Branch fees from
--      branch_pos_settings.fees are added, each rounded individually before
--      summing. An Edge Function that priced the cart itself would undercharge
--      every branch that has a fee configured, and nobody would notice until a
--      reconciliation came up short.
--
--   2. validate_pos_payment_reference raises 'Invalid payment method' for
--      card, qrph and paymaya, and demands 6-32 DIGITS for gcash. A
--      provider-backed reference is neither.
--
--   3. checkout_pos_sale identifies the cashier with auth.uid(). A webhook has
--      no user session, so it cannot call it at all.
--
-- The response to (3) is the important design decision. The tempting fix is a
-- second checkout path for card sales. That would mean two engines that must
-- agree forever about pricing, fees, rounding, inventory, idempotency and
-- audit -- and they would drift. Instead finalize_pos_payment sets the
-- transaction-local JWT claim to the cashier the SERVER recorded when the
-- payment was created, and calls the one real checkout_pos_sale. Card sales
-- therefore get the same advisory locking, the same fingerprint idempotency,
-- the same deterministic lock ordering and the same atomic deduction that two
-- concurrency harnesses already exercise for cash.

-- ---------------------------------------------------------------- references
-- Provider-backed references are server-generated and self-identifying, so
-- they are accepted for any non-cash method. Everything else falls through to
-- the existing rules unchanged, so manually-keyed GCash and Maya references
-- still have to be 6-32 digits and no historical sale becomes invalid.
create or replace function public.validate_pos_payment_reference(_payment_method text, _payment_reference text)
returns text
language plpgsql
immutable
set search_path = ''
as $fn$
declare
  _normalized text := nullif(btrim(coalesce(_payment_reference, '')), '');
begin
  if _payment_method = 'cash' then
    return null;
  end if;

  if _normalized is null then
    raise exception 'A payment reference is required for % payments', _payment_method;
  end if;

  -- A JMAC-issued reference can only have come from create-paymongo-checkout;
  -- the browser never chooses it.
  if _normalized ~ '^JMAC-POS-[A-Z0-9]{6,32}$' then
    return _normalized;
  end if;

  if _payment_method in ('gcash', 'maya') then
    if _normalized !~ '^[0-9]{6,32}$' then
      raise exception 'A % reference must be 6-32 digits (numbers only)', _payment_method;
    end if;
  elsif _payment_method = 'bank' then
    if _normalized !~ '^[A-Za-z0-9 -]{6,64}$' then
      raise exception 'A bank reference must be 6-64 characters using letters, numbers, spaces or hyphens';
    end if;
  elsif _payment_method in ('card', 'qrph', 'paymaya') then
    -- Only ever written by the server, from a provider identifier.
    if _normalized !~ '^[A-Za-z0-9_-]{6,64}$' then
      raise exception 'An electronic payment reference must be 6-64 characters';
    end if;
  elsif _payment_method = 'other' then
    if char_length(_normalized) > 64 or _normalized ~ '[[:cntrl:]]' then
      raise exception 'A payment reference must be 1-64 printable characters';
    end if;
  else
    raise exception 'Invalid payment method';
  end if;

  return _normalized;
end;
$fn$;

revoke all on function public.validate_pos_payment_reference(text, text) from public, anon;
grant execute on function public.validate_pos_payment_reference(text, text) to authenticated, service_role;

-- ------------------------------------------------------------------ pricing
-- The canonical price of a cart, by exactly the rules checkout_pos_sale uses:
-- branch override else product default, each fee rounded before summing, total
-- rounded once at the end. A contract test asserts this agrees with a real
-- checkout to the centavo, because the whole point is that the amount charged
-- and the amount recorded can never diverge.
create or replace function public.price_pos_cart(_branch_id uuid, _items jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $fn$
declare
  _settings public.branch_pos_settings%rowtype;
  _normalized jsonb;
  _line jsonb;
  _fee jsonb;
  _product_id uuid;
  _quantity integer;
  _name text;
  _price numeric(12,2);
  _subtotal numeric(14,2) := 0;
  _fees_total numeric(14,2) := 0;
  _fee_amount numeric(14,2);
  _total numeric(14,2);
  _lines jsonb := '[]'::jsonb;
begin
  if _items is null or jsonb_typeof(_items) <> 'array' or jsonb_array_length(_items) = 0 then
    raise exception 'The cart is empty';
  end if;
  if jsonb_array_length(_items) > public.pos_max_cart_lines() * 4 then
    raise exception 'That cart has too many lines';
  end if;

  -- Merged and sorted the same way checkout_pos_sale merges, so a cart with a
  -- duplicated line prices identically to the sale it will become.
  begin
    select jsonb_agg(jsonb_build_object('product_id', pid, 'quantity', qty) order by pid)
    into _normalized
    from (
      select (value->>'product_id')::uuid as pid, sum((value->>'quantity')::integer) as qty
      from jsonb_array_elements(_items)
      group by 1
    ) merged;
  exception when others then
    raise exception 'Every cart line needs a product and a whole-number quantity';
  end;

  if _normalized is null or jsonb_array_length(_normalized) > public.pos_max_cart_lines() then
    raise exception 'That cart cannot be priced';
  end if;

  if not exists (select 1 from public.branches b where b.id = _branch_id and b.is_active) then
    raise exception 'That branch is not active';
  end if;

  select * into _settings from public.branch_pos_settings s where s.branch_id = _branch_id;

  for _line in select value from jsonb_array_elements(_normalized) loop
    _product_id := (_line->>'product_id')::uuid;
    _quantity := (_line->>'quantity')::integer;

    if _quantity is null or _quantity <= 0 then
      raise exception 'Every quantity must be a positive whole number';
    end if;
    if _quantity > public.pos_max_line_quantity() then
      raise exception 'A single line cannot exceed % units', public.pos_max_line_quantity();
    end if;

    select p.name, coalesce(bp.selling_price_override, p.default_selling_price)
    into _name, _price
    from public.pos_branch_products bp
    join public.pos_products p on p.id = bp.product_id
    where bp.branch_id = _branch_id
      and bp.product_id = _product_id
      and bp.is_available
      and p.status = 'active';
    if not found then
      raise exception 'One of those products is no longer available at this branch';
    end if;

    _subtotal := _subtotal + round(_price * _quantity, 2);
    _lines := _lines || jsonb_build_array(jsonb_build_object(
      'product_id', _product_id, 'name', _name,
      'quantity', _quantity, 'unit_price', _price
    ));
  end loop;

  for _fee in select value from jsonb_array_elements(coalesce(_settings.fees, '[]'::jsonb)) loop
    if coalesce((_fee->>'enabled')::boolean, false)
      and coalesce((_fee->>'value')::numeric, 0) > 0
      and (_fee->>'type') in ('percent', 'fixed')
    then
      _fee_amount := case
        when (_fee->>'type') = 'percent' then round(_subtotal * ((_fee->>'value')::numeric / 100), 2)
        else round((_fee->>'value')::numeric, 2)
      end;
      _fees_total := _fees_total + _fee_amount;
    end if;
  end loop;

  _total := round(_subtotal + _fees_total, 2);

  return jsonb_build_object(
    'subtotal', _subtotal,
    'fees_total', _fees_total,
    'total', _total,
    -- Centavos, computed once, here. The provider speaks centavos and this is
    -- the only place pesos become them.
    'total_centavos', (round(_total * 100))::bigint,
    'lines', _lines,
    'normalized_items', _normalized
  );
end;
$fn$;

revoke all on function public.price_pos_cart(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.price_pos_cart(uuid, jsonb) to service_role;

comment on function public.price_pos_cart(uuid, jsonb) is
  'The canonical price of a POS cart, including branch fees, by the same rules '
  'checkout_pos_sale uses. Server-side only: it is what a customer gets charged.';

-- ------------------------------------------------------------- finalization
create or replace function public.finalize_pos_payment(
  _attempt_id uuid,
  _provider_payment_id text default null,
  _paid_centavos bigint default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  _a public.pos_payment_attempts%rowtype;
  _pricing jsonb;
  _receipt jsonb;
  _sale_total numeric(14,2);
begin
  -- Serialise redeliveries of the same payment. PayMongo retries webhooks, and
  -- two arriving at once must not both finalize.
  select * into _a from public.pos_payment_attempts a
  where a.id = _attempt_id for update;
  if not found then
    raise exception 'Unknown payment attempt';
  end if;

  if _a.livemode then
    raise exception 'Refusing to finalize a live-mode payment';
  end if;

  -- Already done. Returning rather than raising is what makes a webhook
  -- delivered twelve times finalize exactly once and still answer 200.
  if _a.status = 'paid' then
    return jsonb_build_object('status', 'paid', 'sale_id', _a.sale_id, 'already', true);
  end if;
  if _a.status in ('paid_unfulfilled', 'cancelled', 'expired', 'failed') then
    return jsonb_build_object('status', _a.status::text, 'sale_id', _a.sale_id, 'already', true);
  end if;

  -- What the provider says was paid must match what we asked for. A mismatch
  -- is never finalized: recording a sale for an amount the customer did not
  -- pay is worse than making a person look at it.
  if _paid_centavos is not null and _paid_centavos <> _a.amount_centavos then
    update public.pos_payment_attempts
    set status = 'paid_unfulfilled',
        provider_payment_id = coalesce(_provider_payment_id, provider_payment_id),
        last_error = format('paid %s centavos, expected %s', _paid_centavos, _a.amount_centavos),
        paid_at = now()
    where id = _a.id;
    return jsonb_build_object('status', 'paid_unfulfilled', 'reason', 'amount_mismatch');
  end if;

  -- Re-price against today's catalogue. If a price changed while the customer
  -- was paying, the sale would record a different total than was charged, so
  -- refuse and leave it for a refund decision.
  begin
    _pricing := public.price_pos_cart(_a.branch_id, _a.items);
  exception when others then
    update public.pos_payment_attempts
    set status = 'paid_unfulfilled',
        provider_payment_id = coalesce(_provider_payment_id, provider_payment_id),
        last_error = left('could not re-price: ' || sqlerrm, 500),
        paid_at = now()
    where id = _a.id;
    return jsonb_build_object('status', 'paid_unfulfilled', 'reason', 'repricing_failed');
  end;

  if (_pricing->>'total_centavos')::bigint <> _a.amount_centavos then
    update public.pos_payment_attempts
    set status = 'paid_unfulfilled',
        provider_payment_id = coalesce(_provider_payment_id, provider_payment_id),
        last_error = format('price changed: cart now %s centavos, charged %s',
                            _pricing->>'total_centavos', _a.amount_centavos),
        paid_at = now()
    where id = _a.id;
    return jsonb_build_object('status', 'paid_unfulfilled', 'reason', 'price_changed');
  end if;

  -- Become the cashier who started this payment, for this transaction only.
  -- The identity comes from the attempt row, which the server wrote; no
  -- caller-supplied value reaches it. checkout_pos_sale then re-checks POS
  -- authority as usual, so a cashier who lost access mid-payment cannot
  -- complete a sale -- that lands as paid_unfulfilled, correctly.
  perform set_config('request.jwt.claims',
    jsonb_build_object('sub', _a.cashier_profile_id::text, 'role', 'authenticated')::text, true);

  begin
    _receipt := public.checkout_pos_sale(
      _a.branch_id,
      _a.items,
      _a.method,
      _a.checkout_key,
      _a.reference_number,
      null
    );
  exception when others then
    perform set_config('request.jwt.claims', '', true);
    update public.pos_payment_attempts
    set status = 'paid_unfulfilled',
        provider_payment_id = coalesce(_provider_payment_id, provider_payment_id),
        last_error = left(sqlerrm, 500),
        paid_at = now()
    where id = _a.id;
    return jsonb_build_object('status', 'paid_unfulfilled', 'reason', 'checkout_failed');
  end;

  perform set_config('request.jwt.claims', '', true);

  _sale_total := (_receipt->'sale'->>'total_amount')::numeric;

  update public.pos_payment_attempts
  set status = 'paid',
      sale_id = (_receipt->'sale'->>'id')::uuid,
      provider_payment_id = coalesce(_provider_payment_id, provider_payment_id),
      paid_at = now(),
      last_error = null
  where id = _a.id;

  return jsonb_build_object(
    'status', 'paid',
    'sale_id', (_receipt->'sale'->>'id')::uuid,
    'total', _sale_total
  );
end;
$fn$;

revoke all on function public.finalize_pos_payment(uuid, text, bigint) from public, anon, authenticated;
grant execute on function public.finalize_pos_payment(uuid, text, bigint) to service_role;

comment on function public.finalize_pos_payment(uuid, text, bigint) is
  'Turns a confirmed PayMongo payment into a sale through the one real '
  'checkout_pos_sale, acting as the cashier recorded on the attempt. '
  'Service-role only: a browser that could call this could pay for nothing.';

-- --------------------------------------------------------------- provider state
-- Failure, expiry and till-side cancellation. Separate from finalization
-- because none of them may ever create a sale.
create or replace function public.mark_pos_payment_state(
  _attempt_id uuid,
  _status public.pos_payment_status,
  _reason text default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $fn$
begin
  if _status not in ('failed', 'expired', 'cancelled') then
    raise exception 'mark_pos_payment_state only records terminal non-paid states';
  end if;

  -- A paid attempt is never demoted. A late "expired" event after a successful
  -- payment must not unmake the sale.
  update public.pos_payment_attempts
  set status = _status,
      last_error = coalesce(_reason, last_error),
      failed_at = case when _status = 'failed' then now() else failed_at end,
      cancelled_at = case when _status = 'cancelled' then now() else cancelled_at end
  where id = _attempt_id
    and status = 'pending';
end;
$fn$;

revoke all on function public.mark_pos_payment_state(uuid, public.pos_payment_status, text) from public, anon, authenticated;
grant execute on function public.mark_pos_payment_state(uuid, public.pos_payment_status, text) to service_role;

-- ------------------------------------------------------- till-side cancellation
-- A cashier abandoning a payment at the till. Deliberately cannot mark
-- anything paid, and only touches a pending attempt at a branch they work.
create or replace function public.cancel_pos_payment_attempt(_checkout_key uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  _a public.pos_payment_attempts%rowtype;
begin
  select * into _a from public.pos_payment_attempts a where a.checkout_key = _checkout_key;
  if not found then
    return;
  end if;
  if not public.has_pos_role(_a.branch_id, array['manager', 'cashier']::public.pos_role[]) then
    raise exception 'You do not have POS access at this branch';
  end if;

  update public.pos_payment_attempts
  set status = 'cancelled', cancelled_at = now(), last_error = 'cancelled at the till'
  where id = _a.id and status = 'pending';
end;
$fn$;

revoke all on function public.cancel_pos_payment_attempt(uuid) from public, anon;
grant execute on function public.cancel_pos_payment_attempt(uuid) to authenticated;
