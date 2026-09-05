-- F7B: Finance pays what HR finalized, and computes none of it.
--
-- The boundary this file defends. HR owns the calculation; a period reaches
-- 'released' only when every one of its records has, and that is the moment
-- Finance gets a payable. Everything on the Finance side is a copy taken then.
--
--   an unfinalized period creates no payable
--   finalizing creates exactly one, and a retry creates none
--   the snapshot totals equal the finalized HR figures, to the centavo
--   Finance cannot rewrite the snapshot, before or after paying
--   approving a disbursement moves nothing; recording it moves treasury once
--   cumulative disbursements cannot exceed the net payable
--   payroll is budget-neutral, because HR payroll names no budget
--   Finance Staff do not gain salary lines by reviewing reimbursements
--
-- Run:
--   docker exec -i supabase_db_harmony-suite psql -U postgres -d postgres \
--     -v ON_ERROR_STOP=1 -f - < supabase/tests/payroll_finance_rls.sql
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
  admin_id uuid; hr_staff uuid; hr_mgr uuid; fin_mgr uuid; fin_staff uuid;
  accountant uuid; accountant2 uuid;
  emp_a uuid; emp_b uuid; payee_a uuid; payee_b uuid; period uuid; rec_a uuid; rec_b uuid;
  bank uuid; small uuid; batch uuid; disb uuid; disb2 uuid;
  gross numeric; deduct numeric; net numeric; bal numeric; due numeric;
  n integer; txt text;
  b_reserved numeric; b_spent numeric; budget uuid; cat_id uuid;
  tag text := left(replace(gen_random_uuid()::text, '-', ''), 8);
begin
  select id into admin_id from public.profiles where role='admin' and status='active' limit 1;

  hr_staff    := pg_temp.hire('HR Person',   'HR Staff');
  hr_mgr      := pg_temp.hire('HR Boss',     'HR Manager');
  fin_mgr     := pg_temp.hire('Fin Manager', 'Finance Manager');
  fin_staff   := pg_temp.hire('Fin Staff',   'Finance Staff');
  accountant  := pg_temp.hire('Bookkeeper',  'Accountant');
  accountant2 := pg_temp.hire('Bookkeeper2', 'Accountant');

  -- Two statements, not one: hire() updates the profile, and a SELECT whose
  -- WHERE clause calls it reads a snapshot taken before that update landed.
  payee_a := pg_temp.hire('Payee A', 'Cashier');
  payee_b := pg_temp.hire('Payee B', 'Cashier');
  select p.employee_id into emp_a from public.profiles p where p.id = payee_a;
  select p.employee_id into emp_b from public.profiles p where p.id = payee_b;
  if emp_a is null or emp_b is null then raise exception 'fixture: no employee ids'; end if;

  perform pg_temp.acts_as(accountant); set local role authenticated;
  insert into public.treasury_accounts (name, account_type, opening_balance, opening_balance_as_of)
  values ('ZZ Payroll Bank ' || tag, 'bank', 200000, current_date) returning id into bank;
  insert into public.treasury_accounts (name, account_type, opening_balance, opening_balance_as_of)
  values ('ZZ Payroll Petty ' || tag, 'cash', 500, current_date) returning id into small;
  reset role;

  -- A budget, so the budget-neutrality claim has something to be neutral about.
  select id into cat_id from public.finance_categories where kind='expense' and is_active limit 1;
  perform pg_temp.acts_as(fin_staff); set local role authenticated;
  insert into public.budgets (name, finance_category_id, amount, fiscal_year)
  values ('ZZ Payroll Budget ' || tag, cat_id, 90000, extract(year from current_date)::integer)
  returning id into budget;
  reset role;
  perform pg_temp.acts_as(fin_mgr); set local role authenticated;
  perform public.review_budget(budget, true, 'fixture');
  reset role;

  -- ======================================================================
  -- 1. HR prepares a period. Finance sees nothing yet.
  -- ======================================================================
  perform pg_temp.acts_as(hr_staff); set local role authenticated;
  insert into public.payroll_periods (period_start, period_end, pay_date, frequency, status)
  values (date '2026-08-01', date '2026-08-15', date '2026-08-20', 'semi_monthly', 'draft')
  returning id into period;

  insert into public.payroll_records
    (payroll_period_id, employee_id, basic_salary, total_allowances, gross_salary,
     total_deductions, net_salary, status)
  values (period, emp_a, 30000, 2000, 32000, 4000, 28000, 'generated')
  returning id into rec_a;
  insert into public.payroll_records
    (payroll_period_id, employee_id, basic_salary, total_allowances, gross_salary,
     total_deductions, net_salary, status)
  values (period, emp_b, 20000, 1000, 21000, 3000, 18000, 'generated')
  returning id into rec_b;
  reset role;

  select count(*)::integer into n from public.payroll_finance_batches
   where source_payroll_period_id = period;
  if n <> 0 then raise exception 'FAIL 1a an unfinalized period produced a payable'; end if;
  raise notice 'PASS  1a payroll HR has not finalized creates no Finance payable';

  -- ======================================================================
  -- 2. Finalization hands it over, exactly once
  -- ======================================================================
  --
  -- Releasing every record is what makes the period released, and the period
  -- becoming released is what calls Finance. Nobody types a Finance batch.
  -- Release is the HR Manager's: HR Staff prepare, the Manager finalizes.
  perform pg_temp.acts_as(hr_mgr); set local role authenticated;
  update public.payroll_records set status = 'released', released_at = now()
   where payroll_period_id = period;
  reset role;

  select status into txt from public.payroll_periods where id = period;
  if txt <> 'released' then
    raise exception 'FAIL 2a the period is %, expected released once every record is', txt;
  end if;

  select count(*)::integer into n from public.payroll_finance_batches
   where source_payroll_period_id = period;
  if n <> 1 then raise exception 'FAIL 2a finalization produced % batches, expected 1', n; end if;
  raise notice 'PASS  2a finalizing a period creates exactly one Finance payable';

  select id into batch from public.payroll_finance_batches where source_payroll_period_id = period;

  -- A retry, however it arrives.
  perform public.build_payroll_finance_batch(period);
  perform public.build_payroll_finance_batch(period);
  select count(*)::integer into n from public.payroll_finance_batches
   where source_payroll_period_id = period;
  if n <> 1 then raise exception 'FAIL 2b a repeated handoff created % batches', n; end if;
  raise notice 'PASS  2b a repeated or retried handoff creates no duplicate';

  -- And the unique constraint is the thing that guarantees it, not the check.
  begin
    insert into public.payroll_finance_batches
      (source_payroll_period_id, period_start, period_end, employee_count,
       gross_total, deductions_total, net_total)
    values (period, date '2026-08-01', date '2026-08-15', 2, 53000, 7000, 46000);
    raise exception 'FAIL 2c a second batch was inserted for one HR period';
  exception when unique_violation then
    raise notice 'PASS  2c the unique source period is what makes it idempotent';
  end;

  -- ======================================================================
  -- 3. The snapshot is a copy, to the centavo
  -- ======================================================================
  select b.gross_total, b.deductions_total, b.net_total, b.employee_count
    into gross, deduct, net, n
  from public.payroll_finance_batches b where b.id = batch;

  if gross <> 53000 or deduct <> 7000 or net <> 46000 or n <> 2 then
    raise exception 'FAIL 3a snapshot gross % deductions % net % count %, expected 53000/7000/46000/2',
      gross, deduct, net, n;
  end if;
  raise notice 'PASS  3a the batch totals equal the finalized HR figures exactly';

  -- Against the source, rather than against a number I typed twice.
  select sum(r.gross_salary), sum(r.total_deductions), sum(r.net_salary)
    into gross, deduct, net
  from public.payroll_records r where r.payroll_period_id = period and r.status = 'released';
  select count(*)::integer into n from public.payroll_finance_batches b
   where b.id = batch and b.gross_total = gross and b.deductions_total = deduct
     and b.net_total = net;
  if n <> 1 then raise exception 'FAIL 3b the snapshot diverges from its source'; end if;
  raise notice 'PASS  3b and match the HR rows they were copied from';

  select count(*)::integer into n from public.payroll_finance_items where batch_id = batch;
  if n <> 2 then raise exception 'FAIL 3c the batch has % lines, expected 2', n; end if;
  select count(*)::integer into n
  from public.payroll_finance_items i
  join public.payroll_records r on r.id = i.source_payroll_record_id
  where i.batch_id = batch
    and (i.gross_amount <> r.gross_salary or i.net_amount <> r.net_salary
         or i.deductions_amount <> r.total_deductions);
  if n <> 0 then raise exception 'FAIL 3c % lines differ from their source record', n; end if;
  raise notice 'PASS  3c every line matches the HR record it came from';

  -- ======================================================================
  -- 4. The snapshot cannot be rewritten
  -- ======================================================================
  begin
    update public.payroll_finance_batches set net_total = 1 where id = batch;
    raise exception 'FAIL 4a the snapshot was rewritten';
  exception when insufficient_privilege then
    raise notice 'PASS  4a a payroll snapshot cannot be changed';
  end;
  begin
    delete from public.payroll_finance_batches where id = batch;
    raise exception 'FAIL 4b the snapshot was deleted';
  exception when insufficient_privilege then
    raise notice 'PASS  4b nor deleted';
  end;
  begin
    update public.payroll_finance_items set net_amount = 1 where batch_id = batch;
    raise exception 'FAIL 4c a snapshot line was rewritten';
  exception when insufficient_privilege then
    raise notice 'PASS  4c nor its lines';
  end;

  -- ======================================================================
  -- 5. Preparing and approving move nothing
  -- ======================================================================
  select v.balance_due, v.available_to_prepare, v.settlement_state
    into due, bal, txt from public.payroll_finance_status v where v.id = batch;
  if due <> 46000 or bal <> 46000 or txt <> 'awaiting_disbursement' then
    raise exception 'FAIL 5a due % available % state %, expected 46000/46000/awaiting', due, bal, txt;
  end if;
  raise notice 'PASS  5a a finalized batch owes its whole net pay';

  perform pg_temp.acts_as(accountant); set local role authenticated;
  select public.create_payroll_disbursement(batch, bank, 30000, 'bank_transfer', 'ZZ part', true)
    into disb;
  reset role;

  select v.balance_due, v.pending_disbursement, v.available_to_prepare
    into due, gross, bal from public.payroll_finance_status v where v.id = batch;
  if due <> 46000 or gross <> 30000 or bal <> 16000 then
    raise exception 'FAIL 5b due % pending % available %, expected 46000/30000/16000', due, gross, bal;
  end if;
  select t.balance into bal from public.treasury_account_status t where t.id = bank;
  if bal <> 200000 then raise exception 'FAIL 5b preparing moved the bank to %', bal; end if;
  raise notice 'PASS  5b preparing claims the money and moves none of it';

  perform pg_temp.acts_as(fin_mgr); set local role authenticated;
  perform public.transition_payroll_disbursement(disb, 'approved', null, null, null);
  reset role;
  select t.balance into bal from public.treasury_account_status t where t.id = bank;
  if bal <> 200000 then raise exception 'FAIL 5c APPROVAL moved the bank to %', bal; end if;
  raise notice 'PASS  5c approving authorises it and still moves nothing';

  -- ======================================================================
  -- 6. Recording it is what pays
  -- ======================================================================
  select bs.reserved, bs.spent into b_reserved, b_spent
    from public.budget_status bs where bs.id = budget;

  perform pg_temp.acts_as(accountant); set local role authenticated;
  perform public.transition_payroll_disbursement(
    disb, 'paid', null, 'PYTRF-A-' || tag, date '2026-08-20');
  reset role;

  select t.balance into bal from public.treasury_account_status t where t.id = bank;
  if bal <> 170000 then raise exception 'FAIL 6a the bank is %, expected 170000', bal; end if;
  select count(*)::integer into n from public.treasury_movements
   where source_type = 'payroll_disbursement' and source_id = disb;
  if n <> 1 then raise exception 'FAIL 6a one disbursement produced % movements', n; end if;
  raise notice 'PASS  6a recording a disbursement moves the bank exactly once';

  select v.amount_paid, v.balance_due, v.settlement_state
    into gross, due, txt from public.payroll_finance_status v where v.id = batch;
  if gross <> 30000 or due <> 16000 or txt <> 'partially_paid' then
    raise exception 'FAIL 6b paid % due % state %, expected 30000/16000/partially_paid',
      gross, due, txt;
  end if;
  raise notice 'PASS  6b the Finance payroll balance falls by what was paid';

  -- Budget-neutral, as decided: HR payroll names no budget, so nothing here
  -- may invent one.
  select bs.reserved, bs.spent into gross, deduct from public.budget_status bs where bs.id = budget;
  if gross <> b_reserved or deduct <> b_spent then
    raise exception 'FAIL 6c payroll moved a budget: reserved % -> %, spent % -> %',
      b_reserved, gross, b_spent, deduct;
  end if;
  raise notice 'PASS  6c paying payroll moves no budget -- HR payroll names none';

  -- HR is untouched by any of it.
  select sum(r.net_salary) into net from public.payroll_records r
   where r.payroll_period_id = period;
  if net <> 46000 then raise exception 'FAIL 6d the HR payroll changed to %', net; end if;
  select status into txt from public.payroll_periods where id = period;
  if txt <> 'released' then raise exception 'FAIL 6d the HR period status changed to %', txt; end if;
  raise notice 'PASS  6d the finalized HR payroll is exactly as it was';

  -- ======================================================================
  -- 7. Over-instruction, maker/checker, funds
  -- ======================================================================
  perform pg_temp.acts_as(accountant); set local role authenticated;
  begin
    perform public.create_payroll_disbursement(batch, bank, 20000, 'bank_transfer', null, false);
    raise exception 'FAIL 7a 20000 was accepted against 16000 remaining';
  exception when check_violation then
    if sqlerrm not like '%16,000.00 still available%' then
      raise exception 'FAIL 7a wrong message: %', sqlerrm;
    end if;
    raise notice 'PASS  7a cumulative disbursements cannot exceed the net payable';
  end;
  select public.create_payroll_disbursement(batch, small, 16000, 'bank_transfer', null, true)
    into disb2;
  begin
    perform public.create_payroll_disbursement(batch, bank, 1, 'bank_transfer', null, false);
    raise exception 'FAIL 7b an instruction was accepted with nothing available';
  exception when check_violation then
    if sqlerrm <> 'This payroll batch is already fully covered by disbursement instructions.' then
      raise exception 'FAIL 7b wrong message: %', sqlerrm;
    end if;
    raise notice 'PASS  7b and nothing more once the batch is fully covered';
  end;

  begin
    perform public.transition_payroll_disbursement(disb2, 'approved', null, null, null);
    raise exception 'FAIL 7c the preparer approved their own disbursement';
  exception when insufficient_privilege then
    raise notice 'PASS  7c the person who prepared it cannot approve it';
  end;
  reset role;

  perform pg_temp.acts_as(fin_mgr); set local role authenticated;
  begin
    perform public.transition_payroll_disbursement(
      disb2, 'paid', null, 'NOPE-' || tag, date '2026-08-20');
    raise exception 'FAIL 7d the Finance Manager recorded a payment';
  exception when insufficient_privilege or check_violation then
    raise notice 'PASS  7d the checker approves and does not record the payment';
  end;
  perform public.transition_payroll_disbursement(disb2, 'approved', null, null, null);
  reset role;

  perform pg_temp.acts_as(accountant); set local role authenticated;
  begin
    perform public.transition_payroll_disbursement(
      disb2, 'paid', null, 'SHORT-' || tag, date '2026-08-20');
    raise exception 'FAIL 7e an account holding 500 paid out 16000';
  exception when check_violation then
    if sqlerrm <> 'This account does not have enough available funds for this payment.' then
      raise exception 'FAIL 7e wrong message: %', sqlerrm;
    end if;
    raise notice 'PASS  7e an underfunded account cannot pay a payroll';
  end;
  reset role;

  -- ======================================================================
  -- 8. Who may see a salary
  -- ======================================================================
  --
  -- Every Finance role may see what has to be paid. The per-employee lines are
  -- salary data, and reviewing reimbursements is not a reason to receive them.
  perform pg_temp.acts_as(fin_staff); set local role authenticated;
  select count(*)::integer into n from public.get_payroll_finance_batches() b where b.id = batch;
  if n <> 1 then raise exception 'FAIL 8a Finance Staff cannot see the payroll payable'; end if;
  select count(*)::integer into n from public.get_payroll_finance_items(batch);
  if n <> 0 then raise exception 'FAIL 8a Finance Staff read % salary lines', n; end if;
  reset role;
  raise notice 'PASS  8a Finance Staff see the payable, and no individual salary';

  perform pg_temp.acts_as(accountant); set local role authenticated;
  select count(*)::integer into n from public.get_payroll_finance_items(batch);
  if n <> 2 then raise exception 'FAIL 8b the Accountant cannot see the lines they must pay'; end if;
  reset role;
  perform pg_temp.acts_as(fin_mgr); set local role authenticated;
  select count(*)::integer into n from public.get_payroll_finance_items(batch);
  if n <> 2 then raise exception 'FAIL 8b the Finance Manager cannot see the lines'; end if;
  reset role;
  raise notice 'PASS  8b the two roles that execute the payment can see its lines';

  -- An ordinary employee reaches none of it.
  perform pg_temp.acts_as(accountant2); set local role authenticated;
  reset role;
  perform set_config('request.jwt.claims', '', true);
  set local role anon;
  begin
    select count(*)::integer into n from public.payroll_finance_batches;
    if n <> 0 then raise exception 'FAIL 8c anon read a payroll payable'; end if;
  exception when insufficient_privilege then n := 0;
  end;
  reset role;
  raise notice 'PASS  8c an anonymous caller reads no payroll at all';

  raise notice '--------------------------------------------------';
  raise notice 'payroll_finance_rls: all checks passed';
end $$;

rollback;
