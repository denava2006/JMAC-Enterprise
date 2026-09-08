-- F7 payroll, final release-integrity patch: the four remaining gaps.
--
-- The previous round closed the UPDATE paths into and out of released. Three of
-- these four are the same oversight from different angles -- the guards were
-- written about changing rows, and INSERT is not a change:
--
--   01  a period could be INSERTed with status = 'released'
--   02  a record could be INSERTed into an already-released period, moving the
--       HR source set out from under an immutable Finance snapshot
--   03  the already-released readback checked child release state but never
--       payslips, so a period missing one read back as valid
--   04  an existing Finance batch was revalidated by COUNTING items. Records
--       A,B,C against items A,B,X counts equal and is wrong.
--
-- Each guard has a negative control: the thing it forbids is watched being
-- refused, and the legitimate neighbour is watched succeeding.
--
-- Run:
--   docker exec -i supabase_db_harmony-suite psql -U postgres -d postgres \
--     -v ON_ERROR_STOP=1 -f - < supabase/tests/payroll_release_membership_rls.sql
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

do $$
declare
  admin_id uuid; hr_staff uuid; hr_mgr uuid;
  emp_a uuid; emp_b uuid; emp_c uuid;
  row_a uuid; row_b uuid; row_c uuid;
  period uuid; other_period uuid; released_period uuid;
  rec_a uuid; rec_b uuid; foreign_rec uuid;
  batch uuid; again uuid; item_id uuid;
  n integer; txt text;
  tag text := left(replace(gen_random_uuid()::text, '-', ''), 8);
begin
  select id into admin_id from public.profiles where role='admin' and status='active' limit 1;

  hr_staff := pg_temp.hire('HR Staff',   'HR Staff');
  hr_mgr   := pg_temp.hire('HR Manager', 'HR Manager');
  emp_a    := pg_temp.hire('Worker A',   'Cashier');
  emp_b    := pg_temp.hire('Worker B',   'Cashier');
  emp_c    := pg_temp.hire('Worker C',   'Cashier');
  select employee_id into row_a from public.profiles where id = emp_a;
  select employee_id into row_b from public.profiles where id = emp_b;
  select employee_id into row_c from public.profiles where id = emp_c;

  -- ======================================================================
  -- 1/2. A period cannot be created already released
  -- ======================================================================
  perform pg_temp.acts_as(hr_staff); set local role authenticated;

  begin
    insert into public.payroll_periods (period_start, period_end, pay_date, frequency, status)
    values (date '2027-01-01', date '2027-01-15', date '2027-01-20', 'semi_monthly', 'released');
    raise exception 'FAIL 1 a payroll period was created already released';
  exception when check_violation then
    raise notice 'PASS  1 a payroll period cannot be created already released';
  end;

  select count(*)::integer into n from public.payroll_periods
   where period_start = date '2027-01-01';
  if n <> 0 then raise exception 'FAIL 1 the refused period was created anyway'; end if;

  -- The negative control: the legitimate creation the product actually does.
  insert into public.payroll_periods (period_start, period_end, pay_date, frequency, status)
  values (date '2027-01-01', date '2027-01-15', date '2027-01-20', 'semi_monthly', 'draft')
  returning id into period;
  if period is null then raise exception 'FAIL 2 a normal draft period could not be created'; end if;
  raise notice 'PASS  2 while a normal draft period is created exactly as before';

  -- ======================================================================
  -- 4/5. Records: generation works, a released one is refused
  -- ======================================================================
  insert into public.payroll_records
    (payroll_period_id, employee_id, basic_salary, total_allowances, gross_salary,
     total_deductions, net_salary, status)
  values (period, row_a, 20000, 1000, 21000, 1000, 20000, 'generated')
  returning id into rec_a;
  insert into public.payroll_records
    (payroll_period_id, employee_id, basic_salary, total_allowances, gross_salary,
     total_deductions, net_salary, status)
  values (period, row_b, 20000, 1000, 21000, 1000, 20000, 'generated')
  returning id into rec_b;
  raise notice 'PASS  4 payroll generation into a pre-release period still works';

  begin
    insert into public.payroll_records
      (payroll_period_id, employee_id, basic_salary, total_allowances, gross_salary,
       total_deductions, net_salary, status)
    values (period, row_c, 20000, 1000, 21000, 1000, 20000, 'released');
    raise exception 'FAIL 5 a payroll record was created already released';
  exception when check_violation then
    raise notice 'PASS  5 a payroll record cannot be created already released';
  end;
  reset role;

  -- Release it properly, which is also the setup for everything below.
  perform pg_temp.acts_as(hr_mgr); set local role authenticated;
  update public.payroll_records set status = 'approved' where payroll_period_id = period;
  batch := public.release_payroll_period(period);
  if batch is null then raise exception 'FAIL setup the period could not be released'; end if;
  released_period := period;

  select status into txt from public.payroll_periods where id = released_period;
  if txt <> 'released' then raise exception 'FAIL setup the period is %', txt; end if;
  reset role;

  -- ======================================================================
  -- 3. No new record may join a released period
  -- ======================================================================
  perform pg_temp.acts_as(hr_staff); set local role authenticated;
  begin
    insert into public.payroll_records
      (payroll_period_id, employee_id, basic_salary, total_allowances, gross_salary,
       total_deductions, net_salary, status)
    values (released_period, row_c, 20000, 1000, 21000, 1000, 20000, 'generated');
    raise exception 'FAIL 3 a record was added to a released period';
  exception when insufficient_privilege then
    raise notice 'PASS  3 no employee record can be added to a released period';
  end;
  reset role;

  select count(*)::integer into n from public.payroll_records
   where payroll_period_id = released_period;
  if n <> 2 then raise exception 'FAIL 3 the released period now has % records', n; end if;

  select count(*)::integer into n from public.payroll_finance_items where batch_id = batch;
  if n <> 2 then raise exception 'FAIL 3 the Finance snapshot has % items', n; end if;
  raise notice 'PASS  3b the source set and the Finance snapshot still agree';

  -- ======================================================================
  -- 6. A valid retry reads back the same batch
  -- ======================================================================
  perform pg_temp.acts_as(hr_mgr); set local role authenticated;
  again := public.release_payroll_period(released_period);
  if again is distinct from batch then
    raise exception 'FAIL 6 a valid retry returned a different batch'; end if;
  raise notice 'PASS  6 a valid released period reads back its existing batch';

  select count(*)::integer into n from public.payroll_finance_batches
   where source_payroll_period_id = released_period;
  if n <> 1 then raise exception 'FAIL 13 the retry produced % batches', n; end if;
  select count(*)::integer into n from public.payroll_finance_items where batch_id = batch;
  if n <> 2 then raise exception 'FAIL 13 the retry produced % items', n; end if;
  select count(*)::integer into n from public.payslips p
   join public.payroll_records r on r.id = p.payroll_record_id
   where r.payroll_period_id = released_period;
  if n <> 2 then raise exception 'FAIL 13 the retry produced % payslips', n; end if;
  raise notice 'PASS  13 and duplicates no payslip, batch or item';
  reset role;

  -- ======================================================================
  -- 7/8. A retry with a payslip missing fails, and repairs nothing
  -- ======================================================================
  -- Constructed by removing one, which the freeze forbids through every normal
  -- door -- so the trigger comes off for exactly one statement. That is the
  -- only honest way to ask what the readback does when it meets an
  -- inconsistency it is not supposed to be able to cause.
  alter table public.payslips disable trigger trg_freeze_released_payslip;
  delete from public.payslips where payroll_record_id = rec_a;
  alter table public.payslips enable trigger trg_freeze_released_payslip;

  select count(*)::integer into n from public.payslips where payroll_record_id = rec_a;
  if n <> 0 then raise exception 'FAIL 7 could not construct the missing payslip'; end if;

  perform pg_temp.acts_as(hr_mgr); set local role authenticated;
  begin
    perform public.release_payroll_period(released_period);
    raise exception 'FAIL 7 a released period missing a payslip read back as valid';
  exception when check_violation then
    if sqlerrm not like '%have no payslip%' then
      raise exception 'FAIL 7 refused, but not for the missing payslip: %', sqlerrm;
    end if;
    raise notice 'PASS  7 a released period missing a payslip fails the readback';
  end;
  reset role;

  -- And it repaired nothing on its way out.
  select count(*)::integer into n from public.payslips where payroll_record_id = rec_a;
  if n <> 0 then raise exception 'FAIL 8 the failed readback issued the missing payslip'; end if;
  select count(*)::integer into n from public.payroll_finance_batches
   where source_payroll_period_id = released_period;
  if n <> 1 then raise exception 'FAIL 8 the failed readback changed the batch count to %', n; end if;
  raise notice 'PASS  8 and issues nothing, repairs nothing, creates nothing';

  -- Put it back so the membership checks below start from a valid period.
  alter table public.payslips disable trigger trg_freeze_released_payslip;
  insert into public.payslips (payroll_record_id, released_at) values (rec_a, now());
  alter table public.payslips enable trigger trg_freeze_released_payslip;

  -- ======================================================================
  -- 9. Correct count AND correct membership passes
  -- ======================================================================
  perform pg_temp.acts_as(hr_mgr); set local role authenticated;
  if public.release_payroll_period(released_period) is distinct from batch then
    raise exception 'FAIL 9 a correct batch was rejected'; end if;
  raise notice 'PASS  9 a batch whose membership matches its source is accepted';
  reset role;

  -- ======================================================================
  -- 10. Equal count, one wrong source record, fails
  -- ======================================================================
  -- A second period with a record of its own, to stand in as the foreign one.
  perform pg_temp.acts_as(hr_staff); set local role authenticated;
  insert into public.payroll_periods (period_start, period_end, pay_date, frequency, status)
  values (date '2027-02-01', date '2027-02-15', date '2027-02-20', 'semi_monthly', 'draft')
  returning id into other_period;
  insert into public.payroll_records
    (payroll_period_id, employee_id, basic_salary, total_allowances, gross_salary,
     total_deductions, net_salary, status)
  values (other_period, row_c, 20000, 1000, 21000, 1000, 20000, 'generated')
  returning id into foreign_rec;
  reset role;

  -- Repoint one item at a record from the other period: still two items, still
  -- two records, and wrong in two directions at once. This is exactly what a
  -- count check cannot see.
  select id into item_id from public.payroll_finance_items
   where batch_id = batch and source_payroll_record_id = rec_b;
  alter table public.payroll_finance_items disable trigger user;
  update public.payroll_finance_items set source_payroll_record_id = foreign_rec
   where id = item_id;
  alter table public.payroll_finance_items enable trigger user;

  select count(*)::integer into n from public.payroll_finance_items where batch_id = batch;
  if n <> 2 then raise exception 'FAIL 10 the constructed batch has % items', n; end if;

  perform pg_temp.acts_as(hr_mgr); set local role authenticated;
  begin
    perform public.release_payroll_period(released_period);
    raise exception 'FAIL 10 a batch with a foreign source record was accepted on count alone';
  exception when check_violation then
    raise notice 'PASS  10/12 equal counts do not pass: a foreign source record is refused';
  end;
  reset role;

  -- ======================================================================
  -- 11. A missing source record fails
  -- ======================================================================
  alter table public.payroll_finance_items disable trigger user;
  update public.payroll_finance_items set source_payroll_record_id = rec_b where id = item_id;
  delete from public.payroll_finance_items where batch_id = batch and source_payroll_record_id = rec_b;
  alter table public.payroll_finance_items enable trigger user;

  perform pg_temp.acts_as(hr_mgr); set local role authenticated;
  begin
    perform public.release_payroll_period(released_period);
    raise exception 'FAIL 11 a batch missing a source record was accepted';
  exception when check_violation then
    raise notice 'PASS  11 a batch missing one of its source records is refused';
  end;
  reset role;

  -- ======================================================================
  -- 12. An extra source record fails
  -- ======================================================================
  alter table public.payroll_finance_items disable trigger user;
  insert into public.payroll_finance_items
    (batch_id, source_payroll_record_id, employee_id, employee_name,
     gross_amount, deductions_amount, net_amount)
  values (batch, rec_b, row_b, 'ZZ Worker B', 21000, 1000, 20000);
  insert into public.payroll_finance_items
    (batch_id, source_payroll_record_id, employee_id, employee_name,
     gross_amount, deductions_amount, net_amount)
  values (batch, foreign_rec, row_c, 'ZZ Worker C', 21000, 1000, 20000);
  alter table public.payroll_finance_items enable trigger user;

  select count(*)::integer into n from public.payroll_finance_items where batch_id = batch;
  if n <> 3 then raise exception 'FAIL 12 the constructed batch has % items', n; end if;

  perform pg_temp.acts_as(hr_mgr); set local role authenticated;
  begin
    perform public.release_payroll_period(released_period);
    raise exception 'FAIL 12 a batch carrying an extra source record was accepted';
  exception when check_violation then
    raise notice 'PASS  12 a batch carrying a record its period does not have is refused';
  end;
  reset role;

  -- And an inconsistent batch is never replaced with a fresh one.
  select count(*)::integer into n from public.payroll_finance_batches
   where source_payroll_period_id = released_period;
  if n <> 1 then raise exception 'FAIL 12 a second batch was built alongside the bad one'; end if;
  raise notice 'PASS  12b and no second batch is built to paper over it';

  raise notice '--------------------------------------------------';
  raise notice 'payroll_release_membership_rls: all checks passed';
end $$;

rollback;
