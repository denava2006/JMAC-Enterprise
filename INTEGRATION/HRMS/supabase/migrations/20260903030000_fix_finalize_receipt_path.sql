-- finalize_pos_payment read the receipt at the wrong path.
--
-- pos_sale_receipt returns a FLAT object -- 'sale_id' and 'total_amount' at the
-- top level -- but finalize_pos_payment read `_receipt->'sale'->>'id'`, as
-- though the sale were nested. jsonb returns NULL for a missing path rather
-- than raising, so the update ran, the status became 'paid', and the sale_id
-- was silently left NULL.
--
-- Everything else about the payment was correct: the sale existed, the stock
-- was deducted once, the amount matched. Only the link back from the attempt to
-- the sale was missing -- which is exactly the field the till waits on before
-- it shows the receipt, so a real cashier would have watched "Paid. Completing
-- the sale." forever on a sale that had in fact completed.
--
-- Found by an end-to-end test payment, not by the contract suite: the suite
-- asserted the returned status and counted the sales, but never asserted that
-- the attempt actually pointed at one. The suite now checks it.

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
  _sale_id uuid;
  _sale_total numeric(14,2);
begin
  select * into _a from public.pos_payment_attempts a
  where a.id = _attempt_id for update;
  if not found then
    raise exception 'Unknown payment attempt';
  end if;

  if _a.livemode then
    raise exception 'Refusing to finalize a live-mode payment';
  end if;

  if _a.status = 'paid' then
    return jsonb_build_object('status', 'paid', 'sale_id', _a.sale_id, 'already', true);
  end if;
  if _a.status in ('paid_unfulfilled', 'cancelled', 'expired', 'failed') then
    return jsonb_build_object('status', _a.status::text, 'sale_id', _a.sale_id, 'already', true);
  end if;

  if _paid_centavos is not null and _paid_centavos <> _a.amount_centavos then
    update public.pos_payment_attempts
    set status = 'paid_unfulfilled',
        provider_payment_id = coalesce(_provider_payment_id, provider_payment_id),
        last_error = format('paid %s centavos, expected %s', _paid_centavos, _a.amount_centavos),
        paid_at = now()
    where id = _a.id;
    return jsonb_build_object('status', 'paid_unfulfilled', 'reason', 'amount_mismatch');
  end if;

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

  perform set_config('request.jwt.claims',
    jsonb_build_object('sub', _a.cashier_profile_id::text, 'role', 'authenticated')::text, true);

  begin
    _receipt := public.checkout_pos_sale(
      _a.branch_id, _a.items, _a.method, _a.checkout_key, _a.reference_number, null
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

  -- The receipt is flat. Read it that way.
  _sale_id := (_receipt->>'sale_id')::uuid;
  _sale_total := (_receipt->>'total_amount')::numeric;

  -- A paid attempt with no sale to point at is not a success. Refusing here
  -- means a future change to the receipt shape surfaces as a loud failure
  -- instead of a payment that looks fine and links to nothing.
  if _sale_id is null then
    update public.pos_payment_attempts
    set status = 'paid_unfulfilled',
        provider_payment_id = coalesce(_provider_payment_id, provider_payment_id),
        last_error = 'checkout returned no sale id',
        paid_at = now()
    where id = _a.id;
    return jsonb_build_object('status', 'paid_unfulfilled', 'reason', 'no_sale_id');
  end if;

  update public.pos_payment_attempts
  set status = 'paid',
      sale_id = _sale_id,
      provider_payment_id = coalesce(_provider_payment_id, provider_payment_id),
      paid_at = now(),
      last_error = null
  where id = _a.id;

  return jsonb_build_object('status', 'paid', 'sale_id', _sale_id, 'total', _sale_total);
end;
$fn$;

revoke all on function public.finalize_pos_payment(uuid, text, bigint) from public, anon, authenticated;
grant execute on function public.finalize_pos_payment(uuid, text, bigint) to service_role;

-- Repair any attempt already finalized with the broken path. The sale exists
-- and shares the checkout key, so the link is recoverable rather than lost.
update public.pos_payment_attempts a
set sale_id = s.id
from public.pos_sales s
where s.checkout_key = a.checkout_key
  and a.status = 'paid'
  and a.sale_id is null;
