-- F8: the accounting mirror, and everything it must not be able to do.
--
-- The posting source is the treasury movement, because that is the one row
-- JMAC writes when money has actually moved: inside the authoritative
-- transition functions, at the final state, unique on (source_type, source_id).
-- Everything F8 claims follows from that choice, so these prove it.
--
-- The reimbursement path is driven end to end through its real workflow. The
-- other three source types are exercised by writing the treasury movement the
-- way their workflows write it -- that the workflows write it only at the final
-- state is proved in their own suites (supplier_payment_rls,
-- payroll_finance_rls, treasury_settlement_rls) and is not re-litigated here.
--
-- Run:
--   docker exec -i supabase_db_harmony-suite psql -U postgres -d postgres \
--     -v ON_ERROR_STOP=1 -f - < supabase/tests/accounting_journal_rls.sql
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
  admin_id uuid; employee uuid; fin_staff uuid; fin_mgr uuid; accountant uuid; outsider uuid;
  cat_id uuid; budget uuid; bank uuid; bank_gl uuid;
  claim uuid; pay uuid; entry uuid; again uuid; line_id uuid;
  n integer; txt text; num numeric; dr numeric; cr numeric;
  movements_before integer; reserved_before numeric; spent_before numeric;
  reserved_after numeric; spent_after numeric;
  mv uuid; other_entry uuid; running numeric;
  tag text := left(replace(gen_random_uuid()::text, '-', ''), 8);
begin
  select id into admin_id from public.profiles where role='admin' and status='active' limit 1;
  employee   := pg_temp.hire('Claimant',    'Cashier');
  outsider   := pg_temp.hire('Outsider',    'Cashier');
  fin_staff  := pg_temp.hire('Fin Staff',   'Finance Staff');
  fin_mgr    := pg_temp.hire('Fin Manager', 'Finance Manager');
  accountant := pg_temp.hire('Bookkeeper',  'Accountant');

  select id into cat_id from public.finance_categories where kind='expense' and is_active limit 1;
  perform pg_temp.acts_as(fin_staff); set local role authenticated;
  insert into public.budgets (name, finance_category_id, amount, fiscal_year)
  values ('ZZ F8 Budget ' || tag, cat_id, 50000, extract(year from current_date)::integer)
  returning id into budget;
  reset role;
  perform pg_temp.acts_as(fin_mgr); set local role authenticated;
  perform public.review_budget(budget, true, 'fixture');
  reset role;

  perform pg_temp.acts_as(accountant); set local role authenticated;
  insert into public.treasury_accounts (name, account_type, opening_balance, opening_balance_as_of)
  values ('ZZ F8 Bank ' || tag, 'bank', 50000, current_date) returning id into bank;
  reset role;

  -- ======================================================================
  -- Treasury account mapping
  -- ======================================================================
  select finance_account_id into bank_gl from public.treasury_accounts where id = bank;
  if bank_gl is null then
    raise exception 'FAIL a new treasury account was not mapped to a GL account';
  end if;
  select account_type into txt from public.finance_accounts where id = bank_gl;
  if txt <> 'asset' then raise exception 'FAIL the bank GL account is a %', txt; end if;
  raise notice 'PASS  12a a treasury account is mapped to a GL asset account automatically';

  select count(*)::integer into movements_before from public.treasury_movements;
  select coalesce(sum(reserved),0), coalesce(sum(spent),0)
    into reserved_before, spent_before from public.budget_status;

  -- ======================================================================
  -- 9. Nothing is accounted for before the money moves
  -- ======================================================================
  perform pg_temp.acts_as(employee); set local role authenticated;
  insert into public.finance_requests
    (type, title, justification, requester_id, amount, expense_date, priority, status)
  values ('reimbursement', 'ZZ claim ' || tag, 'ZZ purpose', employee, 1000,
          current_date - 1, 'medium', 'draft')
  returning id into claim;
  perform public.transition_finance_request(claim, 'pending_validation', null);
  reset role;

  perform pg_temp.acts_as(fin_staff); set local role authenticated;
  update public.finance_requests set budget_id = budget, finance_category_id = cat_id
   where id = claim;
  perform public.transition_finance_request(claim, 'pending_approval', null);
  reset role;
  perform pg_temp.acts_as(fin_mgr); set local role authenticated;
  perform public.transition_finance_request(claim, 'approved', null);
  reset role;

  select count(*)::integer into n from public.journal_entries;
  if n <> 0 then raise exception 'FAIL 9 an approved-but-unpaid claim produced % journals', n; end if;

  perform pg_temp.acts_as(accountant); set local role authenticated;
  select public.create_reimbursement_payment(claim, bank, 1000, 'bank_transfer', null, true)
    into pay;
  reset role;
  select count(*)::integer into n from public.journal_entries;
  if n <> 0 then raise exception 'FAIL 9 a payment awaiting approval produced % journals', n; end if;

  perform pg_temp.acts_as(fin_mgr); set local role authenticated;
  perform public.transition_reimbursement_payment(pay, 'approved', null, null, null);
  reset role;
  select count(*)::integer into n from public.journal_entries;
  if n <> 0 then raise exception 'FAIL 9 an approved-but-unsent payment produced % journals', n; end if;
  raise notice 'PASS  9/13/16/20 nothing is accounted for until the money actually moves';

  -- ======================================================================
  -- 10/11/12. Paid: exactly one balanced journal, at the authoritative amount
  -- ======================================================================
  perform pg_temp.acts_as(accountant); set local role authenticated;
  perform public.transition_reimbursement_payment(pay, 'paid', null, 'ZZ-REF-' || tag, current_date);
  reset role;

  select count(*)::integer into n from public.journal_entries
   where source_type = 'reimbursement_payment' and source_id = pay;
  if n <> 1 then raise exception 'FAIL 10 a paid reimbursement produced % journals', n; end if;
  select id into entry from public.journal_entries where source_id = pay;
  raise notice 'PASS  10 a paid reimbursement produces exactly one journal';

  select coalesce(sum(debit),0), coalesce(sum(credit),0) into dr, cr
  from public.journal_entry_lines where journal_entry_id = entry;
  if dr <> cr then raise exception 'FAIL 10 the journal does not balance: % vs %', dr, cr; end if;
  if dr <> 1000 then raise exception 'FAIL 11 the journal is for % not the paid 1000', dr; end if;
  raise notice 'PASS  11 balanced, and for the amount the payment actually paid';

  select count(*)::integer into n from public.journal_entry_lines l
   join public.finance_accounts a on a.id = l.account_id
   where l.journal_entry_id = entry and a.account_code = '5100' and l.debit = 1000;
  if n <> 1 then raise exception 'FAIL 10 the expense side is wrong'; end if;
  select count(*)::integer into n from public.journal_entry_lines
   where journal_entry_id = entry and account_id = bank_gl and credit = 1000;
  if n <> 1 then raise exception 'FAIL 12 the bank credit is not the mapped treasury account'; end if;
  raise notice 'PASS  12 Dr Reimbursement Expense, Cr the mapped treasury bank account';

  -- Provenance, in business terms.
  select source_reference into txt from public.journal_entries where id = entry;
  if txt is null or txt not like 'RV-%' then
    raise exception 'FAIL the journal does not carry the payment reference: %', txt; end if;
  -- And it is dated by the business date the payment carried, not by a clock.
  select count(*)::integer into n from public.journal_entries e
   join public.reimbursement_payments p on p.id = e.source_id
   where e.id = entry and e.posting_date = p.payment_date;
  if n <> 1 then raise exception 'FAIL the journal is not dated by the payment date'; end if;
  raise notice 'PASS  29a the journal carries the payment number and its business date';

  -- ======================================================================
  -- 5/33. Re-delivery of the same event does not post twice
  -- ======================================================================
  again := public.post_treasury_movement_journal(
    (select id from public.treasury_movements where source_id = pay));
  if again is distinct from entry then
    raise exception 'FAIL 5 re-posting produced a different journal'; end if;
  select count(*)::integer into n from public.journal_entries where source_id = pay;
  if n <> 1 then raise exception 'FAIL 33 re-posting produced % journals', n; end if;
  select coalesce(sum(debit),0) into dr from public.journal_entry_lines where journal_entry_id = entry;
  if dr <> 1000 then raise exception 'FAIL 33 re-posting doubled the entry to %', dr; end if;
  raise notice 'PASS  5/33 a repeated event returns the same journal and doubles nothing';

  -- ======================================================================
  -- 21/22/23. Accounting moved nothing
  -- ======================================================================
  select count(*)::integer into n from public.treasury_movements;
  if n <> movements_before + 1 then
    raise exception 'FAIL 21 posting created % extra treasury movements', n - movements_before - 1;
  end if;
  raise notice 'PASS  21 posting creates no treasury movement of its own';

  select status into txt from public.reimbursement_payments where id = pay;
  if txt <> 'paid' then raise exception 'FAIL 22 the payment status is now %', txt; end if;
  select status into txt from public.finance_requests where id = claim;
  if txt <> 'approved' then raise exception 'FAIL 22 the claim status is now %', txt; end if;
  raise notice 'PASS  22 and mutates neither the payment nor the claim';

  -- Isolated deliberately. Approving the claim reserved budget and paying it
  -- moved that reservation into spent -- both are the workflow's doing, and
  -- comparing against a snapshot taken before either would be measuring the
  -- payment, not the accounting. So the baseline is taken with the money
  -- already paid, and the accounting is then asked to run again.
  select coalesce(sum(reserved),0), coalesce(sum(spent),0)
    into reserved_before, spent_before from public.budget_status;
  perform public.post_treasury_movement_journal(
    (select id from public.treasury_movements where source_id = pay));
  select coalesce(sum(reserved),0), coalesce(sum(spent),0)
    into reserved_after, spent_after from public.budget_status;

  if reserved_after <> reserved_before or spent_after <> spent_before then
    raise exception 'FAIL 23 accounting moved reserved by % and spent by %',
      reserved_after - reserved_before, spent_after - spent_before;
  end if;
  raise notice 'PASS  23 and changes no budget figure of its own';

  -- ======================================================================
  -- 6/7/29. A posted journal never changes
  -- ======================================================================
  begin
    update public.journal_entries set description = 'ZZ rewritten' where id = entry;
    raise exception 'FAIL 6 a posted journal was edited';
  exception when insufficient_privilege then
    raise notice 'PASS  6 a posted journal cannot be edited';
  end;

  begin
    update public.journal_entries set source_id = gen_random_uuid() where id = entry;
    raise exception 'FAIL 29 a posted journal''s source was changed';
  exception when insufficient_privilege then
    raise notice 'PASS  29 nor can what it came from be changed';
  end;

  begin
    delete from public.journal_entries where id = entry;
    raise exception 'FAIL 6 a posted journal was deleted';
  exception when insufficient_privilege then
    raise notice 'PASS  6b nor deleted';
  end;

  select id into line_id from public.journal_entry_lines where journal_entry_id = entry limit 1;
  begin
    update public.journal_entry_lines set debit = 9999 where id = line_id;
    raise exception 'FAIL 7 a posted line was edited';
  exception when insufficient_privilege then
    raise notice 'PASS  7 posted lines cannot be edited';
  end;
  begin
    delete from public.journal_entry_lines where id = line_id;
    raise exception 'FAIL 7 a posted line was deleted';
  exception when insufficient_privilege then
    raise notice 'PASS  7b nor deleted';
  end;

  -- ======================================================================
  -- 8. An account with history is retired, not removed
  -- ======================================================================
  begin
    delete from public.finance_accounts where id = bank_gl;
    raise exception 'FAIL 8 an account with posted journals was deleted';
  exception when insufficient_privilege then
    raise notice 'PASS  8 an account with posted entries cannot be deleted';
  end;

  -- ======================================================================
  -- 1/2/3/4. The double-entry rules themselves
  -- ======================================================================
  insert into public.journal_entries (posting_date, description, source_type, source_id)
  values (current_date, 'ZZ probe', 'supplier_payment', gen_random_uuid())
  returning id into other_entry;

  begin
    insert into public.journal_entry_lines (journal_entry_id, account_id, debit, credit, line_no)
    values (other_entry, bank_gl, 100, 0, 1),
           (other_entry, bank_gl, 0, 90, 2);
    raise exception 'FAIL 2 an unbalanced journal was accepted';
  exception when check_violation then
    raise notice 'PASS  2 an unbalanced journal is refused';
  end;

  begin
    insert into public.journal_entry_lines (journal_entry_id, account_id, debit, credit, line_no)
    values (other_entry, bank_gl, 100, 100, 1);
    raise exception 'FAIL 3 a line with both a debit and a credit was accepted';
  exception when check_violation then
    raise notice 'PASS  3 a line cannot be both a debit and a credit';
  end;

  begin
    insert into public.journal_entry_lines (journal_entry_id, account_id, debit, credit, line_no)
    values (other_entry, bank_gl, 0, 0, 1);
    raise exception 'FAIL 4 a line with no amount was accepted';
  exception when check_violation then
    raise notice 'PASS  4 a line with no amount at all is refused';
  end;

  begin
    insert into public.journal_entry_lines (journal_entry_id, account_id, debit, credit, line_no)
    values (other_entry, bank_gl, -50, 0, 1);
    raise exception 'FAIL 4 a negative amount was accepted';
  exception when check_violation then
    raise notice 'PASS  4b and so is a negative one';
  end;

  begin
    insert into public.journal_entry_lines (journal_entry_id, account_id, debit, credit, line_no)
    values (other_entry, bank_gl, 100, 0, 1);
    raise exception 'FAIL 1 a one-sided single-line journal was accepted';
  exception when check_violation then
    raise notice 'PASS  1a a journal cannot balance on one line';
  end;

  insert into public.journal_entry_lines (journal_entry_id, account_id, debit, credit, line_no)
  select other_entry, a.id, v.dr, v.cr, v.ln
  from (values (100::numeric, 0::numeric, 1), (0::numeric, 100::numeric, 2)) v(dr, cr, ln)
  join public.finance_accounts a on a.account_code = case when v.ln = 1 then '5000' else '1100' end;
  raise notice 'PASS  1 a balanced two-line journal posts';

  -- ======================================================================
  -- 14/17/19. The rest of the posting matrix
  -- ======================================================================
  -- Written the way each workflow writes it, at the moment its money moves.
  insert into public.treasury_movements
    (treasury_account_id, direction, amount, source_type, source_id, occurred_on, reference)
  values (bank, 'out', 1300, 'supplier_payment', gen_random_uuid(), current_date, 'ZZ-PV')
  returning id into mv;
  select count(*)::integer into n from public.journal_entry_lines l
   join public.journal_entries e on e.id = l.journal_entry_id
   join public.finance_accounts a on a.id = l.account_id
   where e.treasury_movement_id = mv and a.account_code = '5000' and l.debit = 1300;
  if n <> 1 then raise exception 'FAIL 14 a supplier payment did not post to supplier expense'; end if;
  raise notice 'PASS  14 a completed supplier payment posts Dr Supplier Expense, Cr bank';

  insert into public.treasury_movements
    (treasury_account_id, direction, amount, source_type, source_id, occurred_on, reference)
  values (bank, 'out', 5000, 'payroll_disbursement', gen_random_uuid(), current_date, 'ZZ-PD')
  returning id into mv;
  select count(*)::integer into n from public.journal_entry_lines l
   join public.journal_entries e on e.id = l.journal_entry_id
   join public.finance_accounts a on a.id = l.account_id
   where e.treasury_movement_id = mv and a.account_code = '5200' and l.debit = 5000;
  if n <> 1 then raise exception 'FAIL 17 a payroll disbursement did not post to payroll expense'; end if;
  select count(*)::integer into n from public.journal_entry_lines l
   where l.journal_entry_id = (select id from public.journal_entries where treasury_movement_id = mv);
  if n <> 2 then raise exception 'FAIL 17 the payroll journal has % lines, not one aggregate pair', n; end if;
  raise notice 'PASS  17/18 one aggregate payroll journal -- no per-employee salary lines exist to leak';

  -- A collection: bank rises by what landed, revenue is the gross, and the
  -- difference is the fee the settlement itself recorded.
  insert into public.treasury_movements
    (treasury_account_id, direction, amount, source_type, source_id, occurred_on, reference)
  values (bank, 'in', 2000, 'collection_settlement', gen_random_uuid(), current_date, 'ZZ-CS')
  returning id into mv;
  select id into other_entry from public.journal_entries where treasury_movement_id = mv;
  select count(*)::integer into n from public.journal_entry_lines l
   join public.finance_accounts a on a.id = l.account_id
   where l.journal_entry_id = other_entry and a.account_code = '4000' and l.credit = 2000;
  if n <> 1 then raise exception 'FAIL 19 a collection did not credit sales revenue'; end if;
  select count(*)::integer into n from public.journal_entry_lines
   where journal_entry_id = other_entry and account_id = bank_gl and debit = 2000;
  if n <> 1 then raise exception 'FAIL 19 a collection did not debit the bank'; end if;
  raise notice 'PASS  19 a settled collection posts Dr bank, Cr Sales Revenue';

  -- ======================================================================
  -- 24/25/26/27/28. The reports are the ledger, not a second set of numbers
  -- ======================================================================
  select coalesce(sum(debit),0), coalesce(sum(credit),0) into dr, cr
  from public.journal_entry_lines;
  if dr <> cr then raise exception 'FAIL 24 the ledger does not balance: % vs %', dr, cr; end if;
  raise notice 'PASS  24 every posted line together still balances';

  select coalesce(sum(debit_balance),0), coalesce(sum(credit_balance),0) into dr, cr
  from public.trial_balance;
  if dr <> cr then raise exception 'FAIL 25 the trial balance does not balance: % vs %', dr, cr; end if;
  raise notice 'PASS  25 and the trial balance balances';

  -- The ledger's running balance is arithmetic over the same lines, so it is
  -- checked against them rather than against a stored figure.
  select coalesce(sum(debit - credit), 0) into running
  from public.general_ledger_lines where account_id = bank_gl;
  select coalesce(sum(debit_balance - credit_balance), 0) into num
  from public.trial_balance where account_id = bank_gl;
  if running <> num then
    raise exception 'FAIL 26 the ledger and the trial balance disagree: % vs %', running, num; end if;
  raise notice 'PASS  26 the running balance agrees with the trial balance for that account';

  select coalesce(sum(l.debit - l.credit), 0) into num
  from public.general_ledger_lines l where l.account_type = 'expense';
  select coalesce(sum(l.debit - l.credit), 0) into running
  from public.journal_entry_lines l
   join public.finance_accounts a on a.id = l.account_id where a.account_type = 'expense';
  if num <> running then raise exception 'FAIL 27 the expense summary is not the posted lines'; end if;
  raise notice 'PASS  27 the expense summary is exactly the posted expense lines';

  select coalesce(sum(l.credit - l.debit), 0) into num
  from public.general_ledger_lines l where l.account_type = 'revenue';
  if num <> 2000 then raise exception 'FAIL 28 revenue reads % not 2000', num; end if;
  raise notice 'PASS  28 the revenue summary is exactly the posted revenue lines';

  -- ======================================================================
  -- 30/31/32. Who may read it, and who may write it
  -- ======================================================================
  perform pg_temp.acts_as(accountant); set local role authenticated;
  select count(*)::integer into n from public.journal_entries;
  if n = 0 then raise exception 'FAIL 31 the Accountant cannot read the journal'; end if;
  select count(*)::integer into n from public.trial_balance;
  if n = 0 then raise exception 'FAIL 31 the Accountant cannot read the trial balance'; end if;
  raise notice 'PASS  31 the Accountant reads the journal, the ledger and the trial balance';

  begin
    insert into public.journal_entries (posting_date, description, source_type, source_id)
    values (current_date, 'ZZ invented', 'supplier_payment', gen_random_uuid());
    raise exception 'FAIL 30 an Accountant fabricated a journal entry';
  exception when insufficient_privilege then
    raise notice 'PASS  30 and cannot write one by hand -- there is no insert policy at all';
  end;

  begin
    perform public.post_treasury_movement_journal(mv);
    raise exception 'FAIL 30 the posting function was callable from a session';
  exception when insufficient_privilege then
    raise notice 'PASS  30b nor call the posting function directly';
  end;
  reset role;

  perform pg_temp.acts_as(fin_mgr); set local role authenticated;
  select count(*)::integer into n from public.journal_entries;
  if n = 0 then raise exception 'FAIL 31 the Finance Manager cannot read the journal'; end if;
  raise notice 'PASS  31b so does the Finance Manager';
  reset role;

  perform pg_temp.acts_as(fin_staff); set local role authenticated;
  select count(*)::integer into n from public.journal_entries;
  if n = 0 then raise exception 'FAIL 32 Finance Staff lost their finance read access'; end if;
  select count(*)::integer into n from public.payroll_records;
  if n <> 0 then raise exception 'FAIL 32 Finance Staff can read % payroll records', n; end if;
  select count(*)::integer into n from public.payroll_finance_items;
  if n <> 0 then raise exception 'FAIL 32 Finance Staff can read % salary lines', n; end if;
  raise notice 'PASS  32 Finance Staff see the ledger and still no salary detail';
  reset role;

  perform pg_temp.acts_as(outsider); set local role authenticated;
  select count(*)::integer into n from public.journal_entries;
  if n <> 0 then raise exception 'FAIL 32 an unrelated employee read % journal entries', n; end if;
  select count(*)::integer into n from public.journal_entry_lines;
  if n <> 0 then raise exception 'FAIL 32 an unrelated employee read % journal lines', n; end if;
  raise notice 'PASS  32b and an employee with no finance role reads none of it';

  -- The views are granted to `authenticated` as a role, so they are only as
  -- closed as security_invoker makes them. Asked separately from the tables
  -- because a view that reads past RLS still passes every check above.
  select count(*)::integer into n from public.general_ledger_lines;
  if n <> 0 then raise exception 'FAIL 32 the ledger view leaked % lines past RLS', n; end if;
  select count(*)::integer into n from public.trial_balance;
  if n <> 0 then raise exception 'FAIL 32 the trial balance view leaked % rows past RLS', n; end if;
  raise notice 'PASS  32c the ledger and trial balance views enforce it too, not just the tables';
  reset role;

  raise notice '--------------------------------------------------';
  raise notice 'accounting_journal_rls: all checks passed';
end $$;

rollback;
