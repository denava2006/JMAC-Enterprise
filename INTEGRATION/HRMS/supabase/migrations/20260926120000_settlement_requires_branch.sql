-- ===========================================================================
-- F6A: a settlement is one branch's money
-- ===========================================================================
--
-- Hosted acceptance settled the business rule: every settlement names a
-- branch, provider payouts included. A settlement is one branch, one provider,
-- the sales chosen, and one destination account -- which is what makes it
-- reconcilable against a branch's own records.
--
-- This reverses the all-branches allowance added earlier in F6A. That was
-- built on the reasonable-sounding assumption that a provider payout may
-- aggregate branches, and it may -- but a settlement that spans branches
-- cannot be reconciled by any one of them, so the business would rather record
-- it per branch. The rule is theirs to set, and this is the shape they want.
--
-- GRANDFATHERING. The audit found no rows at all in collection_settlements in
-- production, so there is nothing to preserve. The constraint is still added
-- NOT VALID rather than validated: it enforces on every insert and update from
-- here on while leaving any row that might land between this audit and this
-- deploy alone. Historical records are evidence, not something to rewrite to
-- suit a rule made after them.

-- ---------------------------------------------------------------------------
-- 1. The structural rule
-- ---------------------------------------------------------------------------
alter table public.collection_settlements
  drop constraint if exists collection_settlements_shape;

alter table public.collection_settlements
  add constraint collection_settlements_shape check (
    (kind = 'branch_cash' and branch_id is not null and payment_method is null)
    or
    (kind = 'provider' and branch_id is not null and payment_method is not null)
  ) not valid;

comment on constraint collection_settlements_shape on public.collection_settlements is
  'Every settlement names one branch. NOT VALID so any pre-existing row is '
  'left as the record it is, while everything new must satisfy the rule.';

-- ---------------------------------------------------------------------------
-- 2. What is still waiting, for one branch
-- ---------------------------------------------------------------------------
--
-- A null branch now returns nothing rather than everything. The difference
-- matters: "no branch chosen" and "every branch" look identical in a result
-- set, and the earlier version answered the second question when the user had
-- asked neither -- collections appeared before anyone had said whose they were.
--
-- Both kinds require it. Branch cash always had a branch in practice, so
-- answering across branches when none was given was dead behaviour that could
-- only mislead.
--
-- The date rule is untouched: no date filter still means every still-unsettled
-- collection for that branch, however old. That fix stays.
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
    -- Nothing until a branch is named. Not an error: the caller is a form that
    -- has not been filled in yet, and an empty list is the honest answer to
    -- "what is waiting at no branch in particular".
    and _branch_id is not null
    and s.branch_id = _branch_id
    and s.status = 'completed'
    and (bounds.period_start is null or s.created_at >= bounds.period_start)
    and (bounds.period_end is null or s.created_at < bounds.period_end)
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
  'Collections at one branch not yet covered by a live settlement. A null '
  'branch returns nothing. With no date filter this returns every outstanding '
  'collection at that branch regardless of age.';

-- ---------------------------------------------------------------------------
-- 3. The item guard, holding every line to the settlement's branch
-- ---------------------------------------------------------------------------
-- security definer, which it was not before. The guard has to read pos_sales
-- to check the branch, the method and the status -- and Finance cannot read
-- pos_sales, by design. Running as the invoker it therefore saw nothing and
-- refused every direct insert with "That sale does not exist": fail-closed, so
-- safe, but it meant the real rules only ran when the RPC happened to be the
-- caller. An authority that only holds on the path you expected is not an
-- authority. Now it validates identically however the row arrives.
create or replace function public.guard_settlement_item_once()
returns trigger language plpgsql security definer set search_path = '' as $fn$
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

  if _sale.status <> 'completed' then
    raise exception 'Only completed sales can be settled.' using errcode = 'check_violation';
  end if;

  -- One branch, whichever kind. This is the rule the frontend expresses and
  -- the one that holds when the frontend is bypassed: a Cavite settlement
  -- cannot contain a Main Office sale, however it was submitted.
  if _s.branch_id is not null and _sale.branch_id <> _s.branch_id then
    raise exception 'That sale belongs to another branch.' using errcode = 'check_violation';
  end if;

  if _s.kind = 'branch_cash' then
    if _sale.payment_method <> 'cash' then
      raise exception 'A branch cash remittance can only cover cash sales.'
        using errcode = 'check_violation';
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
-- 4. Creation, refusing in words a person can act on
-- ---------------------------------------------------------------------------
--
-- The constraint would refuse this too, but with a message about a check
-- constraint. Somebody filling in a form deserves to be told which field.
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

  -- Both kinds. A settlement is one branch's money, and which branch is not
  -- something the system can infer on the Accountant's behalf.
  if _branch_id is null then
    raise exception 'Choose a branch for this settlement.' using errcode = 'check_violation';
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
