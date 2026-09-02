-- FMS F3.1 — a workflow status is not a financial event.
--
-- F3 derived budget `spent` from a request reaching `completed`. That was wrong
-- for the reason F3 itself kept insisting on elsewhere: there is no purchase
-- order, no goods receipt, no supplier invoice, no accounts payable, no payments
-- ledger and no journal in this system yet. Nothing can settle a request, so
-- nothing can truthfully say money left the company. A status told the budget
-- that money had been spent, and the budget believed it.
--
-- The corrected model:
--
--   draft / submitted / validated   reserved 0, spent 0
--   approved                        the amount becomes RESERVED
--   returned / rejected / cancelled reservation released
--   financial realization           reserved down, spent up   <- F4 and later
--
-- So `spent` goes back to a documented zero, exactly as F2 shipped it, while
-- `reserved` becomes real. An approved purchase request is authorization to
-- procure, not evidence that a purchase happened; an approved reimbursement is
-- authorization to pay, not a payment.

-- ---------------------------------------------------- the status is renamed
-- pending_payment asserted a payment step F3 does not have. `approved` is true
-- for both request types, and the UI says what each is waiting for -- awaiting
-- procurement for a purchase, awaiting payment for a reimbursement.
--
-- Not a destructive rewrite: this is a check constraint rather than an enum,
-- `completed` is KEPT in the allowed set so F4 can reach it without another
-- migration, and any existing row is carried across rather than dropped.
alter table public.finance_requests
  drop constraint if exists finance_requests_status_check;

update public.finance_requests set status = 'approved' where status = 'pending_payment';

alter table public.finance_requests
  add constraint finance_requests_status_check check (status in (
    'draft', 'pending_validation', 'pending_approval',
    'approved', 'completed', 'returned', 'rejected', 'cancelled'));

drop index if exists public.finance_requests_budget_open_idx;
create index if not exists finance_requests_budget_open_idx
  on public.finance_requests (budget_id)
  where status in ('approved', 'completed');

-- ------------------------------------------------------- the transitions
-- The Accountant can no longer complete a request, because completing one would
-- claim a settlement that nothing in this system performs. What they keep is the
-- pre-settlement document check: they may send an approved request back, which
-- releases its reservation. Paying arrives with the phase that can actually pay.
--
-- The Finance Manager gains one move: withdrawing an approval before anything
-- has been realized, which also releases the reservation. Without it an approved
-- request that turns out to be unnecessary would hold budget indefinitely.
create or replace function public.transition_finance_request(
  _request_id uuid,
  _to_status  text,
  _remarks    text default null,
  _paid_from_account_id uuid default null,
  _payment_reference    text default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  _r          record;
  _uid        uuid := (select auth.uid());
  _role       text;
  _is_owner   boolean;
  _action     text;
  _allowed    boolean := false;
  _committed  numeric(14,2);
  _budget     record;
begin
  -- Locked for the duration. A second approval arriving at the same moment
  -- waits here, then finds the status already 'approved' and falls through to
  -- the refusal below -- which is what makes reserving exactly-once, alongside
  -- reserved being DERIVED from status rather than accumulated.
  select * into _r from public.finance_requests where id = _request_id for update;
  if _r.id is null then
    raise exception 'That request no longer exists.' using errcode = 'no_data_found';
  end if;

  select role::text into _role from public.profiles where id = _uid and status = 'active';
  if _role is null then
    raise exception 'Not authorized.' using errcode = 'insufficient_privilege';
  end if;

  _is_owner := (_r.requester_id = _uid);

  if not _is_owner and not public.has_finance_privilege(array[_role]) then
    raise exception 'Only Finance can act on another person''s request.'
      using errcode = 'insufficient_privilege';
  end if;

  if _paid_from_account_id is not null or _payment_reference is not null then
    raise exception 'Payment is not part of this phase: nothing in JMAC can settle a request yet.'
      using errcode = 'feature_not_supported';
  end if;

  -- ------------------------------------------------------------- the table
  if _is_owner and _r.status = 'draft' and _to_status = 'pending_validation' then
    _allowed := true; _action := 'submitted';
  elsif _is_owner and _r.status = 'returned' and _to_status = 'pending_validation' then
    _allowed := true; _action := 'resubmitted';
  elsif _is_owner and _r.status in ('draft', 'returned') and _to_status = 'cancelled' then
    _allowed := true; _action := 'cancelled';

  elsif _role = 'finance_staff' and not _is_owner and _r.status = 'pending_validation'
        and _to_status = 'pending_approval' then
    _allowed := true; _action := 'validated';
  elsif _role = 'finance_staff' and not _is_owner and _r.status = 'pending_validation'
        and _to_status in ('returned', 'rejected') then
    _allowed := true; _action := case _to_status when 'returned' then 'returned' else 'rejected' end;

  elsif _role = 'finance_manager' and not _is_owner and _r.status = 'pending_approval'
        and _to_status = 'approved' then
    _allowed := true; _action := 'approved';
  elsif _role = 'finance_manager' and not _is_owner and _r.status = 'pending_approval'
        and _to_status in ('returned', 'rejected') then
    _allowed := true; _action := case _to_status when 'returned' then 'returned' else 'rejected' end;

  -- Withdrawing an approval before anything was realized. Releases the hold.
  elsif _role = 'finance_manager' and not _is_owner and _r.status = 'approved'
        and _to_status in ('returned', 'rejected') then
    _allowed := true; _action := case _to_status when 'returned' then 'returned' else 'rejected' end;

  -- The Accountant's pre-settlement check. Sending it back releases the hold.
  elsif _role = 'accountant' and not _is_owner and _r.status = 'approved'
        and _to_status = 'returned' then
    _allowed := true; _action := 'returned';
  end if;

  if _to_status = 'completed' then
    raise exception
      'A request cannot be completed yet: completion means settlement, and no procurement, invoice or payment record exists in JMAC to settle it.'
      using errcode = 'feature_not_supported';
  end if;

  if not _allowed then
    raise exception 'A % cannot move request % from % to %.',
      coalesce(_role, 'user'), _r.request_no, _r.status, _to_status
      using errcode = 'insufficient_privilege';
  end if;

  -- ------------------------------------------- approval commits the money
  if _action = 'approved' and _r.budget_id is not null then
    select b.id, b.name, b.amount, b.status into _budget
    from public.budgets b where b.id = _r.budget_id for update;

    if _budget.status <> 'active' then
      raise exception 'Budget "%" is %, so nothing more can be committed against it.',
        _budget.name, _budget.status using errcode = 'check_violation';
    end if;

    -- 'completed' is included for the phase that will be able to reach it, so
    -- realized spending keeps counting against the ceiling then.
    select coalesce(sum(amount), 0) into _committed
    from public.finance_requests
    where budget_id = _r.budget_id
      and status in ('approved', 'completed')
      and id <> _r.id;

    if _committed + _r.amount > _budget.amount then
      raise exception
        'Approving % would put budget "%" over its ceiling of % (% already committed).',
        to_char(_r.amount, 'FM999,999,999.00'), _budget.name,
        to_char(_budget.amount, 'FM999,999,999.00'),
        to_char(_committed, 'FM999,999,999.00')
        using errcode = 'check_violation';
    end if;
  end if;

  perform set_config('jmac.finance_transition', 'on', true);

  update public.finance_requests
     set status = _to_status, updated_at = now()
   where id = _request_id;

  insert into public.finance_request_approvals
    (request_id, actor_id, role_at_action, action, from_status, to_status, remarks)
  values (_request_id, _uid, _role, _action, _r.status, _to_status, _remarks);

  insert into public.audit_logs (actor_id, action, table_name, record_id, new_data)
  values (_uid, 'Finance Request ' || initcap(_action), 'finance_requests', _request_id,
          jsonb_build_object('request_no', _r.request_no, 'from', _r.status,
                             'to', _to_status, 'amount', _r.amount));

  perform set_config('jmac.finance_transition', 'off', true);
end;
$fn$;

revoke all on function public.transition_finance_request(uuid, text, text, uuid, text) from public, anon;
grant execute on function public.transition_finance_request(uuid, text, text, uuid, text) to authenticated;

-- =========================================================================
-- budget_status — reserved is real, spent is honest again
-- =========================================================================
-- reserved: approved requests that have not been released or realized. Derived
-- from status, so approving twice, refreshing, retrying the RPC or reading the
-- row repeatedly cannot reserve the same request twice -- a request has one
-- status, and the same row counted once.
--
-- spent: zero, and it stays zero until something in JMAC can perform a
-- settlement. This is deliberately the same documented literal F2 shipped, for
-- the same reason: a number nobody can point at an event for is not a fact.
-- The phase that introduces procurement, invoices or payments replaces it and
-- moves the realized amounts out of `reserved` at the same moment.
create or replace view public.budget_status
with (security_invoker = true) as
select
  b.id,
  b.name,
  b.department_id,
  d.name as department_name,
  b.finance_category_id,
  c.name as finance_category_name,
  b.period,
  b.fiscal_year,
  b.amount,
  coalesce(a.allocated, 0)::numeric(14,2) as allocated,
  coalesce(r.reserved, 0)::numeric(14,2)  as reserved,
  0::numeric(14,2)                        as spent,
  (b.amount - coalesce(a.allocated, 0))::numeric(14,2) as unallocated,
  (b.amount - coalesce(r.reserved, 0))::numeric(14,2)  as remaining,
  case when b.amount > 0
       then round((coalesce(a.allocated, 0) / b.amount) * 100)::integer
       else 0 end as allocated_pct,
  b.start_date,
  b.end_date,
  b.status,
  b.alert_threshold,
  b.approved_by,
  b.approved_at,
  b.created_by,
  b.created_at,
  b.updated_at
from public.budgets b
left join public.departments d on d.id = b.department_id
left join public.finance_categories c on c.id = b.finance_category_id
left join lateral (
  select sum(amount) as allocated
  from public.budget_allocations al
  where al.budget_id = b.id and al.status = 'active'
) a on true
left join lateral (
  select sum(amount) as reserved
  from public.finance_requests fr
  where fr.budget_id = b.id and fr.status = 'approved'
) r on true;

revoke all on public.budget_status from anon, public, authenticated;
grant select on public.budget_status to authenticated;
grant select on public.budget_status to service_role;

comment on view public.budget_status is
  'A budget and its four numbers. reserved comes from approved requests not yet '
  'released or realized. spent is zero until a settlement source exists -- a '
  'workflow status is not a financial event.';
