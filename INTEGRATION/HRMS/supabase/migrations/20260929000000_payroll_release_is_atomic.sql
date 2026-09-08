-- F7 payroll preflight: release completeness, released-data immutability, and
-- one atomic release.
--
-- Three blockers, one root shape between them: HR release was assembled in the
-- browser out of steps the database did not connect, and the database was
-- willing to accept each step on its own.
--
--   01  protect_payroll_approval() asks WHO is releasing and never WHETHER the
--       period is complete. recompute_payroll_period_status() sets a period to
--       released when every child is released, but it is a convenience, not a
--       rule -- a direct UPDATE puts a period into released with children still
--       unreleased, and build_payroll_finance_batch() then snapshots whichever
--       subset happens to be released. unique(source_payroll_period_id) makes
--       that partial snapshot permanent.
--
--   02  protect_payroll_amounts() returns early for is_hr_staff_or_admin(), so
--       HR can rewrite the figures on an already-released record. Finance holds
--       an immutable copy of what those figures were, so the two silently
--       diverge and the copy is the one that gets paid.
--
--   03  useReleasePayroll() inserted payslips one HTTP request at a time,
--       DISCARDED each insert's error, then released the records anyway. With
--       no unique index on payslips.payroll_record_id a retry duplicated
--       payslips, and a failure released payroll with payslips missing.
--
-- What follows makes the invariants true in the database, and gives the client
-- one call that either does all of it or none of it.
--
-- Production payroll is empty (0 periods, 0 records, 0 payslips, 0 batches), so
-- nothing here backfills or repairs anything. It is all forward rules.

-- ===========================================================================
-- 1. One payslip per payroll record
-- ===========================================================================
-- A plain unique index rather than a constraint so it can be created
-- concurrently later if this table ever grows; at present both are empty. If
-- duplicates ever exist this migration fails loudly, which is correct -- a
-- duplicated payslip is a question for a person, not something to deduplicate
-- automatically.
create unique index if not exists payslips_one_per_payroll_record
  on public.payslips (payroll_record_id);

comment on index public.payslips_one_per_payroll_record is
  'One payroll record, one payslip. Makes release retryable: a second attempt '
  'conflicts instead of issuing the employee a second payslip.';

-- ===========================================================================
-- 2. A period cannot enter released while any child is not
-- ===========================================================================
-- Deliberately not exempt from the null-auth.uid() escape the authority guards
-- use. Those rules are about who may act; this one is about whether the row is
-- coherent, and a service-role or migration write producing an incomplete
-- released period is exactly the case the preflight raised.
create or replace function public.require_complete_payroll_release()
returns trigger
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  _total     integer;
  _unreleased integer;
  _no_payslip integer;
begin
  -- Not becoming released. The only thing to say here is that a period which
  -- already is cannot stop being one.
  if new.status is distinct from 'released'::public.payroll_status then
    if old.status = 'released' then
      raise exception 'Payroll for % to % has been released and handed to Finance; its status cannot be changed.',
        old.period_start, old.period_end using errcode = 'insufficient_privilege';
    end if;
    return new;
  end if;

  -- Already released and staying that way. recompute_payroll_period_status
  -- rewrites the row on every child change, so re-running the checks here
  -- would re-litigate a decision that has already been made and snapshotted.
  if old.status is not distinct from 'released'::public.payroll_status then
    return new;
  end if;

  -- Entering released. Everything below is what that has to mean.

  select count(*), count(*) filter (where status is distinct from 'released')
    into _total, _unreleased
  from public.payroll_records where payroll_period_id = new.id;

  -- An empty period is not a finalized payroll, it is an empty period. Finance
  -- would receive a batch describing nobody.
  if _total = 0 then
    raise exception 'Payroll for % to % has no employee records, so there is nothing to release.',
      new.period_start, new.period_end using errcode = 'check_violation';
  end if;

  if _unreleased > 0 then
    raise exception 'Payroll for % to % still has % employee record(s) that are not released. Every record must be released before the period is.',
      new.period_start, new.period_end, _unreleased using errcode = 'check_violation';
  end if;

  -- Release means the employee has a payslip. Finance takes its snapshot off
  -- the back of this transition, so a period reaching released with a payslip
  -- missing is the partial state 03 is about, arriving through a different door.
  select count(*) into _no_payslip
  from public.payroll_records r
  where r.payroll_period_id = new.id
    and not exists (select 1 from public.payslips p where p.payroll_record_id = r.id);

  if _no_payslip > 0 then
    raise exception 'Payroll for % to % has % employee record(s) with no payslip. Release issues the payslips and the payroll together.',
      new.period_start, new.period_end, _no_payslip using errcode = 'check_violation';
  end if;

  return new;
end;
$fn$;

revoke all on function public.require_complete_payroll_release() from public, anon, authenticated;

-- Alphabetically before trg_payroll_handoff, and BEFORE rather than AFTER, so
-- an incomplete period is refused before Finance is ever asked to snapshot it.
drop trigger if exists trg_payroll_release_is_complete on public.payroll_periods;
create trigger trg_payroll_release_is_complete
  before update on public.payroll_periods
  for each row execute function public.require_complete_payroll_release();

-- ===========================================================================
-- 3. Released payroll is immutable
-- ===========================================================================
-- The boundary is financial figures and identity, not the whole row. Fields
-- that are legitimately still in motion after release stay in motion:
-- payslips.file_url is filled in when a document is rendered, and notes is an
-- annotation nobody pays. Everything that decides what an employee is owed, or
-- which employee and which period it belongs to, freezes.
create or replace function public.freeze_released_payroll_record()
returns trigger
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  _period_status public.payroll_status;
begin
  if tg_op = 'DELETE' then
    select status into _period_status from public.payroll_periods where id = old.payroll_period_id;
    if old.status = 'released' or _period_status = 'released' then
      raise exception 'A released payroll record cannot be deleted. Finance holds a snapshot of it.'
        using errcode = 'insufficient_privilege';
    end if;
    return old;
  end if;

  -- Parent defence: a child that is somehow not released inside a period that
  -- is released is still finalized payroll, and is still what Finance copied.
  select status into _period_status from public.payroll_periods where id = old.payroll_period_id;
  if old.status is distinct from 'released' and _period_status is distinct from 'released' then
    return new;
  end if;

  -- Entering released is the one transition that is allowed to happen to a row
  -- that is not yet released.
  if old.status is distinct from 'released' and new.status = 'released' then
    return new;
  end if;

  if new.status is distinct from old.status then
    raise exception 'Payroll record % has been released; its status cannot change.', old.id
      using errcode = 'insufficient_privilege';
  end if;

  -- Everything except the annotation and the row's own bookkeeping timestamp.
  if to_jsonb(new) - 'notes' - 'updated_at'
     is distinct from
     to_jsonb(old) - 'notes' - 'updated_at'
  then
    raise exception 'Payroll record % has been released and handed to Finance. Its figures are what Finance is paying, so they can no longer be changed.',
      old.id using errcode = 'insufficient_privilege';
  end if;

  return new;
end;
$fn$;

revoke all on function public.freeze_released_payroll_record() from public, anon, authenticated;

-- Named to sort before trg_protect_payroll_amounts, which exempts HR staff and
-- would otherwise wave these through.
drop trigger if exists trg_freeze_released_payroll_record on public.payroll_records;
create trigger trg_freeze_released_payroll_record
  before update or delete on public.payroll_records
  for each row execute function public.freeze_released_payroll_record();

-- ---------------------------------------------------------------------------
-- The lines behind the figures
-- ---------------------------------------------------------------------------
-- total_allowances and the deduction columns are sums of these. Freezing the
-- record and leaving its lines writable would let the detail contradict the
-- total Finance is paying.
create or replace function public.freeze_released_payroll_lines()
returns trigger
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  _record_id uuid := coalesce(new.payroll_record_id, old.payroll_record_id);
  _released boolean;
begin
  select r.status = 'released' or p.status = 'released'
    into _released
  from public.payroll_records r
  join public.payroll_periods p on p.id = r.payroll_period_id
  where r.id = _record_id;

  if coalesce(_released, false) then
    raise exception 'Payroll record % has been released; its allowance and deduction lines can no longer be added to, changed or removed.',
      _record_id using errcode = 'insufficient_privilege';
  end if;

  return case when tg_op = 'DELETE' then old else new end;
end;
$fn$;

revoke all on function public.freeze_released_payroll_lines() from public, anon, authenticated;

drop trigger if exists trg_freeze_released_payroll_lines on public.payroll_line_items;
create trigger trg_freeze_released_payroll_lines
  before insert or update or delete on public.payroll_line_items
  for each row execute function public.freeze_released_payroll_lines();

-- ---------------------------------------------------------------------------
-- The payslip itself
-- ---------------------------------------------------------------------------
create or replace function public.freeze_released_payslip()
returns trigger
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  _released boolean;
begin
  select r.status = 'released' or p.status = 'released'
    into _released
  from public.payroll_records r
  join public.payroll_periods p on p.id = r.payroll_period_id
  where r.id = coalesce(new.payroll_record_id, old.payroll_record_id);

  if not coalesce(_released, false) then
    return case when tg_op = 'DELETE' then old else new end;
  end if;

  if tg_op = 'DELETE' then
    raise exception 'A released payslip cannot be deleted.' using errcode = 'insufficient_privilege';
  end if;

  -- file_url is the document, and it is written when one is rendered -- after
  -- release, legitimately. Which record it belongs to and when it was released
  -- are the facts, and they are fixed.
  if to_jsonb(new) - 'file_url' is distinct from to_jsonb(old) - 'file_url' then
    raise exception 'A released payslip cannot be changed. Only its document link may still be filled in.'
      using errcode = 'insufficient_privilege';
  end if;

  return new;
end;
$fn$;

revoke all on function public.freeze_released_payslip() from public, anon, authenticated;

drop trigger if exists trg_freeze_released_payslip on public.payslips;
create trigger trg_freeze_released_payslip
  before update or delete on public.payslips
  for each row execute function public.freeze_released_payslip();

-- ---------------------------------------------------------------------------
-- The period's own dates
-- ---------------------------------------------------------------------------
create or replace function public.freeze_released_payroll_period()
returns trigger
language plpgsql
security definer
set search_path = ''
as $fn$
begin
  if tg_op = 'DELETE' then
    if old.status = 'released' then
      raise exception 'A released payroll period cannot be deleted. Finance holds a snapshot of it.'
        using errcode = 'insufficient_privilege';
    end if;
    return old;
  end if;

  if old.status is distinct from 'released' then
    return new;
  end if;

  -- The batch Finance snapshotted carries these dates. Changing them here would
  -- leave the snapshot describing a period that no longer exists.
  if new.period_start is distinct from old.period_start
     or new.period_end is distinct from old.period_end
     or new.pay_date is distinct from old.pay_date
     or new.frequency is distinct from old.frequency then
    raise exception 'Payroll for % to % has been released and handed to Finance; its dates are fixed.',
      old.period_start, old.period_end using errcode = 'insufficient_privilege';
  end if;

  return new;
end;
$fn$;

revoke all on function public.freeze_released_payroll_period() from public, anon, authenticated;

drop trigger if exists trg_freeze_released_payroll_period on public.payroll_periods;
create trigger trg_freeze_released_payroll_period
  before update or delete on public.payroll_periods
  for each row execute function public.freeze_released_payroll_period();

-- ===========================================================================
-- 4. The Finance builder refuses an incomplete source
-- ===========================================================================
-- Unchanged in what it copies and in how it is idempotent. What is new is that
-- it will not snapshot a subset: it counts the period's records rather than the
-- released ones, and it re-checks a batch it finds on retry instead of handing
-- back whatever is there.
create or replace function public.build_payroll_finance_batch(_period_id uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  _period public.payroll_periods%rowtype;
  _batch_id uuid;
  _total integer;
  _unreleased integer;
  _items integer;
begin
  select * into _period from public.payroll_periods where id = _period_id;
  if _period.id is null then
    return null;
  end if;

  if _period.status <> 'released' then
    return null;
  end if;

  select count(*), count(*) filter (where status is distinct from 'released')
    into _total, _unreleased
  from public.payroll_records where payroll_period_id = _period_id;

  -- NEW. Previously this counted only the released records and refused only
  -- when there were none, so a period with two of five released produced a
  -- batch of two -- permanently, because of the unique source period.
  if _total = 0 then
    raise exception 'Payroll for % to % has no employee records, so there is nothing for Finance to pay.',
      _period.period_start, _period.period_end using errcode = 'check_violation';
  end if;

  if _unreleased > 0 then
    raise exception 'Payroll for % to % has % employee record(s) that are not released. Finance cannot take a partial snapshot.',
      _period.period_start, _period.period_end, _unreleased using errcode = 'check_violation';
  end if;

  select id into _batch_id from public.payroll_finance_batches
   where source_payroll_period_id = _period_id;

  if _batch_id is not null then
    -- A retry. Hand back the same batch, but only after checking it still
    -- describes the whole period: silently accepting a short batch is how the
    -- partial snapshot would have become permanent.
    select count(*) into _items from public.payroll_finance_items where batch_id = _batch_id;
    if _items <> _total then
      raise exception 'The Finance batch for payroll % to % covers % of % employee records. It is incomplete and cannot be used.',
        _period.period_start, _period.period_end, _items, _total
        using errcode = 'check_violation';
    end if;
    return _batch_id;
  end if;

  insert into public.payroll_finance_batches (
    source_payroll_period_id, period_start, period_end, pay_date, frequency,
    employee_count, gross_total, deductions_total, net_total, source_finalized_at
  )
  select
    _period_id, _period.period_start, _period.period_end, _period.pay_date,
    _period.frequency,
    count(*)::integer,
    coalesce(sum(r.gross_salary), 0),
    coalesce(sum(r.total_deductions), 0),
    coalesce(sum(r.net_salary), 0),
    max(coalesce(r.released_at, now()))
  from public.payroll_records r
  where r.payroll_period_id = _period_id and r.status = 'released'
  returning id into _batch_id;

  insert into public.payroll_finance_items (
    batch_id, source_payroll_record_id, employee_id, employee_name,
    gross_amount, deductions_amount, net_amount
  )
  select
    _batch_id, r.id, r.employee_id,
    nullif(trim(coalesce(e.first_name, '') || ' ' || coalesce(e.last_name, '')), ''),
    r.gross_salary, r.total_deductions, r.net_salary
  from public.payroll_records r
  join public.employees e on e.id = r.employee_id
  where r.payroll_period_id = _period_id and r.status = 'released';

  -- What went in must be every record the period has.
  select count(*) into _items from public.payroll_finance_items where batch_id = _batch_id;
  if _items <> _total then
    raise exception 'Finance snapshot for payroll % to % copied % of % employee records.',
      _period.period_start, _period.period_end, _items, _total
      using errcode = 'check_violation';
  end if;

  return _batch_id;
end;
$fn$;

revoke all on function public.build_payroll_finance_batch(uuid) from public, anon, authenticated;

-- ===========================================================================
-- 5. One release, one transaction
-- ===========================================================================
-- Everything the browser used to do across four unrelated requests, done once
-- where a failure at any point undoes the rest.
--
-- Authority is unchanged and deliberately re-stated rather than widened: the
-- same is_hr_manager_or_admin() that protect_payroll_approval has always
-- required to move a record into released.
create or replace function public.release_payroll_period(_period_id uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  _period public.payroll_periods%rowtype;
  _total integer;
  _not_approved integer;
  _batch_id uuid;
  _payslips integer;
begin
  if not public.is_hr_manager_or_admin() then
    raise exception 'Only an HR Manager can release payroll.'
      using errcode = 'insufficient_privilege';
  end if;

  -- Locked before anything is read, so two people pressing Release resolve in
  -- order rather than both reading "approved" and both proceeding.
  select * into _period from public.payroll_periods where id = _period_id for update;
  if _period.id is null then
    raise exception 'That payroll period no longer exists.' using errcode = 'no_data_found';
  end if;

  select count(*), count(*) filter (where status not in ('approved', 'released'))
    into _total, _not_approved
  from public.payroll_records where payroll_period_id = _period_id;

  -- Already done. Re-check the invariants and hand back the same batch rather
  -- than repeating the work: a retry after a lost response must be a readback,
  -- not a second release.
  if _period.status = 'released' then
    if _total = 0 or _not_approved > 0 then
      raise exception 'Payroll for % to % is marked released but % of % employee record(s) are not. This needs looking at rather than releasing again.',
        _period.period_start, _period.period_end, _not_approved, _total
        using errcode = 'check_violation';
    end if;
    return public.build_payroll_finance_batch(_period_id);
  end if;

  if _period.status <> 'approved' then
    raise exception 'Payroll for % to % is %, so it is not ready to release. Every employee must be approved first.',
      _period.period_start, _period.period_end, _period.status
      using errcode = 'check_violation';
  end if;

  if _total = 0 then
    raise exception 'Payroll for % to % has no employee records, so there is nothing to release.',
      _period.period_start, _period.period_end using errcode = 'check_violation';
  end if;

  if _not_approved > 0 then
    raise exception 'Payroll for % to % has % employee record(s) that are not approved yet.',
      _period.period_start, _period.period_end, _not_approved
      using errcode = 'check_violation';
  end if;

  -- One payslip each. on conflict makes a retry that got this far harmless:
  -- the unique index decides, so nobody is issued a second payslip.
  insert into public.payslips (payroll_record_id, released_at)
  select r.id, now()
  from public.payroll_records r
  where r.payroll_period_id = _period_id
  on conflict (payroll_record_id) do nothing;

  select count(*) into _payslips
  from public.payslips p
  join public.payroll_records r on r.id = p.payroll_record_id
  where r.payroll_period_id = _period_id;

  if _payslips <> _total then
    raise exception 'Payroll for % to % produced % payslips for % employee records.',
      _period.period_start, _period.period_end, _payslips, _total
      using errcode = 'check_violation';
  end if;

  -- Releasing the records is what moves the period, through the existing
  -- sync trigger, which is what calls Finance. One cause, not three writes
  -- hoping to agree.
  update public.payroll_records
     set status = 'released', released_at = now()
   where payroll_period_id = _period_id and status = 'approved';

  select status into _period.status from public.payroll_periods where id = _period_id;
  if _period.status <> 'released' then
    raise exception 'Payroll for % to % did not reach released after every record was released.',
      _period.period_start, _period.period_end using errcode = 'check_violation';
  end if;

  _batch_id := public.build_payroll_finance_batch(_period_id);
  if _batch_id is null then
    raise exception 'Payroll for % to % was released but Finance did not receive it.',
      _period.period_start, _period.period_end using errcode = 'check_violation';
  end if;

  insert into public.audit_logs (actor_id, action, table_name, record_id, new_data)
  values ((select auth.uid()), 'Payroll Released', 'payroll_periods', _period_id,
          jsonb_build_object('records', _total, 'payslips', _payslips, 'finance_batch', _batch_id));

  return _batch_id;
end;
$fn$;

revoke all on function public.release_payroll_period(uuid) from public, anon;
grant execute on function public.release_payroll_period(uuid) to authenticated;

comment on function public.release_payroll_period(uuid) is
  'Release one payroll period: issue every payslip, release every record, let '
  'the period follow and Finance snapshot it -- all or nothing. Retrying an '
  'already-released period returns its existing Finance batch.';
