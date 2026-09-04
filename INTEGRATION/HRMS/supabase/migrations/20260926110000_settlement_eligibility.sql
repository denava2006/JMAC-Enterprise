-- ===========================================================================
-- F6A fix: what is actually still waiting to be settled
-- ===========================================================================
--
-- Three defects from hosted acceptance, all in the same query, all mine.
--
-- 1. OLD MONEY VANISHED. get_unsettled_collections called
--    pos_report_bounds(_from_date, _to_date) unconditionally, and that
--    function defaults a null range to the current Manila business day -- it
--    was written for daily sales reports, where "today" is the obvious
--    default. Settlement is not a daily report. An unsettled GCash sale from
--    the 4th was offered on the 4th and gone on the 5th, with nothing to
--    explain where it went. Money does not stop needing to be banked because
--    the day ended.
--
--    Now: no dates means no bound. The only thing that makes a collection
--    ineligible is being covered by a settlement that still counts.
--    pos_report_bounds is still used when a date filter IS given, because the
--    Manila day boundary is exactly right for that, and reimplementing it here
--    would be a second answer to a question that has one.
--
-- 2. MAYA APPEARED TWICE. Two stored values, 'maya' and 'paymaya', both label
--    as "Maya" -- the first is legacy, the second is PayMongo's identifier and
--    what current sales carry. The settlement UI listed both, so the menu read
--    GCash / Maya / Maya / Card / QR Ph.
--
--    Fixing that in the UI alone would have stranded every legacy 'maya' row
--    for ever: unlistable, therefore unsettleable. So the family is normalised
--    here, in one function, and used by the eligibility query and the item
--    guard alike. Choosing Maya finds both. Nothing else about method
--    validation moves -- the pos_sales CHECK constraint is untouched.
--
-- 3. PROVIDER SETTLEMENTS COULD NOT BE SCOPED TO A BRANCH. A real payout may
--    aggregate branches, so all-branches stays allowed; but an Accountant
--    reconciling one branch had no way to ask for one branch. Branch is now
--    optional on a provider settlement, and when it IS set the item guard
--    enforces it -- the frontend filter is a convenience, not the rule.

-- ---------------------------------------------------------------------------
-- 1. The provider family
-- ---------------------------------------------------------------------------
--
-- 'maya' predates PayMongo's 'paymaya'. They are one provider, and a customer
-- who paid Maya in July should not be in a different bucket from one who paid
-- Maya today. Everything else is its own family.
create or replace function public.pos_provider_family(_method text)
returns text
language sql
immutable
set search_path = ''
as $fn$
  select case when _method in ('maya', 'paymaya') then 'paymaya' else _method end;
$fn$;

comment on function public.pos_provider_family(text) is
  'Canonical provider for a stored pos_sales.payment_method. Legacy maya and '
  'current paymaya are one family, so historical rows stay settleable.';

-- ---------------------------------------------------------------------------
-- 2. A provider settlement may name a branch
-- ---------------------------------------------------------------------------
--
-- Optional, not required: a payout genuinely can cover several branches at
-- once, and forcing a branch would make those unrecordable. Branch cash is
-- unchanged -- a remittance is always one branch emptying its own drawer.
alter table public.collection_settlements
  drop constraint if exists collection_settlements_shape;

alter table public.collection_settlements
  add constraint collection_settlements_shape check (
    (kind = 'branch_cash' and branch_id is not null and payment_method is null)
    or
    (kind = 'provider' and payment_method is not null)
  );

-- ---------------------------------------------------------------------------
-- 3. What is still waiting
-- ---------------------------------------------------------------------------
drop function if exists public.get_unsettled_collections(text, uuid, text, date, date);

create or replace function public.get_unsettled_collections(
  _kind text,
  _branch_id uuid default null,
  _payment_method text default null,
  _from_date date default null,
  _to_date date default null
)
returns table (
  sale_id uuid,
  sold_at timestamptz,
  branch_id uuid,
  branch_name text,
  cashier_name text,
  payment_method text,
  payment_reference text,
  amount numeric
)
language sql
stable
security definer
set search_path = ''
as $fn$
  -- The window, and only when one was asked for. Both dates null means every
  -- outstanding collection, however old -- which is the whole point of the
  -- fix. When a date IS given, pos_report_bounds resolves it into Philippine
  -- business-day bounds, the same way every POS report does.
  with bounds as (
    select b.period_start, b.period_end
    from public.pos_report_bounds(_from_date, _to_date) b
    where _from_date is not null or _to_date is not null
  )
  select
    s.id, s.created_at, s.branch_id, s.branch_name, s.cashier_name,
    s.payment_method, s.payment_reference, s.total_amount
  from public.pos_sales s
  left join bounds on true
  where public.can_read_finance_master()
    and s.status = 'completed'
    and (bounds.period_start is null or s.created_at >= bounds.period_start)
    and (bounds.period_end is null or s.created_at < bounds.period_end)
    -- Branch now narrows both kinds. Null still means every branch, which a
    -- provider payout may legitimately span.
    and (_branch_id is null or s.branch_id = _branch_id)
    and case
          when _kind = 'branch_cash' then s.payment_method = 'cash'
          else
            s.payment_method <> 'cash'
            and (
              _payment_method is null
              or public.pos_provider_family(s.payment_method)
                 = public.pos_provider_family(_payment_method)
            )
        end
    -- The one authoritative exclusion: already covered by a settlement that
    -- still counts. A returned or rejected settlement releases its sales.
    and not exists (
      select 1
      from public.collection_settlement_items i
      join public.collection_settlements cs on cs.id = i.settlement_id
      where i.pos_sale_id = s.id
        and cs.status not in ('returned', 'rejected')
    )
  order by s.created_at, s.id;
$fn$;

comment on function public.get_unsettled_collections(text, uuid, text, date, date) is
  'Collections not yet covered by a live settlement. With no date filter this '
  'returns every outstanding collection regardless of age -- settlement is not '
  'a daily report, and money does not stop needing to be banked.';

-- ---------------------------------------------------------------------------
-- 4. The item guard, following the same rules
-- ---------------------------------------------------------------------------
--
-- The frontend filter is a convenience. This is the rule.
create or replace function public.guard_settlement_item_once()
returns trigger language plpgsql set search_path = '' as $fn$
declare
  _clash text;
  _sale public.pos_sales%rowtype;
  _s public.collection_settlements%rowtype;
begin
  select * into _s from public.collection_settlements where id = new.settlement_id;
  select * into _sale from public.pos_sales where id = new.pos_sale_id;

  if _sale.id is null then
    raise exception 'That sale does not exist.' using errcode = 'check_violation';
  end if;

  -- Only a completed sale is money. Nothing else in POS produces a pos_sales
  -- row -- abandoned, failed, expired and paid_unfulfilled attempts never do.
  if _sale.status <> 'completed' then
    raise exception 'Only completed sales can be settled.' using errcode = 'check_violation';
  end if;

  if _s.kind = 'branch_cash' then
    if _sale.payment_method <> 'cash' then
      raise exception 'A branch cash remittance can only cover cash sales.'
        using errcode = 'check_violation';
    end if;
    if _sale.branch_id <> _s.branch_id then
      raise exception 'That sale belongs to another branch.' using errcode = 'check_violation';
    end if;
  else
    -- Family, not literal: a settlement recorded against Maya covers both the
    -- legacy 'maya' rows and the current 'paymaya' ones.
    if public.pos_provider_family(_sale.payment_method)
       is distinct from public.pos_provider_family(_s.payment_method) then
      raise exception 'That sale was not paid by %.',
        public.pos_provider_family(_s.payment_method) using errcode = 'check_violation';
    end if;
    if _sale.payment_method = 'cash' then
      raise exception 'Cash is remitted by the branch, not settled by a provider.'
        using errcode = 'check_violation';
    end if;
    -- A provider settlement scoped to one branch holds every line to it. Null
    -- branch means a payout spanning branches, which stays allowed.
    if _s.branch_id is not null and _sale.branch_id <> _s.branch_id then
      raise exception 'That sale belongs to another branch.' using errcode = 'check_violation';
    end if;
  end if;

  -- The amount is the sale's, never the caller's.
  if new.amount is distinct from _sale.total_amount then
    new.amount := _sale.total_amount;
  end if;

  select s.settlement_no into _clash
  from public.collection_settlement_items i
  join public.collection_settlements s on s.id = i.settlement_id
  where i.pos_sale_id = new.pos_sale_id
    and i.settlement_id <> new.settlement_id
    and s.status not in ('returned', 'rejected')
  limit 1;

  if _clash is not null then
    raise exception 'That sale is already covered by settlement %.', coalesce(_clash, 'a draft')
      using errcode = 'unique_violation';
  end if;

  return new;
end;
$fn$;

-- ---------------------------------------------------------------------------
-- 5. Creation, storing the canonical family
-- ---------------------------------------------------------------------------
--
-- A settlement records "Maya", not "whichever spelling the first line
-- happened to use", so history reads consistently however old the sales are.
create or replace function public.create_collection_settlement(
  _kind text,
  _destination_account_id uuid,
  _settlement_date date,
  _sale_ids uuid[],
  _branch_id uuid default null,
  _payment_method text default null,
  _fee_amount numeric default 0,
  _reference text default null,
  _notes text default null,
  _submit boolean default false
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  _id uuid;
  _sale uuid;
  _account public.treasury_accounts%rowtype;
  _gross numeric(14,2);
begin
  if not public.has_finance_privilege(array['accountant']) then
    raise exception 'Recording a settlement is the Accountant''s work.'
      using errcode = 'insufficient_privilege';
  end if;

  if _sale_ids is null or array_length(_sale_ids, 1) is null then
    raise exception 'A settlement has to cover at least one sale.'
      using errcode = 'check_violation';
  end if;

  select * into _account from public.treasury_accounts where id = _destination_account_id;
  if _account.id is null or not _account.is_active then
    raise exception 'That destination account is not available.' using errcode = 'check_violation';
  end if;

  insert into public.collection_settlements (
    kind, branch_id, payment_method, destination_account_id,
    fee_amount, settlement_date, reference, notes
  ) values (
    _kind,
    _branch_id,
    case when _kind = 'provider' then public.pos_provider_family(_payment_method) end,
    _destination_account_id,
    coalesce(_fee_amount, 0), coalesce(_settlement_date, current_date),
    nullif(btrim(coalesce(_reference, '')), ''), _notes
  ) returning id into _id;

  foreach _sale in array _sale_ids loop
    insert into public.collection_settlement_items (settlement_id, pos_sale_id, amount)
    values (_id, _sale, 1);
  end loop;

  _gross := public.settlement_gross(_id);
  if coalesce(_fee_amount, 0) > _gross then
    raise exception 'The fee cannot be more than the % collected.',
      to_char(_gross, 'FM999,999,990.00') using errcode = 'check_violation';
  end if;

  if _submit then
    perform public.transition_collection_settlement(_id, 'for_review', null);
  end if;

  return _id;
end;
$fn$;

revoke all on function public.get_unsettled_collections(text, uuid, text, date, date) from public, anon;
revoke all on function public.pos_provider_family(text) from public, anon;
grant execute on function public.get_unsettled_collections(text, uuid, text, date, date) to authenticated;
grant execute on function public.pos_provider_family(text) to authenticated;
