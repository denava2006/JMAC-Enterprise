-- FMS F3 — the request workflow.
--
-- How money moves: an employee asks, Finance Staff validate, the Finance
-- Manager approves, the Accountant pays. This is the chain the one-active-role
-- rule from F1 exists to protect, and the phase that finally gives
-- budget_status.reserved and .spent something real to count.
--
-- The standalone system put this entire chain in the UI. Its policy read
--
--   using (requester_id = auth.uid() or is_reviewer())
--   with check (requester_id = auth.uid() or is_reviewer())
--
-- with is_reviewer() meaning "everyone except plain employees". Three holes come
-- straight out of that: any reviewer could set any status (so a request could be
-- marked paid without ever being approved), the requester could edit the amount
-- of an approved request before it was paid, and the requester could delete the
-- request along with its approval history.
--
-- Here a status change is not an UPDATE anybody may write. It is one function
-- that checks who is asking, what the current status is, and whether that move
-- exists at all. `status` is not writable through the API by anyone.

-- ------------------------------------------------------------ reference numbers
create sequence if not exists public.seq_purchase_request;
create sequence if not exists public.seq_reimbursement_request;

-- =========================================================================
-- requests
-- =========================================================================
create table if not exists public.finance_requests (
  id            uuid primary key default gen_random_uuid(),
  request_no    text unique,
  -- Check constraint rather than an enum: a new request type should not need a
  -- migration of its own to become usable (the F1 enum lesson).
  type          text not null check (type in ('purchase', 'reimbursement')),
  title         text not null,
  description   text,
  justification text,

  requester_id  uuid not null references public.profiles(id) on delete restrict,
  department_id uuid references public.departments(id) on delete restrict,

  vendor_id           uuid references public.vendors(id) on delete restrict,
  finance_category_id uuid references public.finance_categories(id) on delete restrict,
  budget_id           uuid references public.budgets(id) on delete restrict,

  amount        numeric(14,2) not null check (amount > 0),
  priority      text not null default 'medium' check (priority in ('low', 'medium', 'high')),
  needed_by     date,
  expense_date  date,

  status        text not null default 'draft' check (status in (
                  'draft', 'pending_validation', 'pending_approval',
                  'pending_payment', 'completed', 'returned', 'rejected', 'cancelled')),

  -- Filled by the Accountant at completion. Which account it came out of and
  -- under what reference -- the end of this chain, not the start of a ledger.
  paid_from_account_id uuid references public.finance_accounts(id) on delete restrict,
  payment_reference    text,
  paid_at              timestamptz,

  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  -- A reimbursement is for money already spent; a purchase is for money about to
  -- be. Asking for the date of an expense that has not happened is nonsense.
  constraint finance_requests_expense_date_is_reimbursement check (
    expense_date is null or type = 'reimbursement'
  ),
  constraint finance_requests_payment_is_complete check (
    (status = 'completed' and paid_from_account_id is not null and paid_at is not null)
    or (status <> 'completed' and paid_at is null)
  )
);

create index if not exists finance_requests_status_idx on public.finance_requests (status);
create index if not exists finance_requests_requester_idx on public.finance_requests (requester_id);
-- The two statuses budget_status sums over, so the lateral stays cheap.
create index if not exists finance_requests_budget_open_idx
  on public.finance_requests (budget_id)
  where status in ('pending_payment', 'completed');

create or replace function public.set_finance_request_no()
returns trigger
language plpgsql
security definer
set search_path = ''
as $fn$
begin
  if new.request_no is null then
    new.request_no := case new.type
      when 'purchase' then 'PR-'
      else 'RB-'
    end
    || to_char(current_date, 'YYYY') || '-'
    || lpad((case new.type
        when 'purchase' then nextval('public.seq_purchase_request')
        else nextval('public.seq_reimbursement_request')
      end)::text, 4, '0');
  end if;
  return new;
end;
$fn$;

revoke all on function public.set_finance_request_no() from public, anon, authenticated;

drop trigger if exists trg_finance_request_no on public.finance_requests;
create trigger trg_finance_request_no
  before insert on public.finance_requests
  for each row execute function public.set_finance_request_no();

-- ------------------------------------------------- the substance is frozen
-- What was approved is what gets paid. Once a request leaves draft/returned its
-- financial fields stop being editable, and `status` is never writable through
-- an UPDATE at all -- only public.transition_finance_request moves it.
create or replace function public.protect_finance_request()
returns trigger
language plpgsql
security definer
set search_path = ''
as $fn$
begin
  -- The transition function sets this for the duration of its own statement.
  if current_setting('jmac.finance_transition', true) = 'on' then
    return new;
  end if;

  if new.status is distinct from old.status then
    raise exception 'A request status is changed by submitting, validating, approving, returning, rejecting or paying it -- not by editing it.'
      using errcode = 'insufficient_privilege';
  end if;

  if old.status not in ('draft', 'returned') then
    if new.amount is distinct from old.amount
       or new.type is distinct from old.type
       or new.vendor_id is distinct from old.vendor_id
       or new.finance_category_id is distinct from old.finance_category_id
       or new.budget_id is distinct from old.budget_id
    then
      raise exception 'Request % has already been submitted; its amount, type, vendor, category and budget can no longer be changed.',
        old.request_no using errcode = 'insufficient_privilege';
    end if;
  end if;

  if new.paid_from_account_id is distinct from old.paid_from_account_id
     or new.payment_reference is distinct from old.payment_reference
     or new.paid_at is distinct from old.paid_at then
    raise exception 'Payment details are recorded when a request is paid, not by editing it.'
      using errcode = 'insufficient_privilege';
  end if;

  return new;
end;
$fn$;

revoke all on function public.protect_finance_request() from public, anon, authenticated;

drop trigger if exists trg_finance_requests_protect on public.finance_requests;
create trigger trg_finance_requests_protect
  before update on public.finance_requests
  for each row execute function public.protect_finance_request();

drop trigger if exists trg_set_updated_at on public.finance_requests;
create trigger trg_set_updated_at before update on public.finance_requests
  for each row execute function public.set_updated_at();

-- =========================================================================
-- request_approvals — who decided what, and when
-- =========================================================================
-- Append-only for everyone, including the Administrator. A record of decisions
-- that can be edited is not a record of decisions.
create table if not exists public.finance_request_approvals (
  id             uuid primary key default gen_random_uuid(),
  request_id     uuid not null references public.finance_requests(id) on delete cascade,
  actor_id       uuid references public.profiles(id) on delete set null,
  role_at_action text,
  action         text not null check (action in (
                   'submitted', 'resubmitted', 'validated', 'approved',
                   'paid', 'returned', 'rejected', 'cancelled')),
  from_status    text,
  to_status      text,
  remarks        text,
  created_at     timestamptz not null default now()
);

create index if not exists finance_request_approvals_request_idx
  on public.finance_request_approvals (request_id, created_at);

-- =========================================================================
-- request_attachments — what validation actually looks at
-- =========================================================================
create table if not exists public.finance_request_attachments (
  id          uuid primary key default gen_random_uuid(),
  request_id  uuid not null references public.finance_requests(id) on delete cascade,
  file_name   text not null,
  file_path   text not null unique,
  file_type   text,
  file_size   integer,
  kind        text not null default 'other'
                check (kind in ('receipt', 'quotation', 'invoice', 'proof_of_payment', 'other')),
  uploaded_by uuid references public.profiles(id) on delete set null,
  created_at  timestamptz not null default now()
);

create index if not exists finance_request_attachments_request_idx
  on public.finance_request_attachments (request_id);

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'finance-request-documents',
  'finance-request-documents',
  false,
  10485760,
  array['image/jpeg', 'image/png', 'image/webp', 'application/pdf']
)
on conflict (id) do nothing;

-- =========================================================================
-- Who may see a request
-- =========================================================================
create or replace function public.can_read_finance_request(_request_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $fn$
  select exists (
    select 1 from public.finance_requests r
    where r.id = _request_id
      and (r.requester_id = (select auth.uid()) or public.can_read_finance_master())
  );
$fn$;

revoke all on function public.can_read_finance_request(uuid) from public, anon;
grant execute on function public.can_read_finance_request(uuid) to authenticated;

-- =========================================================================
-- The state machine
-- =========================================================================
-- One door. Every move names an actor, a from-status and a to-status, and
-- anything not in the table below is refused -- including moves a role would
-- otherwise look senior enough to make.
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
  select * into _r from public.finance_requests where id = _request_id for update;
  if _r.id is null then
    raise exception 'That request no longer exists.' using errcode = 'no_data_found';
  end if;

  select role::text into _role from public.profiles where id = _uid and status = 'active';
  if _role is null then
    raise exception 'Not authorized.' using errcode = 'insufficient_privilege';
  end if;

  _is_owner := (_r.requester_id = _uid);

  -- A finance officer who raises a request is a requester like anybody else:
  -- the next step belongs to somebody who did not ask for the money.
  if not _is_owner and not public.has_finance_privilege(array[_role]) then
    raise exception 'Only Finance can act on another person''s request.'
      using errcode = 'insufficient_privilege';
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
        and _to_status = 'pending_payment' then
    _allowed := true; _action := 'approved';
  elsif _role = 'finance_manager' and not _is_owner and _r.status = 'pending_approval'
        and _to_status in ('returned', 'rejected') then
    _allowed := true; _action := case _to_status when 'returned' then 'returned' else 'rejected' end;

  elsif _role = 'accountant' and not _is_owner and _r.status = 'pending_payment'
        and _to_status = 'completed' then
    _allowed := true; _action := 'paid';
  elsif _role = 'accountant' and not _is_owner and _r.status = 'pending_payment'
        and _to_status = 'returned' then
    _allowed := true; _action := 'returned';
  end if;

  if not _allowed then
    raise exception 'A % cannot move request % from % to %.',
      coalesce(_role, 'user'), _r.request_no, _r.status, _to_status
      using errcode = 'insufficient_privilege';
  end if;

  -- ------------------------------------------- approval commits the money
  -- The reservation is what makes a ceiling mean anything, so this is where a
  -- budget is checked -- once, by the person who owns the ceiling.
  if _action = 'approved' and _r.budget_id is not null then
    select b.id, b.name, b.amount, b.status into _budget
    from public.budgets b where b.id = _r.budget_id for update;

    if _budget.status <> 'active' then
      raise exception 'Budget "%" is %, so nothing more can be committed against it.',
        _budget.name, _budget.status using errcode = 'check_violation';
    end if;

    select coalesce(sum(amount), 0) into _committed
    from public.finance_requests
    where budget_id = _r.budget_id
      and status in ('pending_payment', 'completed')
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

  if _action = 'paid' then
    if _paid_from_account_id is null then
      raise exception 'Say which account this was paid from.' using errcode = 'check_violation';
    end if;
    if not exists (select 1 from public.finance_accounts
                   where id = _paid_from_account_id and is_active) then
      raise exception 'That account is not open.' using errcode = 'check_violation';
    end if;
  end if;

  -- ------------------------------------------------------------- the move
  perform set_config('jmac.finance_transition', 'on', true);

  update public.finance_requests
     set status = _to_status,
         paid_from_account_id = case when _action = 'paid' then _paid_from_account_id else paid_from_account_id end,
         payment_reference    = case when _action = 'paid' then _payment_reference else payment_reference end,
         paid_at              = case when _action = 'paid' then now() else paid_at end,
         updated_at = now()
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
-- Row level security
-- =========================================================================
alter table public.finance_requests            enable row level security;
alter table public.finance_request_approvals   enable row level security;
alter table public.finance_request_attachments enable row level security;

-- A person sees their own requests; Finance and the Administrator see all.
drop policy if exists finance_requests_read on public.finance_requests;
create policy finance_requests_read on public.finance_requests
  for select to authenticated
  using (requester_id = (select auth.uid()) or public.can_read_finance_master());

-- Anyone with a live employment may ask. Requests are raised by the people who
-- need things bought, which is not only Finance.
drop policy if exists finance_requests_raise on public.finance_requests;
create policy finance_requests_raise on public.finance_requests
  for insert to authenticated
  with check (
    requester_id = (select auth.uid())
    and status = 'draft'
    and exists (
      select 1 from public.profiles pr
      join public.employees e on e.id = pr.employee_id
      where pr.id = (select auth.uid()) and pr.status = 'active'
        and public.employment_permits_operational_work(e.employment_status)
    )
  );

-- Only the requester edits, and only while it is theirs to edit. The trigger
-- above independently refuses status and frozen-field changes, so this policy
-- and that trigger have to BOTH agree before anything moves.
drop policy if exists finance_requests_amend on public.finance_requests;
create policy finance_requests_amend on public.finance_requests
  for update to authenticated
  using (requester_id = (select auth.uid()) and status in ('draft', 'returned'))
  with check (requester_id = (select auth.uid()) and status in ('draft', 'returned'));

-- The approval trail is readable with the request and writable by nobody:
-- every row in it is written by transition_finance_request, which is SECURITY
-- DEFINER and therefore not bound by these policies.
drop policy if exists finance_request_approvals_read on public.finance_request_approvals;
create policy finance_request_approvals_read on public.finance_request_approvals
  for select to authenticated
  using (public.can_read_finance_request(request_id));

drop policy if exists finance_request_attachments_read on public.finance_request_attachments;
create policy finance_request_attachments_read on public.finance_request_attachments
  for select to authenticated
  using (public.can_read_finance_request(request_id));

drop policy if exists finance_request_attachments_add on public.finance_request_attachments;
create policy finance_request_attachments_add on public.finance_request_attachments
  for insert to authenticated
  with check (
    exists (
      select 1 from public.finance_requests r
      where r.id = request_id
        and r.requester_id = (select auth.uid())
        and r.status in ('draft', 'returned')
    )
  );

drop policy if exists finance_request_attachments_remove on public.finance_request_attachments;
create policy finance_request_attachments_remove on public.finance_request_attachments
  for delete to authenticated
  using (
    exists (
      select 1 from public.finance_requests r
      where r.id = request_id
        and r.requester_id = (select auth.uid())
        and r.status in ('draft', 'returned')
    )
  );

-- ------------------------------------------------------------------ storage
drop policy if exists finance_request_documents_read on storage.objects;
create policy finance_request_documents_read on storage.objects
  for select to authenticated
  using (
    bucket_id = 'finance-request-documents'
    and (
      public.can_read_finance_master()
      or exists (
        select 1 from public.finance_request_attachments a
        join public.finance_requests r on r.id = a.request_id
        where a.file_path = storage.objects.name
          and r.requester_id = (select auth.uid())
      )
    )
  );

drop policy if exists finance_request_documents_write on storage.objects;
create policy finance_request_documents_write on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'finance-request-documents'
    and exists (
      select 1 from public.profiles pr
      join public.employees e on e.id = pr.employee_id
      where pr.id = (select auth.uid()) and pr.status = 'active'
        and public.employment_permits_operational_work(e.employment_status)
    )
  );

-- =========================================================================
-- Table privileges
-- =========================================================================
revoke all on public.finance_requests            from anon, public;
revoke all on public.finance_request_approvals   from anon, public;
revoke all on public.finance_request_attachments from anon, public;

revoke all on public.finance_requests            from authenticated;
revoke all on public.finance_request_approvals   from authenticated;
revoke all on public.finance_request_attachments from authenticated;

grant select, insert, update on public.finance_requests            to authenticated;
-- No INSERT: the trail is written by the transition function alone.
grant select                 on public.finance_request_approvals   to authenticated;
grant select, insert, delete on public.finance_request_attachments to authenticated;

grant all on public.finance_requests            to service_role;
grant all on public.finance_request_approvals   to service_role;
grant all on public.finance_request_attachments to service_role;

-- =========================================================================
-- budget_status — reserved and spent stop reading zero
-- =========================================================================
-- F2 shipped these as literals with a comment naming the phase that would
-- supply them. This is that phase. Both are derived from finance_requests
-- rather than stored, so they cannot drift, and double deduction is impossible:
-- at completion a request leaves `reserved` and enters `spent` in the same
-- instant, and `remaining` does not move.
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
  coalesce(r.spent, 0)::numeric(14,2)     as spent,
  (b.amount - coalesce(a.allocated, 0))::numeric(14,2) as unallocated,
  (b.amount - coalesce(r.spent, 0) - coalesce(r.reserved, 0))::numeric(14,2) as remaining,
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
  select
    sum(amount) filter (where status = 'pending_payment') as reserved,
    sum(amount) filter (where status = 'completed')       as spent
  from public.finance_requests fr
  where fr.budget_id = b.id
) r on true;

revoke all on public.budget_status from anon, public, authenticated;
grant select on public.budget_status to authenticated;
grant select on public.budget_status to service_role;
