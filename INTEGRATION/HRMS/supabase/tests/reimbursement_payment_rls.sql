-- F7A: paying an employee back, and what that does to a budget.
--
-- The reimbursement itself is not new. finance_requests has carried
-- type = 'reimbursement' with its own expense_date since F3, the employee
-- files one from My Requests, and budget_status already reserves it at
-- approval. What F7 adds is the settlement half, and these are its claims:
--
--   submitting and reviewing reserve nothing
--   approval reserves, and cannot exceed what the budget has left
--   preparing and APPROVING a payment move nothing
--   only recording the completed payment moves anything
--   reserved falls by exactly what spent rises by, so available holds
--   one reimbursement is one reservation source, never two
--   a paid reimbursement cannot be withdrawn
--
-- Run:
--   docker exec -i supabase_db_harmony-suite psql -U postgres -d postgres \
--     -v ON_ERROR_STOP=1 -f - < supabase/tests/reimbursement_payment_rls.sql
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

/** A reimbursement claim, filed by the employee the way My Requests files it. */
create or replace function pg_temp.claim(
  _employee uuid, _amount numeric, _budget uuid, _cat uuid, _tag text)
returns uuid
language plpgsql as $$
declare _id uuid;
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub', _employee, 'role', 'authenticated')::text, true);
  set local role authenticated;
  insert into public.finance_requests
    (type, title, justification, requester_id, finance_category_id, budget_id,
     amount, expense_date, priority, status)
  values ('reimbursement', 'ZZ claim ' || _tag, 'ZZ business purpose', _employee,
          _cat, _budget, _amount, current_date - 1, 'medium', 'draft')
  returning id into _id;
  reset role;
  return _id;
end;
$$;

do $$
declare
  admin_id uuid; employee uuid; other_emp uuid;
  fin_staff uuid; fin_mgr uuid; accountant uuid; accountant2 uuid;
  cat_id uuid; budget uuid; bank uuid; small uuid;
  claim_a uuid; claim_b uuid; pay uuid; pay2 uuid;
  ceiling numeric; reserved numeric; spent numeric; available numeric;
  amt numeric; bal numeric; due numeric; pending numeric; prep numeric;
  n integer; txt text;
  tag text := left(replace(gen_random_uuid()::text, '-', ''), 8);
begin
  select id into admin_id from public.profiles where role='admin' and status='active' limit 1;

  employee   := pg_temp.hire('Claimant',    'Cashier');
  other_emp  := pg_temp.hire('Other',       'Cashier');
  fin_staff  := pg_temp.hire('Fin Staff',   'Finance Staff');
  fin_mgr    := pg_temp.hire('Fin Manager', 'Finance Manager');
  accountant := pg_temp.hire('Bookkeeper',  'Accountant');
  accountant2:= pg_temp.hire('Bookkeeper2', 'Accountant');

  select id into cat_id from public.finance_categories where kind='expense' and is_active limit 1;
  perform pg_temp.acts_as(fin_staff); set local role authenticated;
  insert into public.budgets (name, finance_category_id, amount, fiscal_year)
  values ('ZZ Reimb Budget ' || tag, cat_id, 10000, extract(year from current_date)::integer)
  returning id into budget;
  reset role;
  perform pg_temp.acts_as(fin_mgr); set local role authenticated;
  perform public.review_budget(budget, true, 'fixture');
  reset role;

  perform pg_temp.acts_as(accountant); set local role authenticated;
  insert into public.treasury_accounts (name, account_type, opening_balance, opening_balance_as_of)
  values ('ZZ Reimb Bank ' || tag, 'bank', 20000, current_date) returning id into bank;
  insert into public.treasury_accounts (name, account_type, opening_balance, opening_balance_as_of)
  values ('ZZ Petty ' || tag, 'cash', 100, current_date) returning id into small;
  reset role;

  -- ======================================================================
  -- 1. One reimbursement, one reservation source
  -- ======================================================================
  claim_a := pg_temp.claim(employee, 1300, budget, cat_id, 'a' || tag);
  reset role;

  select bs.amount, bs.reserved, bs.spent, bs.remaining
    into ceiling, reserved, spent, available
    from public.budget_status bs where bs.id = budget;
  if reserved <> 0 or spent <> 0 or available <> 10000 then
    raise exception 'FAIL 1a a draft claim moved the budget: reserved % spent % available %',
      reserved, spent, available;
  end if;
  raise notice 'PASS  1a a drafted claim reserves nothing';

  -- Submitted, then reviewed. Neither reserves.
  perform pg_temp.acts_as(employee); set local role authenticated;
  perform public.transition_finance_request(claim_a, 'pending_validation', null, null, null);
  reset role;
  select bs.reserved into reserved from public.budget_status bs where bs.id = budget;
  if reserved <> 0 then raise exception 'FAIL 1b submitting reserved %', reserved; end if;
  raise notice 'PASS  1b submitting reserves nothing';

  perform pg_temp.acts_as(fin_staff); set local role authenticated;
  perform public.transition_finance_request(claim_a, 'pending_approval', 'ZZ reviewed', null, null);
  reset role;
  select bs.reserved into reserved from public.budget_status bs where bs.id = budget;
  if reserved <> 0 then raise exception 'FAIL 1c Finance Staff review reserved %', reserved; end if;
  raise notice 'PASS  1c Finance Staff review reserves nothing';

  -- Approval is what reserves.
  perform pg_temp.acts_as(fin_mgr); set local role authenticated;
  perform public.transition_finance_request(claim_a, 'approved', 'ZZ approved', null, null);
  reset role;
  select bs.reserved, bs.spent, bs.remaining into reserved, spent, available
    from public.budget_status bs where bs.id = budget;
  if reserved <> 1300 or spent <> 0 or available <> 8700 then
    raise exception 'FAIL 1d after approval reserved % spent % available %, expected 1300/0/8700',
      reserved, spent, available;
  end if;
  raise notice 'PASS  1d approval reserves the claim, and only approval';

  -- Counted once. The reimbursement lives in finance_requests and nowhere
  -- else, so there is no second table for it to be reserved from.
  select count(*)::integer into n from information_schema.tables
   where table_schema='public' and table_name in ('employee_reimbursements','reimbursements');
  if n <> 0 then
    raise exception 'FAIL 1e a second reimbursement table exists -- two reservation sources';
  end if;
  raise notice 'PASS  1e there is one reimbursement domain, so one reservation source';

  -- ======================================================================
  -- 2. Who may do what to the claim
  -- ======================================================================
  perform pg_temp.acts_as(other_emp); set local role authenticated;
  begin
    insert into public.finance_requests
      (type, title, requester_id, amount, priority, status)
    values ('reimbursement', 'ZZ not mine', employee, 500, 'medium', 'draft');
    raise exception 'FAIL 2a an employee filed a claim for somebody else';
  exception when insufficient_privilege then
    raise notice 'PASS  2a an employee cannot file a claim in another employee''s name';
  end;
  reset role;

  perform pg_temp.acts_as(employee); set local role authenticated;
  update public.finance_requests set amount = 9999 where id = claim_a;
  if found then raise exception 'FAIL 2b the employee edited an approved claim'; end if;
  raise notice 'PASS  2b an approved claim is no longer the employee''s to edit';
  reset role;

  perform pg_temp.acts_as(fin_staff); set local role authenticated;
  begin
    perform public.transition_finance_request(claim_a, 'approved', 'ZZ me too', null, null);
    raise exception 'FAIL 2c Finance Staff approved a claim';
  exception when insufficient_privilege or check_violation then
    raise notice 'PASS  2c Finance Staff review, and do not approve';
  end;
  reset role;

  -- ======================================================================
  -- 3. Preparing and approving a payment move nothing
  -- ======================================================================
  select v.balance_due, v.pending_payment_amount, v.available_to_prepare
    into due, pending, prep from public.reimbursement_status v where v.id = claim_a;
  if due <> 1300 or pending <> 0 or prep <> 1300 then
    raise exception 'FAIL 3a due % pending % available %, expected 1300/0/1300', due, pending, prep;
  end if;
  raise notice 'PASS  3a an approved claim owes its whole amount';

  perform pg_temp.acts_as(accountant); set local role authenticated;
  select public.create_reimbursement_payment(claim_a, bank, 800, 'bank_transfer', 'ZZ part', true)
    into pay;
  reset role;

  select v.balance_due, v.pending_payment_amount, v.available_to_prepare
    into due, pending, prep from public.reimbursement_status v where v.id = claim_a;
  select bs.reserved, bs.spent into reserved, spent from public.budget_status bs where bs.id = budget;
  select t.balance into bal from public.treasury_account_status t where t.id = bank;
  if due <> 1300 or pending <> 800 or prep <> 500 then
    raise exception 'FAIL 3b due % pending % available %, expected 1300/800/500', due, pending, prep;
  end if;
  if reserved <> 1300 or spent <> 0 or bal <> 20000 then
    raise exception 'FAIL 3b preparing moved something: reserved % spent % bank %',
      reserved, spent, bal;
  end if;
  raise notice 'PASS  3b preparing claims the money without paying or reserving it again';

  perform pg_temp.acts_as(fin_mgr); set local role authenticated;
  perform public.transition_reimbursement_payment(pay, 'approved', null, null, null);
  reset role;
  select bs.reserved, bs.spent into reserved, spent from public.budget_status bs where bs.id = budget;
  select t.balance into bal from public.treasury_account_status t where t.id = bank;
  if reserved <> 1300 or spent <> 0 or bal <> 20000 then
    raise exception 'FAIL 3c APPROVAL moved money: reserved % spent % bank %', reserved, spent, bal;
  end if;
  raise notice 'PASS  3c approving authorises the payment and moves nothing';

  -- ======================================================================
  -- 4. Recording the payment is what spends
  -- ======================================================================
  perform pg_temp.acts_as(accountant); set local role authenticated;
  perform public.transition_reimbursement_payment(
    pay, 'paid', null, 'RTRF-A-' || tag, date '2026-09-05');
  reset role;

  select bs.reserved, bs.spent, bs.remaining into reserved, spent, available
    from public.budget_status bs where bs.id = budget;
  select t.balance into bal from public.treasury_account_status t where t.id = bank;
  if reserved <> 500 then raise exception 'FAIL 4a reserved is %, expected 500', reserved; end if;
  if spent <> 800 then raise exception 'FAIL 4a spent is %, expected 800', spent; end if;
  if available <> 8700 then
    raise exception 'FAIL 4a available moved to %, and it must stay 8700', available;
  end if;
  if bal <> 19200 then raise exception 'FAIL 4a the bank is %, expected 19200', bal; end if;
  raise notice 'PASS  4a reserved 1300->500, spent 0->800, available holds at 8700';

  select count(*)::integer into n from public.treasury_movements
   where source_type = 'reimbursement_payment' and source_id = pay;
  if n <> 1 then raise exception 'FAIL 4b one payment produced % movements', n; end if;
  select occurred_on into txt from public.treasury_movements
   where source_type = 'reimbursement_payment' and source_id = pay;
  if txt::date <> date '2026-09-05' then
    raise exception 'FAIL 4b the movement is dated %, expected the date given', txt;
  end if;
  raise notice 'PASS  4b exactly one movement, carrying the date it was given';

  -- The rest, and the claim reads as paid without its workflow status moving.
  perform pg_temp.acts_as(accountant); set local role authenticated;
  select public.create_reimbursement_payment(claim_a, bank, 500, 'bank_transfer', 'ZZ rest', true)
    into pay2;
  reset role;
  perform pg_temp.acts_as(fin_mgr); set local role authenticated;
  perform public.transition_reimbursement_payment(pay2, 'approved', null, null, null);
  reset role;
  perform pg_temp.acts_as(accountant); set local role authenticated;
  perform public.transition_reimbursement_payment(
    pay2, 'paid', null, 'RTRF-B-' || tag, date '2026-09-05');
  reset role;

  select v.balance_due, v.settlement_state into due, txt
    from public.reimbursement_status v where v.id = claim_a;
  if due <> 0 or txt <> 'paid' then
    raise exception 'FAIL 4c balance % state %, expected 0/paid', due, txt;
  end if;
  select status into txt from public.finance_requests where id = claim_a;
  if txt <> 'approved' then
    raise exception 'FAIL 4c the workflow status changed to % -- paying does not un-approve', txt;
  end if;
  raise notice 'PASS  4c the claim reads Paid while its workflow status stays approved';

  select bs.reserved, bs.spent, bs.remaining into reserved, spent, available
    from public.budget_status bs where bs.id = budget;
  if reserved <> 0 or spent <> 1300 or available <> 8700 then
    raise exception 'FAIL 4d reserved % spent % available %, expected 0/1300/8700',
      reserved, spent, available;
  end if;
  raise notice 'PASS  4d fully paid: reserved 0, spent 1300, available still 8700';

  -- ======================================================================
  -- 5. Over-instruction, and the guards around it
  -- ======================================================================
  claim_b := pg_temp.claim(employee, 1000, budget, cat_id, 'b' || tag);
  reset role;
  perform pg_temp.acts_as(employee); set local role authenticated;
  perform public.transition_finance_request(claim_b, 'pending_validation', null, null, null);
  reset role;
  perform pg_temp.acts_as(fin_staff); set local role authenticated;
  perform public.transition_finance_request(claim_b, 'pending_approval', 'ZZ ok', null, null);
  reset role;
  perform pg_temp.acts_as(fin_mgr); set local role authenticated;
  perform public.transition_finance_request(claim_b, 'approved', 'ZZ approved', null, null);
  reset role;

  perform pg_temp.acts_as(accountant); set local role authenticated;
  select public.create_reimbursement_payment(claim_b, bank, 800, 'bank_transfer', null, true)
    into pay;
  begin
    perform public.create_reimbursement_payment(claim_b, bank, 600, 'bank_transfer', null, false);
    raise exception 'FAIL 5a 600 was accepted against 200 available';
  exception when check_violation then
    if sqlerrm not like '%200.00 still available%' then
      raise exception 'FAIL 5a wrong message: %', sqlerrm;
    end if;
    raise notice 'PASS  5a cumulative instructions cannot exceed the claim';
  end;
  -- Deliberately drawn on the account holding 100, so section 7 can prove an
  -- underfunded account refuses at the moment of payment.
  select public.create_reimbursement_payment(claim_b, small, 200, 'cash', null, true)
    into pay2;
  begin
    perform public.create_reimbursement_payment(claim_b, bank, 1, 'bank_transfer', null, false);
    raise exception 'FAIL 5b an instruction was accepted with nothing available';
  exception when check_violation then
    if sqlerrm <> 'This reimbursement is already fully covered by payment instructions.' then
      raise exception 'FAIL 5b wrong message: %', sqlerrm;
    end if;
    raise notice 'PASS  5b and nothing more once the claim is fully covered';
  end;
  reset role;

  -- ======================================================================
  -- 6. Maker and checker
  -- ======================================================================
  perform pg_temp.acts_as(accountant); set local role authenticated;
  begin
    perform public.transition_reimbursement_payment(pay, 'approved', null, null, null);
    raise exception 'FAIL 6a the preparer approved their own payment';
  exception when insufficient_privilege then
    raise notice 'PASS  6a the person who prepared a payment cannot approve it';
  end;
  reset role;

  perform pg_temp.acts_as(fin_mgr); set local role authenticated;
  begin
    perform public.transition_reimbursement_payment(
      pay, 'paid', null, 'NOPE-' || tag, date '2026-09-05');
    raise exception 'FAIL 6b the Finance Manager recorded a payment';
  exception when insufficient_privilege then
    raise notice 'PASS  6b the checker approves, and does not record the payment';
  end;
  perform public.transition_reimbursement_payment(pay, 'approved', null, null, null);
  reset role;

  perform pg_temp.acts_as(accountant); set local role authenticated;
  begin
    perform public.transition_reimbursement_payment(pay, 'paid', null, null, date '2026-09-05');
    raise exception 'FAIL 6c a payment was recorded with no reference';
  exception when check_violation then
    raise notice 'PASS  6c recording requires the bank reference';
  end;
  begin
    perform public.transition_reimbursement_payment(pay, 'paid', null, 'REF-' || tag, null);
    raise exception 'FAIL 6d a payment was recorded with no date';
  exception when check_violation then
    if sqlerrm <> 'Record the date this payment was made.' then
      raise exception 'FAIL 6d wrong refusal: %', sqlerrm;
    end if;
    raise notice 'PASS  6d and the day it was made, never guessed from a UTC clock';
  end;
  reset role;

  -- ======================================================================
  -- 7. Funds, permanence, and withdrawal
  -- ======================================================================
  -- pay2 is the 200 drawn on the account holding 100.
  perform pg_temp.acts_as(fin_mgr); set local role authenticated;
  perform public.transition_reimbursement_payment(pay2, 'approved', null, null, null);
  reset role;

  perform pg_temp.acts_as(accountant); set local role authenticated;
  begin
    perform public.transition_reimbursement_payment(
      pay2, 'paid', null, 'SHORT-' || tag, date '2026-09-05');
    raise exception 'FAIL 7a an account holding 100 paid out 200';
  exception when check_violation then
    if sqlerrm <> 'This account does not have enough available funds for this payment.' then
      raise exception 'FAIL 7a wrong message: %', sqlerrm;
    end if;
    raise notice 'PASS  7a an account cannot be overdrawn';
  end;
  reset role;

  -- A paid claim cannot be withdrawn: F7 has no reversal, so withdrawing
  -- would hide the claim and leave the money gone.
  perform pg_temp.acts_as(fin_mgr); set local role authenticated;
  begin
    perform public.transition_finance_request(claim_a, 'rejected', 'ZZ changed my mind', null, null);
    raise exception 'FAIL 7b a paid reimbursement was withdrawn';
  exception when check_violation then
    if sqlerrm not like '%already been paid%' then
      raise exception 'FAIL 7b wrong refusal: %', sqlerrm;
    end if;
    raise notice 'PASS  7b a paid reimbursement cannot be withdrawn';
  end;
  begin
    perform public.transition_finance_request(claim_b, 'rejected', 'ZZ changed my mind', null, null);
    raise exception 'FAIL 7c a reimbursement with live instructions was withdrawn';
  exception when check_violation then
    if sqlerrm not like '%pending payment instructions%' then
      raise exception 'FAIL 7c wrong refusal: %', sqlerrm;
    end if;
    raise notice 'PASS  7c nor one with payment instructions still in flight';
  end;
  reset role;

  -- A completed payment is permanent.
  perform pg_temp.acts_as(accountant); set local role authenticated;
  begin
    update public.reimbursement_payments set amount = 1
     where finance_request_id = claim_a and status = 'paid';
    raise exception 'FAIL 7d a completed payment was edited';
  exception when insufficient_privilege then
    raise notice 'PASS  7d a completed reimbursement payment cannot be changed';
  end;
  -- Two layers refuse this, and either is enough: there is no DELETE policy on
  -- the table, so RLS removes nothing silently, and the delete guard would
  -- raise if a row ever reached it. The claim is that the payment survives.
  begin
    delete from public.reimbursement_payments where finance_request_id = claim_a and status = 'paid';
  exception when insufficient_privilege then null;
  end;
  reset role;

  select count(*)::integer into n from public.reimbursement_payments
   where finance_request_id = claim_a and status = 'paid';
  if n <> 2 then raise exception 'FAIL 7e % completed payments survive, expected 2', n; end if;
  raise notice 'PASS  7e nor deleted -- both completed payments are still there';

  -- ======================================================================
  -- 8. Who may look
  -- ======================================================================
  perform pg_temp.acts_as(employee); set local role authenticated;
  select count(*)::integer into n from public.reimbursement_payments;
  if n <> 0 then raise exception 'FAIL 8a the claimant read the payment table'; end if;
  -- But they do see their own claim, and its payment state.
  select count(*)::integer into n from public.get_reimbursements() r where r.id = claim_a;
  if n <> 1 then raise exception 'FAIL 8a the claimant cannot see their own claim'; end if;
  reset role;
  raise notice 'PASS  8a the claimant sees their claim and not the treasury behind it';

  perform pg_temp.acts_as(other_emp); set local role authenticated;
  select count(*)::integer into n from public.get_reimbursements() r where r.id = claim_a;
  if n <> 0 then raise exception 'FAIL 8b an employee read another employee''s claim'; end if;
  reset role;
  raise notice 'PASS  8b and nobody else''s';

  raise notice '--------------------------------------------------';
  raise notice 'reimbursement_payment_rls: all checks passed';
end $$;

rollback;
