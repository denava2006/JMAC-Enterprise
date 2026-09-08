-- F7 payroll preflight: the three integrity blockers, and the guards for them.
--
-- Preflight found HR release assembled in the browser out of steps the database
-- did not connect:
--
--   01  a period could be put into released with children still unreleased, and
--       the Finance builder would then snapshot whichever subset happened to be
--       released -- permanently, because of unique(source_payroll_period_id)
--   02  protect_payroll_amounts() exempts HR staff, so released figures stayed
--       editable while Finance held an immutable copy of the old ones
--   03  payslips were inserted one request at a time with their errors
--       discarded, then records released regardless, with no uniqueness on
--       payslips.payroll_record_id to make a retry safe
--
-- Every check below has a negative control: the guard is proved by watching the
-- thing it forbids be refused, and the thing it permits succeed.
--
-- Run:
--   docker exec -i supabase_db_harmony-suite psql -U postgres -d postgres \
--     -v ON_ERROR_STOP=1 -f - < supabase/tests/payroll_release_integrity_rls.sql
--
-- One transaction, rolled back at the end. Nothing is written.

begin;

create or replace function pg_temp.acts_as(_uid uuid) returns void
language sql as $$
  select set_config('request.jwt.claims',
    json_build_object('sub', _uid, 'role', 'authenticated')::text, true);
$$;

create or replace function pg_temp.hire(_name text, _position text)
returns uuid
language plpgsql as $$
declare
  _emp uuid; _uid uuid; _pos uuid; _dept uuid; _admin uuid;
  _tag text := left(replace(gen_random_uuid()::text, '-', ''), 8);
begin
  select id into _admin from public.profiles where role='admin' and status='active' limit 1;
  perform set_config('request.jwt.claims',
    json_build_object('sub', _admin, 'role', 'authenticated')::text, true);

  select p.id, p.department_id into _pos, _dept
  from public.positions p where lower(p.title) = lower(_position) limit 1;
  if _pos is null then raise exception 'fixture: no position %', _position; end if;

  insert into public.employees (first_name, last_name, email, department_id, position_id,
                                hire_date, employment_status)
  values ('ZZ', _name || ' ' || _tag, 'zz.' || _tag || '@jmac-test.invalid',
          _dept, _pos, current_date, 'active')
  returning id into _emp;

  insert into auth.users (instance_id, id, aud, role, email, encrypted_password,
                          email_confirmed_at, raw_app_meta_data, raw_user_meta_data,
                          created_at, updated_at, confirmation_token, email_change,
                          email_change_token_new, recovery_token)
  values ('00000000-0000-0000-0000-000000000000', gen_random_uuid(), 'authenticated',
          'authenticated', 'zz.' || _tag || '@jmac-test.invalid',
          crypt('x', gen_salt('bf')), now(),
          '{"provider":"email","providers":["email"]}', '{}', now(), now(), '', '', '', '')
  returning id into _uid;

  update public.profiles set employee_id = _emp, status = 'active' where id = _uid;
  return _uid;
end;
$$;

/** A payroll period with N employee records, all sitting at 'approved' --
 *  the legitimate pre-release state. */
create or replace function pg_temp.approved_period(_employees uuid[], _hr_staff uuid, _hr_manager uuid, _month_offset integer)
returns uuid
language plpgsql as $$
declare _period uuid; _emp uuid; _employee_row uuid;
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub', _hr_staff, 'role', 'authenticated')::text, true);
  set local role authenticated;

  -- payroll_periods is unique on (period_start, period_end), so each fixture
  -- period takes a month of its own.
  insert into public.payroll_periods (period_start, period_end, pay_date, frequency, status)
  values ((date_trunc('month', current_date) - make_interval(months => _month_offset))::date,
          (date_trunc('month', current_date) - make_interval(months => _month_offset)
             + interval '1 month - 1 day')::date,
          current_date, 'monthly', 'draft')
  returning id into _period;

  foreach _emp in array _employees loop
    select employee_id into _employee_row from public.profiles where id = _emp;
    insert into public.payroll_records
      (payroll_period_id, employee_id, basic_salary, total_allowances, gross_salary,
       total_deductions, net_salary, status)
    values (_period, _employee_row, 20000, 1000, 21000, 1000, 20000, 'generated');
  end loop;
  reset role;

  -- Approval is the HR Manager's -- protect_payroll_approval says so, and this
  -- fixture is about what happens after approval rather than about approval.
  perform set_config('request.jwt.claims',
    json_build_object('sub', _hr_manager, 'role', 'authenticated')::text, true);
  set local role authenticated;
  update public.payroll_records set status = 'approved'
   where payroll_period_id = _period;
  reset role;
  return _period;
end;
$$;

do $$
declare
  admin_id uuid; hr_staff uuid; hr_mgr uuid; hr_mgr2 uuid;
  emp_a uuid; emp_b uuid; outsider uuid; fin_staff uuid; accountant uuid;
  period uuid; period_b uuid; period_c uuid;
  rec_a uuid; rec_b uuid; batch uuid; batch2 uuid;
  n integer; txt text; num numeric; ok boolean;
  movements_before integer; movements_after integer;
  reserved_before numeric; spent_before numeric;
  reserved_after numeric; spent_after numeric;
  tag text := left(replace(gen_random_uuid()::text, '-', ''), 8);
begin
  select id into admin_id from public.profiles where role='admin' and status='active' limit 1;

  hr_staff   := pg_temp.hire('HR Staff',    'HR Staff');
  hr_mgr     := pg_temp.hire('HR Manager',  'HR Manager');
  hr_mgr2    := pg_temp.hire('HR Manager2', 'HR Manager');
  emp_a      := pg_temp.hire('Worker A',    'Cashier');
  emp_b      := pg_temp.hire('Worker B',    'Cashier');
  outsider   := pg_temp.hire('Outsider',    'Cashier');
  fin_staff  := pg_temp.hire('Fin Staff',   'Finance Staff');
  accountant := pg_temp.hire('Bookkeeper',  'Accountant');

  select count(*)::integer into movements_before from public.treasury_movements;

  -- ======================================================================
  -- A. An incomplete period cannot be put into released
  -- ======================================================================
  period := pg_temp.approved_period(array[emp_a, emp_b], hr_staff, hr_mgr, 0);
  select count(*)::integer into n from public.payroll_records where payroll_period_id = period;
  if n <> 2 then raise exception 'FAIL fixture: % records, expected 2', n; end if;

  -- One released, one not: exactly the partial state preflight described. Done
  -- by somebody who genuinely may release payroll, going round the RPC rather
  -- than through it -- which is the bypass the invariant has to survive.
  perform pg_temp.acts_as(hr_mgr); set local role authenticated;
  update public.payroll_records set status = 'released', released_at = now()
   where id = (select id from public.payroll_records where payroll_period_id = period limit 1);
  reset role;

  select status into txt from public.payroll_periods where id = period;
  if txt = 'released' then
    raise exception 'FAIL A the period became released with one record outstanding';
  end if;

  -- The message is asserted, not just the failure. Both guards refuse this
  -- statement -- the period guard on the way in and the Finance builder on the
  -- way out through the handoff -- so a test that only checks "it raised"
  -- passes with either one removed and proves neither.
  begin
    update public.payroll_periods set status = 'released' where id = period;
    raise exception 'FAIL A an incomplete period was forced into released';
  exception when check_violation then
    if sqlerrm not like '%Every record must be released before the period is%' then
      raise exception 'FAIL A refused, but not by the period guard: %', sqlerrm;
    end if;
    raise notice 'PASS  A an incomplete period cannot be forced into released';
  end;

  -- ======================================================================
  -- B. The Finance builder refuses the same incomplete source
  -- ======================================================================
  -- Defence in depth, and it has to be constructed deliberately: with the
  -- period guard in place the partial released state can no longer be reached
  -- through an UPDATE at all. Disabling that trigger for a moment is the only
  -- honest way to ask the second question -- if the first guard were ever
  -- bypassed, removed, or a new code path went round it, would the builder
  -- still refuse to snapshot a subset?
  alter table public.payroll_periods disable trigger trg_payroll_release_is_complete;
  begin
    update public.payroll_periods set status = 'released' where id = period;
    raise exception 'FAIL B the partial period reached released with the second guard in place';
  exception when check_violation then
    -- The refusal comes from build_payroll_finance_batch, reached through the
    -- handoff trigger on this very statement. With the first guard removed the
    -- second one still stops it, which is what defence in depth means here --
    -- and the message says which one spoke.
    if sqlerrm not like '%Finance cannot take a partial snapshot%' then
      raise exception 'FAIL B1 refused, but not by the Finance builder: %', sqlerrm;
    end if;
    raise notice 'PASS  B1 with the period guard removed, the Finance builder still refuses';
  end;
  alter table public.payroll_periods enable trigger trg_payroll_release_is_complete;

  select status into txt from public.payroll_periods where id = period;
  if txt = 'released' then raise exception 'FAIL B the period is released after a failed statement'; end if;

  select count(*)::integer into n from public.payroll_finance_batches
   where source_payroll_period_id = period;
  if n <> 0 then raise exception 'FAIL B a batch was built from an incomplete period'; end if;
  select count(*)::integer into n from public.payroll_finance_items i
   join public.payroll_records r on r.id = i.source_payroll_record_id
   where r.payroll_period_id = period;
  if n <> 0 then raise exception 'FAIL B % orphan snapshot items were written', n; end if;
  raise notice 'PASS  B2 and neither a batch nor a single item is written';

  -- Called directly on a period that is not released, it declines quietly --
  -- there is nothing to snapshot yet and that is not an error.
  if public.build_payroll_finance_batch(period) is not null then
    raise exception 'FAIL B3 the builder snapshotted a period that is not released';
  end if;
  raise notice 'PASS  B3 and a period that is not released produces no batch at all';

  -- ======================================================================
  -- O/P. Who may call the release RPC
  -- ======================================================================
  period_b := pg_temp.approved_period(array[emp_a, emp_b], hr_staff, hr_mgr, 1);

  perform pg_temp.acts_as(hr_staff); set local role authenticated;
  begin
    perform public.release_payroll_period(period_b);
    raise exception 'FAIL O HR Staff released payroll';
  exception when insufficient_privilege then
    raise notice 'PASS  O HR Staff cannot release payroll';
  end;
  reset role;

  perform pg_temp.acts_as(emp_a); set local role authenticated;
  begin
    perform public.release_payroll_period(period_b);
    raise exception 'FAIL O an employee released payroll';
  exception when insufficient_privilege then
    raise notice 'PASS  O2 nor can an employee';
  end;
  reset role;

  perform pg_temp.acts_as(accountant); set local role authenticated;
  begin
    perform public.release_payroll_period(period_b);
    raise exception 'FAIL O the Accountant released payroll';
  exception when insufficient_privilege then
    raise notice 'PASS  O3 nor a Finance role -- release is HR''s';
  end;
  reset role;

  -- ======================================================================
  -- K. The HR Manager releases, atomically
  -- ======================================================================
  perform pg_temp.acts_as(hr_mgr); set local role authenticated;
  batch := public.release_payroll_period(period_b);
  if batch is null then raise exception 'FAIL P the HR Manager could not release payroll'; end if;
  raise notice 'PASS  P an HR Manager can release payroll';

  select count(*)::integer into n from public.payroll_records
   where payroll_period_id = period_b and status = 'released';
  if n <> 2 then raise exception 'FAIL K only % of 2 records were released', n; end if;

  select count(*)::integer into n from public.payslips p
  join public.payroll_records r on r.id = p.payroll_record_id
  where r.payroll_period_id = period_b;
  if n <> 2 then raise exception 'FAIL K % payslips for 2 records', n; end if;

  select status into txt from public.payroll_periods where id = period_b;
  if txt <> 'released' then raise exception 'FAIL K the period is % not released', txt; end if;
  raise notice 'PASS  K release issues every payslip, releases every record and moves the period';

  -- ======================================================================
  -- C/D. Exactly one complete Finance snapshot
  -- ======================================================================
  select count(*)::integer into n from public.payroll_finance_batches
   where source_payroll_period_id = period_b;
  if n <> 1 then raise exception 'FAIL C % batches for one period', n; end if;

  select count(*)::integer into n from public.payroll_finance_items where batch_id = batch;
  if n <> 2 then raise exception 'FAIL D the snapshot has % items for 2 records', n; end if;

  select count(*)::integer into n
  from public.payroll_finance_items i
  where i.batch_id = batch
    and i.source_payroll_record_id in
        (select id from public.payroll_records where payroll_period_id = period_b);
  if n <> 2 then raise exception 'FAIL D the snapshot items do not match the source records'; end if;
  raise notice 'PASS  C/D one snapshot, one item per source record, identities matching';

  -- Copied, not recalculated.
  select gross_total, net_total into num, num from public.payroll_finance_batches where id = batch;
  select b.net_total = (select sum(r.net_salary) from public.payroll_records r
                         where r.payroll_period_id = period_b)
    into ok from public.payroll_finance_batches b where b.id = batch;
  if not ok then raise exception 'FAIL D the snapshot total is not the sum of the source records'; end if;
  raise notice 'PASS  D2 and the totals are copies of what HR computed';

  -- ======================================================================
  -- E/M/N. Retry
  -- ======================================================================
  batch2 := public.release_payroll_period(period_b);
  if batch2 is distinct from batch then
    raise exception 'FAIL N a retry produced a different batch'; end if;
  raise notice 'PASS  N a retry returns the same Finance batch';

  select count(*)::integer into n from public.payroll_finance_batches
   where source_payroll_period_id = period_b;
  if n <> 1 then raise exception 'FAIL N a retry produced % batches', n; end if;
  select count(*)::integer into n from public.payroll_finance_items where batch_id = batch;
  if n <> 2 then raise exception 'FAIL N a retry produced % items', n; end if;

  select count(*)::integer into n from public.payslips p
  join public.payroll_records r on r.id = p.payroll_record_id
  where r.payroll_period_id = period_b;
  if n <> 2 then raise exception 'FAIL M a retry produced % payslips', n; end if;
  raise notice 'PASS  E/M a retry duplicates no payslip, no batch and no item';

  -- And calling the builder again on its own is equally inert. Called with the
  -- role reset, because the builder is deliberately not granted to
  -- authenticated -- it is reached through the handoff trigger and the release
  -- RPC, both SECURITY DEFINER, and never from a browser.
  reset role;
  begin
    perform 1 from (select public.build_payroll_finance_batch(period_b) as b) s
     where s.b is distinct from batch;
    if found then raise exception 'FAIL E the builder produced a different batch on retry'; end if;
  end;
  raise notice 'PASS  E2 and the builder alone is idempotent too';
  perform pg_temp.acts_as(hr_mgr); set local role authenticated;

  -- ======================================================================
  -- J. One payslip per record, enforced by the database
  -- ======================================================================
  select id into rec_a from public.payroll_records where payroll_period_id = period_b limit 1;
  begin
    insert into public.payslips (payroll_record_id) values (rec_a);
    raise exception 'FAIL J a second payslip was issued for one record';
  exception when unique_violation then
    raise notice 'PASS  J one payroll record can only ever have one payslip';
  end;

  -- ======================================================================
  -- F/G/H. Released payroll is immutable
  -- ======================================================================
  begin
    update public.payroll_records set net_salary = 999999 where id = rec_a;
    raise exception 'FAIL F a released record''s net salary was changed';
  exception when insufficient_privilege then
    raise notice 'PASS  F a released record''s figures cannot be changed';
  end;

  begin
    update public.payroll_records set status = 'approved' where id = rec_a;
    raise exception 'FAIL F a released record was moved back to approved';
  exception when insufficient_privilege then
    raise notice 'PASS  F2 nor can it be moved out of released';
  end;

  -- Two layers, proved separately. RLS filters the HR Manager's delete to zero
  -- rows, so the trigger never sees it -- which protects the record but proves
  -- nothing about the trigger.
  delete from public.payroll_records where id = rec_a;
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'FAIL F3 the HR Manager deleted a released record'; end if;
  reset role;
  select count(*)::integer into n from public.payroll_records where id = rec_a;
  if n <> 1 then raise exception 'FAIL F3 the released record is gone'; end if;

  -- Now with RLS out of the way, which is what a service-role or console
  -- delete would look like.
  begin
    delete from public.payroll_records where id = rec_a;
    raise exception 'FAIL F3 a released record was deleted with RLS bypassed';
  exception when insufficient_privilege then
    raise notice 'PASS  F3 nor deleted -- refused by policy, and by the trigger behind it';
  end;
  perform pg_temp.acts_as(hr_mgr); set local role authenticated;

  -- The rest of the boundary is HR Staff's to test: protect_payroll_amounts
  -- has always refused an HR Manager any field change beyond the decision
  -- itself, so a Manager is the wrong actor for "what may still be edited".
  reset role;
  perform pg_temp.acts_as(hr_staff); set local role authenticated;

  -- The annotation is not a figure, and is deliberately still writable.
  update public.payroll_records set notes = 'ZZ checked against timesheet' where id = rec_a;
  get diagnostics n = row_count;
  if n <> 1 then raise exception 'FAIL F4 a note could not be added to a released record'; end if;
  raise notice 'PASS  F4 while a note, which nobody is paid, can still be added';

  begin
    insert into public.payroll_line_items (payroll_record_id, item_type, label, amount)
    values (rec_a, 'allowance', 'ZZ late addition', 500);
    raise exception 'FAIL G a line was added to a released record';
  exception when insufficient_privilege then
    raise notice 'PASS  G no allowance or deduction line can be added after release';
  end;

  begin
    update public.payroll_periods set period_end = current_date + 40 where id = period_b;
    raise exception 'FAIL H a released period''s dates were changed';
  exception when insufficient_privilege then
    raise notice 'PASS  H a released period''s dates are fixed';
  end;

  -- The document link is the field designed to arrive after release.
  update public.payslips set file_url = 'https://example.invalid/zz.pdf'
   where payroll_record_id = rec_a;
  get diagnostics n = row_count;
  if n <> 1 then raise exception 'FAIL H3 a payslip document link could not be filled in'; end if;
  raise notice 'PASS  H3 while the payslip document link may still be filled in';
  reset role;

  -- Deleting a payslip is admin-only by policy, so as with the record above
  -- the trigger is proved with RLS out of the way.
  begin
    delete from public.payslips where payroll_record_id = rec_a;
    raise exception 'FAIL H2 a released payslip was deleted';
  exception when insufficient_privilege then
    raise notice 'PASS  H2 and a released payslip cannot be deleted';
  end;

  -- H (parent defence). The freeze is a trigger, not a policy, so a write that
  -- never meets RLS at all still meets it -- which is the direct/bypassing case
  -- the preflight was about.
  begin
    update public.payroll_records set status = 'approved' where id = rec_a;
    raise exception 'FAIL H4 a released record was reopened by a write that bypasses RLS';
  exception when insufficient_privilege then
    raise notice 'PASS  H4 the freeze holds even against a write that bypasses RLS';
  end;

  select status into txt from public.payroll_records where id = rec_a;
  if txt <> 'released' then raise exception 'FAIL H4 the record is now %', txt; end if;

  -- ======================================================================
  -- I. Pre-release payroll is still editable
  -- ======================================================================
  period_c := pg_temp.approved_period(array[emp_a], hr_staff, hr_mgr, 2);
  select id into rec_b from public.payroll_records where payroll_period_id = period_c limit 1;

  perform pg_temp.acts_as(hr_staff); set local role authenticated;
  update public.payroll_records set net_salary = 21000 where id = rec_b;
  get diagnostics n = row_count;
  if n <> 1 then raise exception 'FAIL I approved payroll could no longer be corrected'; end if;

  insert into public.payroll_line_items (payroll_record_id, item_type, label, amount)
  values (rec_b, 'allowance', 'ZZ transport', 500);
  get diagnostics n = row_count;
  if n <> 1 then raise exception 'FAIL I a line could not be added before release'; end if;
  raise notice 'PASS  I payroll that has not been released is still HR Staff''s to correct';
  reset role;

  -- ======================================================================
  -- L. A failure anywhere rolls the whole release back
  -- ======================================================================
  -- The failure is induced the way a real one would arrive: one record in the
  -- period cannot be released. The release must leave nothing behind.
  -- Rejecting is the HR Manager's, like every other decision.
  perform pg_temp.acts_as(hr_mgr); set local role authenticated;
  update public.payroll_records set status = 'rejected', rejection_reason = 'ZZ induced'
   where id = rec_b;
  begin
    perform public.release_payroll_period(period_c);
    raise exception 'FAIL L a period with a rejected record was released';
  exception when check_violation then
    raise notice 'PASS  L a release that cannot complete is refused';
  end;
  reset role;

  select count(*)::integer into n from public.payslips p
  join public.payroll_records r on r.id = p.payroll_record_id
  where r.payroll_period_id = period_c;
  if n <> 0 then raise exception 'FAIL L the failed release left % payslips behind', n; end if;

  select count(*)::integer into n from public.payroll_records
   where payroll_period_id = period_c and status = 'released';
  if n <> 0 then raise exception 'FAIL L the failed release released % records', n; end if;

  select status into txt from public.payroll_periods where id = period_c;
  if txt = 'released' then raise exception 'FAIL L the failed release moved the period'; end if;

  select count(*)::integer into n from public.payroll_finance_batches
   where source_payroll_period_id = period_c;
  if n <> 0 then raise exception 'FAIL L the failed release handed % batches to Finance', n; end if;
  raise notice 'PASS  L no payslip, no released record, no period move and no Finance batch survive it';

  -- ======================================================================
  -- Q. Confidentiality is not weakened
  -- ======================================================================
  perform pg_temp.acts_as(fin_staff); set local role authenticated;
  select count(*)::integer into n from public.payroll_records;
  if n <> 0 then raise exception 'FAIL Q Finance Staff read % payroll records', n; end if;
  select count(*)::integer into n from public.payroll_finance_items;
  if n <> 0 then raise exception 'FAIL Q Finance Staff read % per-employee salary lines', n; end if;
  raise notice 'PASS  Q Finance Staff still see no payroll record and no salary line';
  reset role;

  perform pg_temp.acts_as(accountant); set local role authenticated;
  select count(*)::integer into n from public.payroll_finance_items where batch_id = batch;
  if n <> 2 then raise exception 'FAIL Q the Accountant lost their intended detail access'; end if;
  raise notice 'PASS  Q2 while the Accountant keeps the detail they need to pay it';
  reset role;

  perform pg_temp.acts_as(outsider); set local role authenticated;
  select count(*)::integer into n from public.payroll_records where payroll_period_id = period_b;
  if n <> 0 then raise exception 'FAIL Q an unrelated employee read % payroll records', n; end if;
  raise notice 'PASS  Q3 and an unrelated employee reads none of it';
  reset role;

  -- ======================================================================
  -- R/S. Release moves no money
  -- ======================================================================
  select count(*)::integer into movements_after from public.treasury_movements;
  if movements_after <> movements_before then
    raise exception 'FAIL R release created % treasury movements',
      movements_after - movements_before;
  end if;
  raise notice 'PASS  R releasing payroll creates no treasury movement';

  select count(*)::integer into n from public.payroll_disbursements;
  if n <> 0 then raise exception 'FAIL R release created % disbursements', n; end if;
  raise notice 'PASS  R2 and no disbursement -- paying it is a separate act';

  -- Payroll is budget-neutral by design: no payroll row names a budget, so
  -- there is nothing for a reservation to attach to.
  select coalesce(sum(reserved), 0), coalesce(sum(spent), 0)
    into reserved_after, spent_after from public.budget_status;
  select count(*)::integer into n
  from information_schema.columns
  where table_schema = 'public' and table_name = 'payroll_finance_batches'
    and column_name = 'budget_id';
  if n <> 0 then raise exception 'FAIL S a payroll batch names a budget'; end if;
  raise notice 'PASS  S payroll names no budget, so releasing it commits nothing';

  raise notice '--------------------------------------------------';
  raise notice 'payroll_release_integrity_rls: all checks passed';
end $$;

rollback;
