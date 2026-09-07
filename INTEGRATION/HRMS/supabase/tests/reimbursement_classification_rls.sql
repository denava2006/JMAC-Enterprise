-- F7-QA-05: classifying a reimbursement, and what forwarding requires.
--
-- Acceptance opened RB-2026-0001 as Finance Staff: Category "Not classified",
-- Budget "Not assigned", no controls for either, and "Forward for approval"
-- offered anyway. Forwarding it would have worked, and approving it after that
-- would have reserved nothing -- the budget line would never have heard of a
-- claim sitting "Approved — awaiting payment" against it.
--
-- The controls are a UI defect. These are the claims that are not:
--
--   Finance Staff classify a reimbursement while it is theirs to validate
--   the claimant never classifies their own claim, whatever else they hold
--   an unrelated employee cannot classify anything
--   the Finance Manager and the Accountant do not classify either
--   forwarding without a budget is refused, by the workflow function and by
--     any other route that writes the status
--   forwarding with one is ordinary and needs no reason
--   classification is fixed once the claim leaves validation
--   forwarding moves no money: no payment, no treasury movement, and nothing
--     reserved until approval
--
-- Run:
--   docker exec -i supabase_db_harmony-suite psql -U postgres -d postgres \
--     -v ON_ERROR_STOP=1 -f - < supabase/tests/reimbursement_classification_rls.sql
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

/** A claim filed and submitted, arriving unclassified the way My Requests
 *  files one -- the employee cannot read budgets, so they cannot set one. */
create or replace function pg_temp.submitted_claim(_employee uuid, _amount numeric, _tag text)
returns uuid
language plpgsql as $$
declare _id uuid;
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub', _employee, 'role', 'authenticated')::text, true);
  set local role authenticated;
  insert into public.finance_requests
    (type, title, justification, requester_id, amount, expense_date, priority, status)
  values ('reimbursement', 'ZZ claim ' || _tag, 'ZZ business purpose', _employee,
          _amount, current_date - 1, 'medium', 'draft')
  returning id into _id;
  perform public.transition_finance_request(_id, 'pending_validation', null);
  reset role;
  return _id;
end;
$$;

do $$
declare
  admin_id uuid; employee uuid; other_emp uuid;
  fin_staff uuid; fin_staff2 uuid; fin_mgr uuid; accountant uuid;
  cat_id uuid; other_cat uuid; budget uuid; closed_budget uuid; draft_budget uuid;
  claim uuid; claim_b uuid; claim_c uuid;
  n integer; txt text; reserved numeric; spent numeric; b_id uuid;
  tag text := left(replace(gen_random_uuid()::text, '-', ''), 8);
begin
  select id into admin_id from public.profiles where role='admin' and status='active' limit 1;

  employee   := pg_temp.hire('Claimant',    'Cashier');
  other_emp  := pg_temp.hire('Bystander',   'Cashier');
  fin_staff  := pg_temp.hire('Fin Staff',   'Finance Staff');
  fin_staff2 := pg_temp.hire('Fin Staff 2', 'Finance Staff');
  fin_mgr    := pg_temp.hire('Fin Manager', 'Finance Manager');
  accountant := pg_temp.hire('Bookkeeper',  'Accountant');

  select id into cat_id    from public.finance_categories where kind='expense' and is_active limit 1;
  select id into other_cat from public.finance_categories
   where kind='expense' and is_active and id <> cat_id limit 1;

  perform pg_temp.acts_as(fin_staff); set local role authenticated;
  insert into public.budgets (name, finance_category_id, amount, fiscal_year)
  values ('ZZ Classify Budget ' || tag, cat_id, 50000, extract(year from current_date)::integer)
  returning id into budget;
  insert into public.budgets (name, finance_category_id, amount, fiscal_year)
  values ('ZZ Closed Budget ' || tag, cat_id, 50000, extract(year from current_date)::integer)
  returning id into closed_budget;
  -- Left unapproved on purpose: a budget nobody has activated.
  insert into public.budgets (name, finance_category_id, amount, fiscal_year)
  values ('ZZ Draft Budget ' || tag, cat_id, 50000, extract(year from current_date)::integer)
  returning id into draft_budget;
  reset role;
  perform pg_temp.acts_as(fin_mgr); set local role authenticated;
  perform public.review_budget(budget, true, 'fixture');
  perform public.review_budget(closed_budget, true, 'fixture');
  reset role;

  claim := pg_temp.submitted_claim(employee, 1000, 'a' || tag);

  select status, budget_id into txt, b_id from public.finance_requests where id = claim;
  if txt <> 'pending_validation' then
    raise exception 'FAIL fixture: claim is % rather than pending_validation', txt; end if;
  if b_id is not null then
    raise exception 'FAIL fixture: the employee arrived with a budget already set'; end if;

  -- ======================================================================
  -- 1. Finance Staff classify while the claim is theirs to validate
  -- ======================================================================
  perform pg_temp.acts_as(fin_staff); set local role authenticated;
  update public.finance_requests
     set budget_id = budget, finance_category_id = cat_id
   where id = claim;
  get diagnostics n = row_count;
  if n <> 1 then raise exception 'FAIL 1a Finance Staff could not classify the claim'; end if;

  select budget_id into b_id from public.finance_requests where id = claim;
  if b_id is distinct from budget then
    raise exception 'FAIL 1a the budget did not persist'; end if;
  select count(*)::integer into n from public.finance_requests
   where id = claim and finance_category_id = cat_id;
  if n <> 1 then raise exception 'FAIL 1a the category did not persist'; end if;
  raise notice 'PASS  1a Finance Staff assign a budget and a category during validation';

  -- Reclassifying before forwarding is ordinary: it is a review, not a
  -- one-shot. Another Finance Staff member may do it too.
  reset role;
  perform pg_temp.acts_as(fin_staff2); set local role authenticated;
  select id into other_cat from public.finance_categories
   where kind='expense' and is_active and id <> cat_id limit 1;
  update public.finance_requests set finance_category_id = coalesce(other_cat, cat_id)
   where id = claim;
  get diagnostics n = row_count;
  if n <> 1 then raise exception 'FAIL 1b a second Finance Staff could not correct the category'; end if;
  raise notice 'PASS  1b and either of them may correct it before it is forwarded';
  reset role;

  -- ======================================================================
  -- 2. Nobody else classifies
  -- ======================================================================
  -- The claimant. They cannot read a budget to name one, and they cannot
  -- write one if they somehow learn an id.
  perform pg_temp.acts_as(employee); set local role authenticated;
  update public.finance_requests set budget_id = budget where id = claim;
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'FAIL 2a the claimant classified their own claim'; end if;
  select count(*)::integer into n from public.budgets;
  if n <> 0 then raise exception 'FAIL 2a the claimant can read % budgets', n; end if;
  raise notice 'PASS  2a the claimant can neither read a budget nor charge their claim to one';
  reset role;

  -- An unrelated employee cannot even see the claim, let alone classify it.
  perform pg_temp.acts_as(other_emp); set local role authenticated;
  update public.finance_requests set budget_id = budget where id = claim;
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'FAIL 2b an unrelated employee classified the claim'; end if;
  select count(*)::integer into n from public.finance_requests where id = claim;
  if n <> 0 then raise exception 'FAIL 2b an unrelated employee can read the claim'; end if;
  raise notice 'PASS  2b an unrelated employee can neither read nor classify it';
  reset role;

  -- The Finance Manager approves; classifying is not theirs. A checker who
  -- can set the budget while approving is approving their own classification.
  perform pg_temp.acts_as(fin_mgr); set local role authenticated;
  update public.finance_requests set budget_id = closed_budget where id = claim;
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'FAIL 2c the Finance Manager classified the claim'; end if;
  raise notice 'PASS  2c the Finance Manager reviews the classification rather than writing it';
  reset role;

  perform pg_temp.acts_as(accountant); set local role authenticated;
  update public.finance_requests set budget_id = closed_budget where id = claim;
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'FAIL 2d the Accountant classified the claim'; end if;
  raise notice 'PASS  2d and neither does the Accountant';
  reset role;

  -- ======================================================================
  -- 3. Forwarding without a budget is refused
  -- ======================================================================
  claim_b := pg_temp.submitted_claim(employee, 700, 'b' || tag);

  perform pg_temp.acts_as(fin_staff); set local role authenticated;
  begin
    perform public.transition_finance_request(claim_b, 'pending_approval', null);
    raise exception 'FAIL 3a an unclassified claim was forwarded for approval';
  exception when check_violation then
    raise notice 'PASS  3a an unclassified claim cannot be forwarded for approval';
  end;

  select status into txt from public.finance_requests where id = claim_b;
  if txt <> 'pending_validation' then
    raise exception 'FAIL 3b the refused forward moved it to %', txt; end if;
  select count(*)::integer into n
  from public.finance_request_approvals where request_id = claim_b and to_status = 'pending_approval';
  if n <> 0 then raise exception 'FAIL 3b the refused forward wrote a trail row'; end if;
  raise notice 'PASS  3b and the refusal leaves the claim and its trail untouched';

  -- Not merely a disabled button, and not merely the workflow function: the
  -- rule is on the row, so a direct write of the status meets it too.
  begin
    perform set_config('jmac.finance_transition', 'on', true);
    update public.finance_requests set status = 'pending_approval' where id = claim_b;
    perform set_config('jmac.finance_transition', 'off', true);
    raise exception 'FAIL 3c a direct status write skipped the budget rule';
  exception when check_violation then
    perform set_config('jmac.finance_transition', 'off', true);
    raise notice 'PASS  3c and a route that bypasses the workflow function meets it too';
  end;

  -- A budget id that cannot receive the money is the same defect wearing a
  -- uuid. draft_budget has never been approved, so it is not active.
  update public.finance_requests set budget_id = draft_budget where id = claim_b;
  begin
    perform public.transition_finance_request(claim_b, 'pending_approval', null);
    raise exception 'FAIL 3d a claim was forwarded against a budget that is not active';
  exception when check_violation then
    raise notice 'PASS  3d nor against a budget that is not active';
  end;

  -- The Classification panel only lists active budgets, so this is that list
  -- stated where the browser cannot be talked out of it.
  select count(*)::integer into n from public.budgets where status = 'active' and id = draft_budget;
  if n <> 0 then raise exception 'FAIL 3e the draft budget is active after all'; end if;
  raise notice 'PASS  3e which is the same list the classification controls offer';

  -- ======================================================================
  -- 4. With a budget it is ordinary, and needs no reason
  -- ======================================================================
  update public.finance_requests set budget_id = budget where id = claim_b;
  perform public.transition_finance_request(claim_b, 'pending_approval', null);
  select status into txt from public.finance_requests where id = claim_b;
  if txt <> 'pending_approval' then
    raise exception 'FAIL 4a a classified claim did not forward: %', txt; end if;
  raise notice 'PASS  4a a classified claim forwards with no reason given';

  select count(*)::integer into n
  from public.finance_request_approvals
  where request_id = claim_b and action = 'validated' and remarks is null;
  if n <> 1 then raise exception 'FAIL 4b the trail did not record a reasonless validation'; end if;
  raise notice 'PASS  4b and the trail records it as validated, with no remarks';

  -- ======================================================================
  -- 5. Forwarding moves no money
  -- ======================================================================
  select count(*)::integer into n from public.reimbursement_payments
   where finance_request_id = claim_b;
  if n <> 0 then raise exception 'FAIL 5a forwarding created a payment'; end if;
  select count(*)::integer into n from public.treasury_movements where source_id = claim_b;
  if n <> 0 then raise exception 'FAIL 5a forwarding moved treasury'; end if;
  raise notice 'PASS  5a forwarding creates no payment and moves no treasury';

  select bs.reserved, bs.spent into reserved, spent
  from public.budget_status bs where bs.id = budget;
  if reserved <> 0 then
    raise exception 'FAIL 5b forwarding reserved % before approval', reserved; end if;
  if spent <> 0 then raise exception 'FAIL 5b forwarding spent %', spent; end if;
  raise notice 'PASS  5b and reserves nothing -- approval is what commits the money';
  reset role;

  -- Approval is still what reserves, and now it reserves the right amount
  -- rather than nothing, which is the whole point of the rule.
  perform pg_temp.acts_as(fin_mgr); set local role authenticated;
  perform public.transition_finance_request(claim_b, 'approved', null);
  reset role;
  select bs.reserved into reserved from public.budget_status bs where bs.id = budget;
  if reserved <> 700 then
    raise exception 'FAIL 5c approval reserved % rather than 700', reserved; end if;
  raise notice 'PASS  5c approval reserves the claim against the budget it was charged to';

  -- ======================================================================
  -- 6. Classification is fixed once the claim leaves validation
  -- ======================================================================
  perform pg_temp.acts_as(fin_staff); set local role authenticated;
  update public.finance_requests set budget_id = closed_budget where id = claim_b;
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'FAIL 6a an approved claim was reclassified'; end if;
  select budget_id into b_id from public.finance_requests where id = claim_b;
  if b_id is distinct from budget then
    raise exception 'FAIL 6a the budget changed after approval'; end if;
  raise notice 'PASS  6a an approved claim cannot be moved to another budget';

  -- Nor at pending_approval, where the Manager is looking at it.
  reset role;
  claim_c := pg_temp.submitted_claim(employee, 400, 'c' || tag);
  -- submitted_claim leaves the claimant's identity in request.jwt.claims, and
  -- the self-classification rule reads auth.uid() rather than the database
  -- role. Without claiming Finance Staff back, the next update is the employee
  -- classifying their own claim -- which is refused, correctly, and for the
  -- wrong reason as far as this check is concerned.
  perform pg_temp.acts_as(fin_staff); set local role authenticated;
  update public.finance_requests set budget_id = budget where id = claim_c;
  perform public.transition_finance_request(claim_c, 'pending_approval', null);
  update public.finance_requests set finance_category_id = cat_id where id = claim_c;
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'FAIL 6b a forwarded claim was reclassified'; end if;
  raise notice 'PASS  6b nor one already sitting with the Finance Manager';
  reset role;

  -- ======================================================================
  -- 7. A returned claim is classified again on its way back
  -- ======================================================================
  -- Returning drops it to 'returned', where the classify policy does not
  -- reach. Resubmitting puts it back in pending_validation, and Finance Staff
  -- pick it up as before -- so a correction round trip is not a dead end.
  perform pg_temp.acts_as(fin_mgr); set local role authenticated;
  perform public.transition_finance_request(claim_c, 'returned', 'ZZ needs a receipt');
  reset role;
  perform pg_temp.acts_as(employee); set local role authenticated;
  perform public.transition_finance_request(claim_c, 'pending_validation', null);
  reset role;
  perform pg_temp.acts_as(fin_staff); set local role authenticated;
  update public.finance_requests set finance_category_id = cat_id where id = claim_c;
  get diagnostics n = row_count;
  if n <> 1 then raise exception 'FAIL 7a a resubmitted claim could not be reclassified'; end if;
  raise notice 'PASS  7a a resubmitted claim is Finance Staff''s to classify again';
  reset role;

  raise notice '--------------------------------------------------';
  raise notice 'reimbursement_classification_rls: all checks passed';
end $$;

rollback;
