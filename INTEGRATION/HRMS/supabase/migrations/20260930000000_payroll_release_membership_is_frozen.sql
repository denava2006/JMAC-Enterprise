-- F7 payroll, final release-integrity patch.
--
-- The previous migration closed the UPDATE paths into and out of released. Four
-- gaps remained, and three of them are the same oversight from different
-- angles: the guards were written about changing rows, and INSERT is not a
-- change.
--
--   01  require_complete_payroll_release() is a BEFORE UPDATE trigger, so a
--       period could simply be INSERTed with status = 'released'.
--   02  freeze_released_payroll_record() likewise guards UPDATE and DELETE, so
--       a new record could be added to an already-released period -- moving the
--       finalized HR source set out from under an immutable Finance snapshot.
--   03  the already-released branch of release_payroll_period() checked child
--       release state but not payslips, so a period missing one could be handed
--       back as a valid readback.
--   04  build_payroll_finance_batch() revalidated an existing batch by COUNTING
--       its items. Three records A,B,C against three items A,B,X counts equal
--       and is wrong.
--
-- The legitimate workflow was read before narrowing these. Periods are created
-- as 'draft' and only ever as 'draft'; records are generated as 'generated' and
-- only ever as 'generated'. So refusing an inserted 'released' costs nothing
-- real, and nothing broader is refused.

-- ===========================================================================
-- 01. A period cannot be born released
-- ===========================================================================
-- The existing invariant, extended to INSERT rather than duplicated into a
-- second rule. On INSERT there is no old row, so the completeness checks have
-- nothing to compare against and nothing to say: a period with no records
-- cannot be a finalized payroll, which is the same sentence the UPDATE path
-- already raises for an empty period.
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
  -- NEW. Creation. A period is created to be worked on, never already
  -- finalized -- payroll is finalized by releasing it, which is a transition
  -- and not a starting state.
  if tg_op = 'INSERT' then
    if new.status = 'released' then
      raise exception 'A payroll period cannot be created already released. Create it, generate it, have it approved, then release it.'
        using errcode = 'check_violation';
    end if;
    return new;
  end if;

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

  if _total = 0 then
    raise exception 'Payroll for % to % has no employee records, so there is nothing to release.',
      new.period_start, new.period_end using errcode = 'check_violation';
  end if;

  if _unreleased > 0 then
    raise exception 'Payroll for % to % still has % employee record(s) that are not released. Every record must be released before the period is.',
      new.period_start, new.period_end, _unreleased using errcode = 'check_violation';
  end if;

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

drop trigger if exists trg_payroll_release_is_complete on public.payroll_periods;
create trigger trg_payroll_release_is_complete
  before insert or update on public.payroll_periods
  for each row execute function public.require_complete_payroll_release();

-- ===========================================================================
-- 02. A released period's membership is closed
-- ===========================================================================
-- Finance holds a snapshot of exactly which employees were in this payroll.
-- Adding a record afterwards does not change that snapshot, it just makes the
-- HR source disagree with it -- one employee in the finalized run and not in
-- the batch that pays it.
create or replace function public.freeze_released_payroll_membership()
returns trigger
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  _period_status public.payroll_status;
begin
  select status into _period_status
  from public.payroll_periods where id = new.payroll_period_id;

  if _period_status = 'released' then
    raise exception 'Payroll for this period has been released and handed to Finance. No further employee record can be added to it.'
      using errcode = 'insufficient_privilege';
  end if;

  -- Generation creates records as 'generated' and never as anything else, so a
  -- record arriving already released did not come from the payroll run. It
  -- would also skip every approval the release path exists to require.
  if new.status = 'released' then
    raise exception 'A payroll record cannot be created already released. Payroll is released as a period, once every record in it is approved.'
      using errcode = 'check_violation';
  end if;

  return new;
end;
$fn$;

revoke all on function public.freeze_released_payroll_membership() from public, anon, authenticated;

-- INSERT only. The atomic release RPC updates existing approved records, and
-- freeze_released_payroll_record() already governs UPDATE and DELETE -- this
-- one must not get in the way of either.
drop trigger if exists trg_freeze_released_payroll_membership on public.payroll_records;
create trigger trg_freeze_released_payroll_membership
  before insert on public.payroll_records
  for each row execute function public.freeze_released_payroll_membership();

-- ===========================================================================
-- 04. An existing Finance batch is revalidated by membership, not by count
-- ===========================================================================
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
  _no_payslip integer;
  _items integer;
  _mismatch integer;
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

  if _total = 0 then
    raise exception 'Payroll for % to % has no employee records, so there is nothing for Finance to pay.',
      _period.period_start, _period.period_end using errcode = 'check_violation';
  end if;

  if _unreleased > 0 then
    raise exception 'Payroll for % to % has % employee record(s) that are not released. Finance cannot take a partial snapshot.',
      _period.period_start, _period.period_end, _unreleased using errcode = 'check_violation';
  end if;

  -- NEW. Kept alongside the release-side check rather than trusted from it:
  -- Finance pays what the employee has a payslip for.
  select count(*) into _no_payslip
  from public.payroll_records r
  where r.payroll_period_id = _period_id
    and not exists (select 1 from public.payslips p where p.payroll_record_id = r.id);

  if _no_payslip > 0 then
    raise exception 'Payroll for % to % has % employee record(s) with no payslip, so Finance cannot take a snapshot of it.',
      _period.period_start, _period.period_end, _no_payslip using errcode = 'check_violation';
  end if;

  select id into _batch_id from public.payroll_finance_batches
   where source_payroll_period_id = _period_id;

  if _batch_id is not null then
    -- NEW. This compared counts, and equal counts are not the same set:
    -- records A,B,C against items A,B,X counts three against three and is
    -- wrong in two directions at once. The comparison is symmetric, so a
    -- missing record, an extra one, and one belonging to another period are
    -- all the same failure.
    select
      (select count(*) from (
         select i.source_payroll_record_id as id
         from public.payroll_finance_items i where i.batch_id = _batch_id
         except
         select r.id from public.payroll_records r where r.payroll_period_id = _period_id
       ) extra)
      +
      (select count(*) from (
         select r.id from public.payroll_records r where r.payroll_period_id = _period_id
         except
         select i.source_payroll_record_id
         from public.payroll_finance_items i where i.batch_id = _batch_id
       ) missing)
      into _mismatch;

    select count(*) into _items from public.payroll_finance_items where batch_id = _batch_id;

    if _mismatch > 0 or _items <> _total then
      raise exception 'The Finance batch for payroll % to % does not match its source: % item(s) against % employee record(s), with % that do not correspond. It is inconsistent and cannot be used.',
        _period.period_start, _period.period_end, _items, _total, _mismatch
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
-- 03. A retry is a readback, and only of something valid
-- ===========================================================================
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
  _unreleased integer;
  _no_payslip integer;
  _batch_id uuid;
  _payslips integer;
begin
  if not public.is_hr_manager_or_admin() then
    raise exception 'Only an HR Manager can release payroll.'
      using errcode = 'insufficient_privilege';
  end if;

  select * into _period from public.payroll_periods where id = _period_id for update;
  if _period.id is null then
    raise exception 'That payroll period no longer exists.' using errcode = 'no_data_found';
  end if;

  select count(*),
         count(*) filter (where status not in ('approved', 'released')),
         count(*) filter (where status is distinct from 'released')
    into _total, _not_approved, _unreleased
  from public.payroll_records where payroll_period_id = _period_id;

  if _period.status = 'released' then
    -- A readback, not a repair. Every requirement of a released period is
    -- re-checked independently, and anything short of all of them is a period
    -- that needs looking at rather than releasing again. Nothing here issues a
    -- missing payslip: silently completing a half-finished release is how the
    -- inconsistency would stop being visible.
    if _total = 0 then
      raise exception 'Payroll for % to % is marked released but has no employee records. This needs looking at rather than releasing again.',
        _period.period_start, _period.period_end using errcode = 'check_violation';
    end if;

    if _unreleased > 0 then
      raise exception 'Payroll for % to % is marked released but % of % employee record(s) are not. This needs looking at rather than releasing again.',
        _period.period_start, _period.period_end, _unreleased, _total
        using errcode = 'check_violation';
    end if;

    -- NEW. The gap: the readback checked release state and never payslips.
    -- One payslip each, no more and no fewer -- the unique index takes care of
    -- "no more", so what is left to prove is that none is missing.
    select count(*) into _no_payslip
    from public.payroll_records r
    where r.payroll_period_id = _period_id
      and not exists (select 1 from public.payslips p where p.payroll_record_id = r.id);

    if _no_payslip > 0 then
      raise exception 'Payroll for % to % is marked released but % of % employee record(s) have no payslip. This needs looking at rather than releasing again.',
        _period.period_start, _period.period_end, _no_payslip, _total
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
