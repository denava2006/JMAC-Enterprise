-- FMS F3 — the request workflow, database contract test.
--
-- The chain is only real if the database refuses the shortcuts. The standalone
-- system let any reviewer set any status and let a requester edit an approved
-- amount before it was paid; both are checked here as denials, not as features.
--
-- Run:
--   docker exec -i supabase_db_harmony-suite psql -U postgres -d postgres \
--     -v ON_ERROR_STOP=1 -f - < supabase/tests/finance_requests_rls.sql
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

/** Raise a request as somebody, returning its id. */
create or replace function pg_temp.raise_request(_uid uuid, _amount numeric, _budget uuid)
returns uuid
language plpgsql as $$
declare _id uuid;
begin
  perform pg_temp.acts_as(_uid);
  set local role authenticated;
  insert into public.finance_requests (type, title, requester_id, amount, budget_id)
  values ('purchase', 'ZZ Test request', _uid, _amount, _budget)
  returning id into _id;
  reset role;
  return _id;
end;
$$;

do $$
declare
  admin_id uuid; staff uuid; manager uuid; acct uuid; worker uuid; hr uuid;
  cat_id uuid; budget_id uuid; account_id uuid;
  req uuid; n integer; txt text; num numeric;
  tag text := left(replace(gen_random_uuid()::text, '-', ''), 8);
begin
  select id into admin_id from public.profiles where role='admin' and status='active' limit 1;
  if admin_id is null then raise exception 'fixture: need an active administrator'; end if;

  staff   := pg_temp.hire('Fin Staff',   'Finance Staff');
  manager := pg_temp.hire('Fin Manager', 'Finance Manager');
  acct    := pg_temp.hire('Fin Acct',    'Accountant');
  worker  := pg_temp.hire('Requester',   'Cashier');
  hr      := pg_temp.hire('HR Person',   'HR Staff');

  -- Master data, created by the roles that own it.
  perform pg_temp.acts_as(manager); set local role authenticated;
  select id into cat_id from public.finance_categories where kind='expense' and is_active limit 1;
  insert into public.budgets (name, finance_category_id, amount, status, fiscal_year)
  values ('ZZ Request Budget ' || tag, cat_id, 100000, 'active', 2026) returning id into budget_id;
  reset role;

  perform pg_temp.acts_as(acct); set local role authenticated;
  insert into public.finance_accounts (name, account_type, account_subtype)
  values ('ZZ Cash ' || tag, 'asset', 'cash') returning id into account_id;
  reset role;

  -- ======================================================================
  -- 1. An employee asks
  -- ======================================================================
  req := pg_temp.raise_request(worker, 20000, budget_id);

  perform pg_temp.acts_as(worker); set local role authenticated;
  select request_no, status into txt, txt from public.finance_requests where id = req;
  select status into txt from public.finance_requests where id = req;
  if txt <> 'draft' then raise exception 'FAIL 1a a new request is %, expected draft', txt; end if;
  select request_no into txt from public.finance_requests where id = req;
  if txt !~ '^PR-\d{4}-\d{4}$' then raise exception 'FAIL 1b request_no is %', txt; end if;
  raise notice 'PASS  1a-b an employee raises a request; it starts as a draft with a reference';

  -- A requester cannot walk their own request down the chain.
  begin
    perform public.transition_finance_request(req, 'pending_payment');
    raise exception 'FAIL 1c a requester approved their own request';
  exception when insufficient_privilege then
    raise notice 'PASS  1c a requester cannot skip to approved';
  end;
  begin
    perform public.transition_finance_request(req, 'completed', null, account_id, 'x');
    raise exception 'FAIL 1d a requester paid their own request';
  exception when insufficient_privilege then
    raise notice 'PASS  1d a requester cannot pay their own request';
  end;

  perform public.transition_finance_request(req, 'pending_validation', 'Please process');
  select status into txt from public.finance_requests where id = req;
  if txt <> 'pending_validation' then raise exception 'FAIL 1e submit left it at %', txt; end if;
  raise notice 'PASS  1e submitting moves it to pending_validation';

  -- ======================================================================
  -- 2. What was approved is what gets paid
  -- ======================================================================
  -- Two independent layers, checked separately.
  --
  -- The policy: a submitted request is outside the requester's UPDATE scope, so
  -- the row does not match and nothing is written. PostgREST reports that as
  -- success with an empty result, which is why the client checks the returned
  -- rows rather than trusting a 200.
  update public.finance_requests set amount = 500000 where id = req;
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'FAIL 2a a requester amended a submitted request'; end if;
  select amount into num from public.finance_requests where id = req;
  if num <> 20000 then raise exception 'FAIL 2a the amount changed to %', num; end if;
  raise notice 'PASS  2a a submitted request is outside the requester''s reach';
  reset role;

  -- The trigger: even with RLS out of the way -- a service_role write, a future
  -- policy mistake -- the frozen fields and the status still refuse to move.
  begin
    update public.finance_requests set amount = 500000 where id = req;
    raise exception 'FAIL 2b the trigger allowed a frozen amount to change';
  exception when insufficient_privilege then
    raise notice 'PASS  2b the frozen fields refuse to change even without RLS in the way';
  end;

  begin
    update public.finance_requests set status = 'completed' where id = req;
    raise exception 'FAIL 2c status was changed by an UPDATE';
  exception when insufficient_privilege then
    raise notice 'PASS  2c status is never changed by editing the row';
  end;

  -- ======================================================================
  -- 3. Each step belongs to one role
  -- ======================================================================
  perform pg_temp.acts_as(manager); set local role authenticated;
  begin
    perform public.transition_finance_request(req, 'pending_approval');
    raise exception 'FAIL 3a the Finance Manager performed validation';
  exception when insufficient_privilege then
    raise notice 'PASS  3a validation is Finance Staff''s, not the Manager''s';
  end;
  reset role;

  perform pg_temp.acts_as(acct); set local role authenticated;
  begin
    perform public.transition_finance_request(req, 'pending_approval');
    raise exception 'FAIL 3b the Accountant performed validation';
  exception when insufficient_privilege then
    raise notice 'PASS  3b the Accountant does not validate';
  end;
  reset role;

  perform pg_temp.acts_as(admin_id); set local role authenticated;
  begin
    perform public.transition_finance_request(req, 'pending_approval');
    raise exception 'FAIL 3c the Administrator moved a request';
  exception when insufficient_privilege then
    raise notice 'PASS  3c the Administrator moves nothing through the chain';
  end;
  select count(*) into n from public.finance_requests where id = req;
  if n <> 1 then raise exception 'FAIL 3d the Administrator cannot read requests'; end if;
  raise notice 'PASS  3d the Administrator reads requests for oversight';
  reset role;

  perform pg_temp.acts_as(staff); set local role authenticated;
  perform public.transition_finance_request(req, 'pending_approval', 'Documents check out');
  raise notice 'PASS  3e Finance Staff validate';

  begin
    perform public.transition_finance_request(req, 'pending_payment');
    raise exception 'FAIL 3f Finance Staff approved after validating';
  exception when insufficient_privilege then
    raise notice 'PASS  3f Finance Staff cannot then approve what they validated';
  end;
  reset role;

  -- ======================================================================
  -- 4. Approval commits the money
  -- ======================================================================
  perform pg_temp.acts_as(manager); set local role authenticated;
  perform public.transition_finance_request(req, 'pending_payment', 'Approved');
  select reserved, spent, remaining into num, n, n from public.budget_status where id = budget_id;
  if num <> 20000 then raise exception 'FAIL 4a reserved reads %, expected 20000', num; end if;
  select spent into num from public.budget_status where id = budget_id;
  if num <> 0 then raise exception 'FAIL 4b spent moved before payment'; end if;
  select remaining into num from public.budget_status where id = budget_id;
  if num <> 80000 then raise exception 'FAIL 4c remaining reads %, expected 80000', num; end if;
  raise notice 'PASS  4a-c approval reserves the money and reduces what may still be committed';

  begin
    perform public.transition_finance_request(req, 'completed', null, account_id, 'REF-1');
    raise exception 'FAIL 4d the Finance Manager paid a request';
  exception when insufficient_privilege then
    raise notice 'PASS  4d the Manager approves; paying is the Accountant''s';
  end;
  reset role;

  -- ======================================================================
  -- 5. Payment turns the reservation into spend, and moves nothing else
  -- ======================================================================
  perform pg_temp.acts_as(acct); set local role authenticated;
  begin
    perform public.transition_finance_request(req, 'completed');
    raise exception 'FAIL 5a a request was paid without naming an account';
  exception when check_violation then
    raise notice 'PASS  5a paying requires saying which account it came from';
  end;

  perform public.transition_finance_request(req, 'completed', 'Paid in cash', account_id, 'OR-0001');
  select reserved into num from public.budget_status where id = budget_id;
  if num <> 0 then raise exception 'FAIL 5b reserved still reads % after payment', num; end if;
  select spent into num from public.budget_status where id = budget_id;
  if num <> 20000 then raise exception 'FAIL 5c spent reads %, expected 20000', num; end if;
  select remaining into num from public.budget_status where id = budget_id;
  if num <> 80000 then raise exception 'FAIL 5d remaining moved on payment: %', num; end if;
  raise notice 'PASS  5b-d the reservation becomes spend, and remaining does not move';

  select paid_at is not null into txt from public.finance_requests where id = req;
  select count(*) into n from public.finance_requests
   where id = req and paid_from_account_id = account_id and paid_at is not null;
  if n <> 1 then raise exception 'FAIL 5e the payment was not recorded'; end if;
  raise notice 'PASS  5e the account it was paid from is on the record';

  -- Terminal means terminal.
  begin
    perform public.transition_finance_request(req, 'returned');
    raise exception 'FAIL 5f a completed request was reopened';
  exception when insufficient_privilege then
    raise notice 'PASS  5f a completed request cannot be moved again';
  end;
  reset role;

  -- ======================================================================
  -- 6. A finance officer asking for money is a requester like anyone else
  -- ======================================================================
  req := pg_temp.raise_request(staff, 5000, budget_id);
  perform pg_temp.acts_as(staff); set local role authenticated;
  perform public.transition_finance_request(req, 'pending_validation');
  begin
    perform public.transition_finance_request(req, 'pending_approval');
    raise exception 'FAIL 6a Finance Staff validated their own request';
  exception when insufficient_privilege then
    raise notice 'PASS  6a Finance Staff cannot validate their own request';
  end;
  reset role;

  -- ======================================================================
  -- 7. Returned, revised, resubmitted
  -- ======================================================================
  perform pg_temp.acts_as(manager); set local role authenticated;
  reset role;
  perform pg_temp.acts_as(staff); set local role authenticated;
  reset role;

  req := pg_temp.raise_request(worker, 3000, budget_id);
  perform pg_temp.acts_as(worker); set local role authenticated;
  perform public.transition_finance_request(req, 'pending_validation');
  reset role;

  perform pg_temp.acts_as(staff); set local role authenticated;
  perform public.transition_finance_request(req, 'returned', 'Receipt is unreadable');
  reset role;

  perform pg_temp.acts_as(worker); set local role authenticated;
  update public.finance_requests set amount = 3500 where id = req;
  get diagnostics n = row_count;
  if n <> 1 then raise exception 'FAIL 7a a returned request could not be revised'; end if;
  perform public.transition_finance_request(req, 'pending_validation', 'Clearer copy attached');
  select status into txt from public.finance_requests where id = req;
  if txt <> 'pending_validation' then raise exception 'FAIL 7b resubmit left it at %', txt; end if;
  raise notice 'PASS  7a-b a returned request is editable again and can be resubmitted';
  reset role;

  -- ======================================================================
  -- 8. The ceiling holds against the pipeline too
  -- ======================================================================
  req := pg_temp.raise_request(worker, 90000, budget_id);
  perform pg_temp.acts_as(worker); set local role authenticated;
  perform public.transition_finance_request(req, 'pending_validation');
  reset role;
  perform pg_temp.acts_as(staff); set local role authenticated;
  perform public.transition_finance_request(req, 'pending_approval');
  reset role;
  perform pg_temp.acts_as(manager); set local role authenticated;
  begin
    perform public.transition_finance_request(req, 'pending_payment');
    raise exception 'FAIL 8a approval pushed the budget over its ceiling';
  exception when check_violation then
    raise notice 'PASS  8a approval that would exceed the ceiling is refused';
  end;
  reset role;

  -- ======================================================================
  -- 9. Who may see what
  -- ======================================================================
  perform pg_temp.acts_as(hr); set local role authenticated;
  select count(*) into n from public.finance_requests;
  if n <> 0 then raise exception 'FAIL 9a HR read % finance requests', n; end if;
  raise notice 'PASS  9a HR sees no finance requests';
  reset role;

  perform pg_temp.acts_as(worker); set local role authenticated;
  select count(*) into n from public.finance_requests;
  if n = 0 then raise exception 'FAIL 9b a requester cannot see their own requests'; end if;
  select count(*) into n from public.finance_requests where requester_id <> worker;
  if n <> 0 then raise exception 'FAIL 9c a requester saw somebody else''s request'; end if;
  raise notice 'PASS  9b-c a requester sees their own requests and nobody else''s';
  reset role;

  begin
    set local role anon;
    perform 1 from public.finance_requests limit 1;
    raise exception 'FAIL 9d anon reached the request list';
  exception when insufficient_privilege then
    reset role;
    raise notice 'PASS  9d anon is refused by the table grant';
  end;
  reset role;

  -- ======================================================================
  -- 10. The approval trail is written by the chain, not by hand
  -- ======================================================================
  perform pg_temp.acts_as(staff); set local role authenticated;
  begin
    insert into public.finance_request_approvals (request_id, action, to_status)
    values (req, 'approved', 'pending_payment');
    raise exception 'FAIL 10a an approval record was written by hand';
  exception when insufficient_privilege then
    raise notice 'PASS  10a the approval trail is append-only, and only the chain appends';
  end;

  select count(*) into n from public.finance_request_approvals where request_id = req;
  if n < 2 then raise exception 'FAIL 10b the trail has % entries, expected the chain', n; end if;
  raise notice 'PASS  10b every step it took is on the record';
  reset role;
end $$;

rollback;
