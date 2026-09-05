-- ===========================================================================
-- F7B  Paying a finalized payroll
-- ===========================================================================
--
-- The same lifecycle F6 proved, against a payroll batch instead of a supplier
-- invoice: prepare, approve, then record what actually happened. Approval
-- authorises and moves nothing.
--
-- BUDGET DECISION, stated because a silence here would be a choice too.
-- payroll_periods and payroll_records carry no budget_id, and nothing in the
-- HR payroll model names a budget. There is therefore no authoritative payroll
-- budget linkage to integrate, and inventing one would be fabricating
-- accounting. Payroll is budget-neutral in F7: it moves treasury and nothing
-- else. If HR later gains an explicit payroll budget source, that is the point
-- to connect it.

create table if not exists public.payroll_disbursements (
  id uuid primary key default gen_random_uuid(),
  disbursement_no text,

  batch_id uuid not null
    references public.payroll_finance_batches(id) on delete restrict,
  treasury_account_id uuid not null
    references public.treasury_accounts(id) on delete restrict,

  amount numeric(14,2) not null check (amount > 0),
  method text not null check (method in ('bank_transfer', 'cash', 'cheque', 'other')),

  payment_date date,
  reference text,
  notes text,

  status text not null default 'draft'
    check (status in ('draft', 'for_approval', 'approved', 'paid', 'returned', 'rejected')),

  prepared_by uuid references public.profiles(id) on delete set null,
  submitted_at timestamptz,
  approved_by uuid references public.profiles(id) on delete set null,
  approved_at timestamptz,
  paid_by uuid references public.profiles(id) on delete set null,
  paid_at timestamptz,
  decision_reason text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint payroll_disbursements_paid_has_evidence check (
    status <> 'paid' or (payment_date is not null and paid_at is not null)
  )
);

create index if not exists payroll_disbursements_batch_idx
  on public.payroll_disbursements (batch_id, status);
create index if not exists payroll_disbursements_status_idx
  on public.payroll_disbursements (status) where status in ('for_approval', 'approved');

create unique index if not exists payroll_disbursements_no_unique
  on public.payroll_disbursements (disbursement_no) where disbursement_no is not null;

create unique index if not exists payroll_disbursements_reference_unique
  on public.payroll_disbursements (treasury_account_id, upper(btrim(reference)))
  where reference is not null and btrim(reference) <> ''
    and status not in ('returned', 'rejected');

comment on table public.payroll_disbursements is
  'Payment of a finalized payroll batch. Only status = paid moves a treasury '
  'balance. Budget-neutral: HR payroll carries no budget linkage.';

create or replace function public.set_payroll_disbursement_no()
returns trigger language plpgsql set search_path = '' as $fn$
declare _year text := to_char(public.pos_business_date(), 'YYYY');
begin
  if new.disbursement_no is null then
    new.disbursement_no := 'PD-' || _year || '-' || lpad((
      select count(*) + 1 from public.payroll_disbursements
       where disbursement_no like 'PD-' || _year || '-%'
    )::text, 4, '0');
  end if;
  return new;
end;
$fn$;

drop trigger if exists trg_payroll_disbursement_no on public.payroll_disbursements;
create trigger trg_payroll_disbursement_no
  before insert on public.payroll_disbursements
  for each row execute function public.set_payroll_disbursement_no();

-- ---------------------------------------------------------------------------
-- What a batch still owes
-- ---------------------------------------------------------------------------
create or replace function public.payroll_batch_paid(_batch_id uuid)
returns numeric
language sql stable security definer set search_path = ''
as $fn$
  select coalesce(sum(d.amount), 0)::numeric(14,2)
  from public.payroll_disbursements d
  where d.batch_id = _batch_id and d.status = 'paid';
$fn$;

create or replace function public.payroll_batch_pending(_batch_id uuid)
returns numeric
language sql stable security definer set search_path = ''
as $fn$
  select coalesce(sum(d.amount), 0)::numeric(14,2)
  from public.payroll_disbursements d
  where d.batch_id = _batch_id
    and d.status in ('draft', 'for_approval', 'approved');
$fn$;

create or replace view public.payroll_finance_status
with (security_invoker = on) as
  select
    b.id,
    b.batch_no,
    b.source_payroll_period_id,
    b.period_start,
    b.period_end,
    b.pay_date,
    b.frequency,
    b.employee_count,
    b.gross_total,
    b.deductions_total,
    b.net_total,
    coalesce(public.payroll_batch_paid(b.id), 0)::numeric(14,2) as amount_paid,
    greatest(b.net_total - coalesce(public.payroll_batch_paid(b.id), 0), 0)::numeric(14,2)
      as balance_due,
    coalesce(public.payroll_batch_pending(b.id), 0)::numeric(14,2) as pending_disbursement,
    greatest(
      b.net_total
        - coalesce(public.payroll_batch_paid(b.id), 0)
        - coalesce(public.payroll_batch_pending(b.id), 0), 0
    )::numeric(14,2) as available_to_prepare,
    case
      when coalesce(public.payroll_batch_paid(b.id), 0) <= 0 then 'awaiting_disbursement'
      when coalesce(public.payroll_batch_paid(b.id), 0) < b.net_total then 'partially_paid'
      else 'paid'
    end as settlement_state,
    b.source_finalized_at,
    b.created_at
  from public.payroll_finance_batches b;

-- ---------------------------------------------------------------------------
-- Preparing, approving, recording
-- ---------------------------------------------------------------------------
create or replace function public.create_payroll_disbursement(
  _batch_id uuid,
  _treasury_account_id uuid,
  _amount numeric,
  _method text default 'bank_transfer',
  _notes text default null,
  _submit boolean default false
)
returns uuid
language plpgsql security definer set search_path = ''
as $fn$
declare
  _id uuid; _b public.payroll_finance_status%rowtype;
  _account public.treasury_accounts%rowtype; _available numeric(14,2); _locked uuid;
begin
  if not public.has_finance_privilege(array['accountant']) then
    raise exception 'Preparing a payroll disbursement is the Accountant''s work.'
      using errcode = 'insufficient_privilege';
  end if;

  -- The batch is locked before what is available is read, so two preparations
  -- cannot both see the whole net payable free.
  select id into _locked from public.payroll_finance_batches
   where id = _batch_id for update;
  if _locked is null then
    raise exception 'That payroll batch is not available.' using errcode = 'check_violation';
  end if;

  select * into _b from public.payroll_finance_status where id = _batch_id;

  select * into _account from public.treasury_accounts where id = _treasury_account_id;
  if _account.id is null or not _account.is_active then
    raise exception 'That account is not available.' using errcode = 'check_violation';
  end if;

  if coalesce(_amount, 0) <= 0 then
    raise exception 'A disbursement has to be for more than nothing.'
      using errcode = 'check_violation';
  end if;

  -- Partial disbursement is supported: a payroll may genuinely go out in more
  -- than one transfer. What is refused is the cumulative total exceeding the
  -- net payable.
  _available := _b.available_to_prepare;
  if _amount > _available then
    if _available <= 0 then
      raise exception
        'This payroll batch is already fully covered by disbursement instructions.'
        using errcode = 'check_violation';
    else
      raise exception
        'This payroll batch only has % still available to disburse.',
        to_char(_available, 'FM999,999,990.00') using errcode = 'check_violation';
    end if;
  end if;

  insert into public.payroll_disbursements (
    batch_id, treasury_account_id, amount, method, notes
  ) values (
    _batch_id, _treasury_account_id, _amount, coalesce(_method, 'bank_transfer'), _notes
  ) returning id into _id;

  if _submit then
    perform public.transition_payroll_disbursement(_id, 'for_approval', null, null, null);
  end if;

  return _id;
end;
$fn$;

create or replace function public.transition_payroll_disbursement(
  _disbursement_id uuid,
  _to_status text,
  _reason text default null,
  _reference text default null,
  _payment_date date default null
)
returns void
language plpgsql security definer set search_path = ''
as $fn$
declare
  _d public.payroll_disbursements%rowtype;
  _b public.payroll_finance_status%rowtype;
  _me uuid := (select auth.uid());
  _available numeric(14,2); _siblings numeric(14,2);
  _account public.treasury_accounts%rowtype; _locked uuid;
begin
  select * into _d from public.payroll_disbursements where id = _disbursement_id for update;
  if _d.id is null then
    raise exception 'That disbursement is not available.' using errcode = 'check_violation';
  end if;

  if _to_status in ('returned', 'rejected')
     and nullif(btrim(coalesce(_reason, '')), '') is null then
    raise exception 'Say why this disbursement is being %.',
      case _to_status when 'returned' then 'returned' else 'rejected' end
      using errcode = 'check_violation';
  end if;

  if _to_status = 'for_approval' then
    if not public.has_finance_privilege(array['accountant']) then
      raise exception 'Only the Accountant submits a disbursement for approval.'
        using errcode = 'insufficient_privilege';
    end if;
    if _d.status not in ('draft', 'returned') then
      raise exception 'Only a draft disbursement can be submitted.'
        using errcode = 'check_violation';
    end if;

    select id into _locked from public.payroll_finance_batches
     where id = _d.batch_id for update;
    select * into _b from public.payroll_finance_status where id = _d.batch_id;

    -- Excluding this one from its own sibling sum, or no resubmission could
    -- ever pass.
    select coalesce(sum(s.amount), 0)::numeric(14,2) into _siblings
    from public.payroll_disbursements s
    where s.batch_id = _d.batch_id and s.id <> _disbursement_id
      and s.status in ('draft', 'for_approval', 'approved');

    _available := greatest(_b.balance_due - _siblings, 0);
    if _d.amount > _available then
      if _available <= 0 then
        raise exception
          'This payroll batch no longer has a balance available for this disbursement.'
          using errcode = 'check_violation';
      else
        raise exception
          'This payroll batch only has % available, and this disbursement is for %.',
          to_char(_available, 'FM999,999,990.00'),
          to_char(_d.amount, 'FM999,999,990.00') using errcode = 'check_violation';
      end if;
    end if;

    update public.payroll_disbursements
       set status = 'for_approval', submitted_at = now(), decision_reason = null
     where id = _disbursement_id;

  elsif _to_status in ('approved', 'returned', 'rejected') then
    if not public.has_finance_privilege(array['finance_manager']) then
      raise exception 'Only the Finance Manager decides a disbursement.'
        using errcode = 'insufficient_privilege';
    end if;
    if _to_status = 'approved' and _d.status <> 'for_approval' then
      raise exception 'Only a disbursement awaiting approval can be approved.'
        using errcode = 'check_violation';
    end if;
    if _to_status in ('returned', 'rejected')
       and _d.status not in ('for_approval', 'approved') then
      raise exception 'Only a disbursement that has not been made can be %.', _to_status
        using errcode = 'check_violation';
    end if;
    if _d.prepared_by = _me then
      raise exception 'You prepared disbursement %, so another Finance user must approve it.',
        _d.disbursement_no using errcode = 'insufficient_privilege';
    end if;

    update public.payroll_disbursements
       set status = _to_status,
           approved_by = case when _to_status = 'approved' then _me else null end,
           approved_at = case when _to_status = 'approved' then now() else null end,
           decision_reason = nullif(btrim(coalesce(_reason, '')), '')
     where id = _disbursement_id;

  elsif _to_status = 'paid' then
    if not public.has_finance_privilege(array['accountant']) then
      raise exception 'The Accountant records a completed disbursement.'
        using errcode = 'insufficient_privilege';
    end if;
    if _d.status <> 'approved' then
      raise exception 'This disbursement has not been approved for payment yet.'
        using errcode = 'check_violation';
    end if;
    if nullif(btrim(coalesce(_reference, '')), '') is null then
      raise exception 'Record the payment reference from the bank or receipt.'
        using errcode = 'check_violation';
    end if;
    if _payment_date is null then
      raise exception 'Record the date this disbursement was made.'
        using errcode = 'check_violation';
    end if;

    select * into _b from public.payroll_finance_status where id = _d.batch_id;
    if _d.amount > _b.balance_due then
      raise exception 'Payroll batch % now has only % outstanding.',
        _b.batch_no, to_char(_b.balance_due, 'FM999,999,990.00')
        using errcode = 'check_violation';
    end if;

    select * into _account from public.treasury_accounts
     where id = _d.treasury_account_id for update;
    _available := public.treasury_account_balance(_d.treasury_account_id);
    if _d.amount > _available then
      raise exception 'This account does not have enough available funds for this payment.'
        using errcode = 'check_violation';
    end if;

    update public.payroll_disbursements
       set status = 'paid', paid_by = _me, paid_at = now(),
           payment_date = _payment_date, reference = btrim(_reference)
     where id = _disbursement_id;

    insert into public.treasury_movements (
      treasury_account_id, direction, amount, source_type, source_id,
      occurred_on, reference, created_by
    ) values (
      _d.treasury_account_id, 'out', _d.amount, 'payroll_disbursement', _disbursement_id,
      _payment_date, btrim(_reference), _me
    );

  else
    raise exception 'A disbursement cannot move to %.', _to_status
      using errcode = 'check_violation';
  end if;

  insert into public.audit_logs (actor_id, action, table_name, record_id, old_data, new_data)
  values (
    _me, 'Payroll disbursement ' || _to_status, 'payroll_disbursements', _disbursement_id,
    jsonb_build_object('status', _d.status),
    jsonb_build_object(
      'status', _to_status, 'disbursement_no', _d.disbursement_no,
      'batch_id', _d.batch_id, 'amount', _d.amount,
      'treasury_account_id', _d.treasury_account_id,
      'reference', nullif(btrim(coalesce(_reference, '')), ''),
      'payment_date', _payment_date,
      'reason', nullif(btrim(coalesce(_reason, '')), ''))
  );
end;
$fn$;

-- ---------------------------------------------------------------------------
-- Guards and access
-- ---------------------------------------------------------------------------
create or replace function public.guard_payroll_disbursement_edit()
returns trigger language plpgsql set search_path = '' as $fn$
begin
  if tg_op = 'DELETE' then
    if old.status = 'paid' then
      raise exception 'A completed payroll disbursement is a permanent record and cannot be deleted.'
        using errcode = 'insufficient_privilege';
    end if;
    return old;
  end if;

  if tg_op = 'INSERT' then
    new.status := 'draft';
    new.prepared_by := coalesce(new.prepared_by, (select auth.uid()));
    new.approved_by := null; new.approved_at := null;
    new.paid_by := null; new.paid_at := null; new.submitted_at := null;
    return new;
  end if;

  if old.status = 'paid' then
    raise exception 'A completed payroll disbursement is a permanent record and cannot be changed.'
      using errcode = 'insufficient_privilege';
  end if;

  if (new.amount is distinct from old.amount
      or new.treasury_account_id is distinct from old.treasury_account_id
      or new.batch_id is distinct from old.batch_id
      or new.method is distinct from old.method
      or new.notes is distinct from old.notes)
  then
    if not public.has_finance_privilege(array['accountant']) then
      raise exception 'Only the Accountant who prepares a disbursement may change its details.'
        using errcode = 'insufficient_privilege';
    end if;
    if old.status not in ('draft', 'returned') then
      raise exception 'This disbursement is no longer a draft. Ask for it back before editing.'
        using errcode = 'check_violation';
    end if;
  end if;

  new.updated_at := now();
  return new;
end;
$fn$;

drop trigger if exists trg_payroll_disbursement_edit on public.payroll_disbursements;
create trigger trg_payroll_disbursement_edit
  before insert or update or delete on public.payroll_disbursements
  for each row execute function public.guard_payroll_disbursement_edit();

alter table public.payroll_disbursements enable row level security;

drop policy if exists payroll_disbursements_read on public.payroll_disbursements;
create policy payroll_disbursements_read on public.payroll_disbursements
  for select to authenticated using (public.can_read_finance_master());

drop policy if exists payroll_disbursements_write on public.payroll_disbursements;
create policy payroll_disbursements_write on public.payroll_disbursements
  for insert to authenticated
  with check (public.has_finance_privilege(array['accountant']));

drop policy if exists payroll_disbursements_update on public.payroll_disbursements;
create policy payroll_disbursements_update on public.payroll_disbursements
  for update to authenticated
  using (public.has_finance_privilege(array['accountant', 'finance_manager']))
  with check (public.has_finance_privilege(array['accountant', 'finance_manager']));

-- ---------------------------------------------------------------------------
-- Reading
-- ---------------------------------------------------------------------------
create or replace function public.get_payroll_finance_batches()
returns setof public.payroll_finance_status
language sql stable security definer set search_path = ''
as $fn$
  select * from public.payroll_finance_status
  where public.can_read_finance_master()
  order by period_end desc, batch_no desc;
$fn$;

-- Salary lines, for the two roles that execute the payment. Finance Staff
-- review reimbursements; that is not a reason to hand them every salary.
create or replace function public.get_payroll_finance_items(_batch_id uuid)
returns table (
  id uuid,
  employee_id uuid,
  employee_name text,
  gross_amount numeric,
  deductions_amount numeric,
  net_amount numeric
)
language sql stable security definer set search_path = ''
as $fn$
  select i.id, i.employee_id, i.employee_name,
         i.gross_amount, i.deductions_amount, i.net_amount
  from public.payroll_finance_items i
  where i.batch_id = _batch_id
    and (public.is_active_staff()
         or public.has_finance_privilege(array['accountant', 'finance_manager']))
  order by i.employee_name;
$fn$;

create or replace function public.get_payroll_disbursements(_batch_id uuid default null)
returns table (
  id uuid, disbursement_no text, batch_id uuid, batch_no text,
  treasury_account_id uuid, account_name text, amount numeric, method text,
  payment_date date, reference text, notes text, status text,
  prepared_by uuid, prepared_by_name text, submitted_at timestamptz,
  approved_by uuid, approved_by_name text, approved_at timestamptz,
  paid_by uuid, paid_by_name text, paid_at timestamptz,
  decision_reason text, created_at timestamptz
)
language sql stable security definer set search_path = ''
as $fn$
  select d.id, d.disbursement_no, d.batch_id, b.batch_no,
         d.treasury_account_id, ta.name, d.amount, d.method,
         d.payment_date, d.reference, d.notes, d.status,
         d.prepared_by, pp.full_name, d.submitted_at,
         d.approved_by, ap.full_name, d.approved_at,
         d.paid_by, yp.full_name, d.paid_at,
         d.decision_reason, d.created_at
  from public.payroll_disbursements d
  join public.payroll_finance_batches b on b.id = d.batch_id
  left join public.treasury_accounts ta on ta.id = d.treasury_account_id
  left join public.profiles pp on pp.id = d.prepared_by
  left join public.profiles ap on ap.id = d.approved_by
  left join public.profiles yp on yp.id = d.paid_by
  where public.can_read_finance_master()
    and (_batch_id is null or d.batch_id = _batch_id)
  order by d.created_at desc;
$fn$;

revoke all on function public.create_payroll_disbursement(uuid, uuid, numeric, text, text, boolean) from public, anon;
revoke all on function public.transition_payroll_disbursement(uuid, text, text, text, date) from public, anon;
revoke all on function public.get_payroll_finance_batches() from public, anon;
revoke all on function public.get_payroll_finance_items(uuid) from public, anon;
revoke all on function public.get_payroll_disbursements(uuid) from public, anon;
revoke all on function public.build_payroll_finance_batch(uuid) from public, anon, authenticated;
revoke all on function public.payroll_batch_paid(uuid) from public, anon;
revoke all on function public.payroll_batch_pending(uuid) from public, anon;

grant execute on function public.create_payroll_disbursement(uuid, uuid, numeric, text, text, boolean) to authenticated;
grant execute on function public.transition_payroll_disbursement(uuid, text, text, text, date) to authenticated;
grant execute on function public.get_payroll_finance_batches() to authenticated;
grant execute on function public.get_payroll_finance_items(uuid) to authenticated;
grant execute on function public.get_payroll_disbursements(uuid) to authenticated;
grant execute on function public.payroll_batch_paid(uuid) to authenticated;
grant execute on function public.payroll_batch_pending(uuid) to authenticated;
