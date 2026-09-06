-- F7 acceptance fix: correcting a reimbursement before it is submitted.
--
-- Acceptance found a Draft claim with no way to fix a typo in it. Submit,
-- Cancel and Close were the only choices, so a wrong amount had to be cancelled
-- and retyped as a second claim -- which is how a controlled test record becomes
-- two records.
--
-- Editing is the smallest thing that fixes it, and the whole risk is that
-- "editable" quietly means "editable by anyone, in any state, in any column".
-- So these are the claims:
--
--   the owner may correct their own Draft
--   nobody else may, not even another employee with a claim of their own
--   not after submission, and not in any later state
--   a correction changes what was asked for and nothing else
--   budget, category and vendor are never the requester's to write
--   status never moves by editing
--   no budget is reserved, no treasury movement, no payment, no approval row
--   a stale edit is refused rather than silently overwriting a newer one
--
-- Run:
--   docker exec -i supabase_db_harmony-suite psql -U postgres -d postgres \
--     -v ON_ERROR_STOP=1 -f - < supabase/tests/reimbursement_draft_edit_rls.sql
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

/** A Draft claim, filed the way My Requests files one. */
create or replace function pg_temp.claim(_employee uuid, _amount numeric, _tag text)
returns uuid
language plpgsql as $$
declare _id uuid;
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub', _employee, 'role', 'authenticated')::text, true);
  set local role authenticated;
  insert into public.finance_requests
    (type, title, description, justification, requester_id, amount,
     expense_date, priority, status)
  values ('reimbursement', 'ZZ claim ' || _tag, 'ZZ original details',
          'ZZ business purpose', _employee, _amount,
          current_date - 1, 'medium', 'draft')
  returning id into _id;
  reset role;
  return _id;
end;
$$;

do $$
declare
  admin_id uuid; employee uuid; other_emp uuid;
  fin_staff uuid; fin_mgr uuid;
  cat_id uuid; budget uuid; other_budget uuid;
  claim_a uuid; claim_b uuid; row_before public.finance_requests;
  updated public.finance_requests;
  stamp timestamptz; amt numeric; txt text; d date;
  n integer;
  reserved numeric; spent numeric;
  tag text := left(replace(gen_random_uuid()::text, '-', ''), 8);
begin
  select id into admin_id from public.profiles where role='admin' and status='active' limit 1;

  employee  := pg_temp.hire('Claimant',    'Cashier');
  other_emp := pg_temp.hire('Other',       'Cashier');
  fin_staff := pg_temp.hire('Fin Staff',   'Finance Staff');
  fin_mgr   := pg_temp.hire('Fin Manager', 'Finance Manager');

  select id into cat_id from public.finance_categories where kind='expense' and is_active limit 1;
  perform pg_temp.acts_as(fin_staff); set local role authenticated;
  insert into public.budgets (name, finance_category_id, amount, fiscal_year)
  values ('ZZ Edit Budget ' || tag, cat_id, 10000, extract(year from current_date)::integer)
  returning id into budget;
  insert into public.budgets (name, finance_category_id, amount, fiscal_year)
  values ('ZZ Other Budget ' || tag, cat_id, 10000, extract(year from current_date)::integer)
  returning id into other_budget;
  reset role;
  perform pg_temp.acts_as(fin_mgr); set local role authenticated;
  perform public.review_budget(budget, true, 'fixture');
  perform public.review_budget(other_budget, true, 'fixture');
  reset role;

  claim_a := pg_temp.claim(employee, 1000, 'a' || tag);

  -- ======================================================================
  -- 1. The owner corrects their own Draft
  -- ======================================================================
  perform pg_temp.acts_as(employee); set local role authenticated;

  select * into row_before from public.finance_requests where id = claim_a;

  updated := public.update_finance_request_draft(
    _request_id    => claim_a,
    _title         => 'ZZ corrected title',
    _amount        => 1250.50,
    _priority      => 'high',
    _description   => 'ZZ corrected details',
    _justification => 'ZZ corrected purpose',
    _expense_date  => current_date - 3);

  if updated.title <> 'ZZ corrected title' then
    raise exception 'FAIL 1a the title did not persist: %', updated.title; end if;
  if updated.amount <> 1250.50 then
    raise exception 'FAIL 1a the amount did not persist: %', updated.amount; end if;
  if updated.priority <> 'high' then
    raise exception 'FAIL 1a the priority did not persist: %', updated.priority; end if;
  if updated.description <> 'ZZ corrected details' then
    raise exception 'FAIL 1a the description did not persist'; end if;
  if updated.justification <> 'ZZ corrected purpose' then
    raise exception 'FAIL 1a the justification did not persist'; end if;
  if updated.expense_date <> current_date - 3 then
    raise exception 'FAIL 1a the expense date did not persist: %', updated.expense_date; end if;
  raise notice 'PASS  1a the owner corrects amount, date, purpose and details on their Draft';

  -- Read it back rather than trusting the returned row: the point is what was
  -- stored, not what the function said it stored.
  select amount, title, expense_date into amt, txt, d
  from public.finance_requests where id = claim_a;
  if amt <> 1250.50 or txt <> 'ZZ corrected title' or d <> current_date - 3 then
    raise exception 'FAIL 1b the correction was not persisted to the row'; end if;
  raise notice 'PASS  1b and the row itself holds the correction';

  -- ======================================================================
  -- 2. A correction changes what was asked for -- and nothing else
  -- ======================================================================
  select * into updated from public.finance_requests where id = claim_a;
  if updated.status <> 'draft' then
    raise exception 'FAIL 2a editing moved the status to %', updated.status; end if;
  raise notice 'PASS  2a editing does not move the status';

  if updated.request_no is distinct from row_before.request_no then
    raise exception 'FAIL 2b the reference number changed'; end if;
  if updated.requester_id is distinct from row_before.requester_id then
    raise exception 'FAIL 2b the claim changed hands'; end if;
  if updated.type is distinct from row_before.type then
    raise exception 'FAIL 2b the request type changed'; end if;
  raise notice 'PASS  2b the reference, the claimant and the type are untouched';

  if updated.budget_id is not null or updated.finance_category_id is not null
     or updated.vendor_id is not null then
    raise exception 'FAIL 2c editing wrote a classification'; end if;
  if updated.paid_from_account_id is not null or updated.payment_reference is not null
     or updated.paid_at is not null then
    raise exception 'FAIL 2c editing wrote payment details'; end if;
  raise notice 'PASS  2c no classification and no payment details were written';

  select count(*)::integer into n
  from public.finance_request_approvals where request_id = claim_a;
  if n <> 0 then raise exception 'FAIL 2d editing wrote % approval rows', n; end if;
  raise notice 'PASS  2d editing writes nothing to the approval trail';

  select count(*)::integer into n
  from public.treasury_movements where source_id = claim_a;
  if n <> 0 then raise exception 'FAIL 2e editing moved treasury'; end if;
  select count(*)::integer into n
  from public.reimbursement_payments where finance_request_id = claim_a;
  if n <> 0 then raise exception 'FAIL 2e editing created a payment'; end if;
  raise notice 'PASS  2e no treasury movement and no payment came out of an edit';

  select b.reserved, b.spent into reserved, spent
  from public.budget_status b where b.id = budget;
  if reserved <> 0 or spent <> 0 then
    raise exception 'FAIL 2f editing reserved % and spent %', reserved, spent; end if;
  raise notice 'PASS  2f a Draft correction reserves nothing and spends nothing';

  -- ======================================================================
  -- 3. The requester never writes the classification
  -- ======================================================================
  -- Not through the editing function, which does not accept one, and not
  -- through a direct UPDATE either -- the budget a claim is charged to is
  -- decided during validation by somebody who can actually see the budgets.
  begin
    update public.finance_requests set budget_id = budget where id = claim_a;
    raise exception 'FAIL 3a the claimant charged their own claim to a budget';
  exception when insufficient_privilege then
    raise notice 'PASS  3a the claimant cannot charge their own Draft to a budget';
  end;

  begin
    update public.finance_requests set finance_category_id = cat_id where id = claim_a;
    raise exception 'FAIL 3b the claimant set the category';
  exception when insufficient_privilege then
    raise notice 'PASS  3b nor set its category';
  end;

  -- ======================================================================
  -- 4. Nobody else may edit it
  -- ======================================================================
  reset role;
  claim_b := pg_temp.claim(other_emp, 800, 'b' || tag);
  perform pg_temp.acts_as(other_emp); set local role authenticated;

  begin
    perform public.update_finance_request_draft(
      _request_id => claim_a, _title => 'ZZ hijacked', _amount => 5, _priority => 'low');
    raise exception 'FAIL 4a another employee edited a claim that was not theirs';
  exception when insufficient_privilege then
    raise notice 'PASS  4a another employee cannot edit a Draft that is not theirs';
  end;

  select amount, title into amt, txt from public.finance_requests where id = claim_a;
  if amt <> 1250.50 or txt <> 'ZZ corrected title' then
    raise exception 'FAIL 4b the refused edit changed the row anyway'; end if;
  raise notice 'PASS  4b and the refusal left the claim exactly as it was';

  -- Having a Draft of one's own is not a licence to edit someone else's.
  updated := public.update_finance_request_draft(
    _request_id => claim_b, _title => 'ZZ my own draft', _amount => 900, _priority => 'low');
  if updated.amount <> 900 then
    raise exception 'FAIL 4c an employee could not edit their own Draft'; end if;
  raise notice 'PASS  4c while their own Draft is still theirs to correct';
  reset role;

  -- Finance is not a licence either. Finance Staff classify; they do not
  -- rewrite what somebody asked for.
  perform pg_temp.acts_as(fin_staff); set local role authenticated;
  begin
    perform public.update_finance_request_draft(
      _request_id => claim_a, _title => 'ZZ finance rewrote this', _amount => 1, _priority => 'low');
    raise exception 'FAIL 4d Finance Staff rewrote an employee''s Draft';
  exception when insufficient_privilege then
    raise notice 'PASS  4d Finance Staff cannot rewrite an employee''s Draft either';
  end;
  reset role;

  -- ======================================================================
  -- 5. Not after submission, and not in any later state
  -- ======================================================================
  perform pg_temp.acts_as(employee); set local role authenticated;
  perform public.transition_finance_request(claim_a, 'pending_validation', null);

  begin
    perform public.update_finance_request_draft(
      _request_id => claim_a, _title => 'ZZ edited after submitting', _amount => 9999,
      _priority => 'high');
    raise exception 'FAIL 5a a submitted claim was still editable';
  exception when insufficient_privilege then
    raise notice 'PASS  5a a submitted claim is no longer editable';
  end;

  select amount into amt from public.finance_requests where id = claim_a;
  if amt <> 1250.50 then raise exception 'FAIL 5b the amount changed to %', amt; end if;
  raise notice 'PASS  5b and what Finance received is what was submitted';
  reset role;

  -- All the way to approved, which is where the money starts to matter.
  perform pg_temp.acts_as(fin_staff); set local role authenticated;
  update public.finance_requests set budget_id = budget, finance_category_id = cat_id
   where id = claim_a;
  perform public.transition_finance_request(claim_a, 'pending_approval', 'fixture');
  reset role;
  perform pg_temp.acts_as(fin_mgr); set local role authenticated;
  perform public.transition_finance_request(claim_a, 'approved', 'fixture');
  reset role;

  perform pg_temp.acts_as(employee); set local role authenticated;
  begin
    perform public.update_finance_request_draft(
      _request_id => claim_a, _title => 'ZZ edited after approval', _amount => 9999,
      _priority => 'high');
    raise exception 'FAIL 5c an approved claim was editable';
  exception when insufficient_privilege then
    raise notice 'PASS  5c an approved claim is not editable';
  end;

  select b.reserved into reserved from public.budget_status b where b.id = budget;
  if reserved <> 1250.50 then
    raise exception 'FAIL 5d the approved reservation is % rather than 1250.50', reserved; end if;
  raise notice 'PASS  5d and the reservation still matches what was approved';

  -- A returned claim goes back for correction, which is the one later state
  -- that has always been the requester's to amend. It is not this function's
  -- job: this one is Draft only, so that "editable" cannot creep.
  reset role;
  perform pg_temp.acts_as(other_emp); set local role authenticated;
  perform public.transition_finance_request(claim_b, 'cancelled', 'fixture');
  begin
    perform public.update_finance_request_draft(
      _request_id => claim_b, _title => 'ZZ edited after cancelling', _amount => 5,
      _priority => 'low');
    raise exception 'FAIL 5e a cancelled claim was editable';
  exception when insufficient_privilege then
    raise notice 'PASS  5e a cancelled claim is not editable';
  end;
  reset role;

  -- ======================================================================
  -- 6. Validation, in the words the form uses
  -- ======================================================================
  reset role;
  claim_b := pg_temp.claim(employee, 700, 'c' || tag);
  perform pg_temp.acts_as(employee); set local role authenticated;

  begin
    perform public.update_finance_request_draft(
      _request_id => claim_b, _title => '   ', _amount => 700, _priority => 'medium');
    raise exception 'FAIL 6a a blank title was accepted';
  exception when check_violation then
    raise notice 'PASS  6a a blank title is refused';
  end;

  begin
    perform public.update_finance_request_draft(
      _request_id => claim_b, _title => 'ZZ ok', _amount => 0, _priority => 'medium');
    raise exception 'FAIL 6b a zero amount was accepted';
  exception when check_violation then
    raise notice 'PASS  6b an amount of zero is refused';
  end;

  begin
    perform public.update_finance_request_draft(
      _request_id => claim_b, _title => 'ZZ ok', _amount => -50, _priority => 'medium');
    raise exception 'FAIL 6c a negative amount was accepted';
  exception when check_violation then
    raise notice 'PASS  6c and so is a negative one';
  end;

  begin
    perform public.update_finance_request_draft(
      _request_id => claim_b, _title => 'ZZ ok', _amount => 700, _priority => 'urgent');
    raise exception 'FAIL 6d an unknown priority was accepted';
  exception when check_violation then
    raise notice 'PASS  6d an unknown priority is refused';
  end;

  begin
    perform public.update_finance_request_draft(
      _request_id => claim_b, _title => repeat('z', 151), _amount => 700, _priority => 'low');
    raise exception 'FAIL 6e an over-long title was accepted';
  exception when check_violation then
    raise notice 'PASS  6e an over-long title is refused';
  end;

  -- The one rule that is specific to reimbursements, and it is already a table
  -- constraint: only a reimbursement has a date the money was already spent.
  select amount into amt from public.finance_requests where id = claim_b;
  if amt <> 700 then raise exception 'FAIL 6f a refused edit changed the amount to %', amt; end if;
  raise notice 'PASS  6f none of the refused edits changed anything';

  -- ======================================================================
  -- 7. A stale edit is refused rather than overwriting a newer one
  -- ======================================================================
  -- The stale timestamp is constructed rather than produced by saving twice,
  -- and that is a limit of the harness, not of the guard. now() is the
  -- transaction's start time, so every updated_at written inside this one
  -- rollback block is identical -- two saves here would compare equal however
  -- broken the check was. Real saves arrive in separate transactions with
  -- separate clocks, and the row lock above serialises them so the second one
  -- re-reads what the first wrote. What is left to pin is the comparison
  -- itself: a version that is not the row's version does not get to write.
  select updated_at into stamp from public.finance_requests where id = claim_b;

  updated := public.update_finance_request_draft(
    _request_id => claim_b, _title => 'ZZ first save', _amount => 710, _priority => 'low',
    _expected_updated_at => stamp);
  if updated.amount <> 710 then
    raise exception 'FAIL 7a a correct expected timestamp was refused'; end if;
  raise notice 'PASS  7a an edit carrying the version it read is accepted';

  begin
    perform public.update_finance_request_draft(
      _request_id => claim_b, _title => 'ZZ second save', _amount => 999, _priority => 'high',
      _expected_updated_at => stamp - interval '1 second');
    raise exception 'FAIL 7b a stale edit overwrote a newer one';
  exception when check_violation then
    raise notice 'PASS  7b an edit carrying a stale version is refused';
  end;

  select amount, title into amt, txt from public.finance_requests where id = claim_b;
  if amt <> 710 or txt <> 'ZZ first save' then
    raise exception 'FAIL 7c the stale edit landed anyway: % %', amt, txt; end if;
  raise notice 'PASS  7c and the first save survives intact';

  -- Omitting the version is still allowed: a caller that is not tracking one
  -- says so by leaving it out, rather than by inventing a value to pass.
  updated := public.update_finance_request_draft(
    _request_id => claim_b, _title => 'ZZ untracked save', _amount => 720, _priority => 'low');
  if updated.amount <> 720 then
    raise exception 'FAIL 7d an edit with no version was refused'; end if;
  raise notice 'PASS  7d an edit that carries no version at all is still accepted';

  -- ======================================================================
  -- 8. A request that is not there
  -- ======================================================================
  begin
    perform public.update_finance_request_draft(
      _request_id => gen_random_uuid(), _title => 'ZZ ghost', _amount => 1, _priority => 'low');
    raise exception 'FAIL 8a editing a request that does not exist succeeded';
  exception when no_data_found then
    raise notice 'PASS  8a editing a request that does not exist says so';
  end;
  reset role;

  raise notice '--------------------------------------------------';
  raise notice 'reimbursement_draft_edit_rls: all checks passed';
end $$;

rollback;
