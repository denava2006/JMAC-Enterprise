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
    perform public.transition_finance_request(req, 'approved');
    raise exception 'FAIL 1c a requester approved their own request';
  exception when insufficient_privilege then
    raise notice 'PASS  1c a requester cannot skip to approved';
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
    perform public.transition_finance_request(req, 'approved');
    raise exception 'FAIL 3f Finance Staff approved after validating';
  exception when insufficient_privilege then
    raise notice 'PASS  3f Finance Staff cannot then approve what they validated';
  end;
  reset role;

  -- ======================================================================
  -- 4. Approval reserves. Nothing yet spends.
  -- ======================================================================
  perform pg_temp.acts_as(manager); set local role authenticated;
  perform public.transition_finance_request(req, 'approved', 'Approved');

  select reserved into num from public.budget_status where id = budget_id;
  if num <> 20000 then raise exception 'FAIL 4a reserved reads %, expected 20000', num; end if;
  select spent into num from public.budget_status where id = budget_id;
  if num <> 0 then raise exception 'FAIL 4b spent reads %, expected 0 -- nothing can settle yet', num; end if;
  select remaining into num from public.budget_status where id = budget_id;
  if num <> 80000 then raise exception 'FAIL 4c remaining reads %, expected 80000', num; end if;
  raise notice 'PASS  4a-c approval reserves the amount; spent stays 0 because nothing can settle it';

  -- Exactly once. reserved is DERIVED from status, so a second approval, a
  -- refresh or a retried RPC cannot hold the same money twice.
  begin
    perform public.transition_finance_request(req, 'approved', 'Approved again');
    raise exception 'FAIL 4d the same request was approved twice';
  exception when insufficient_privilege then
    null;
  end;
  select reserved into num from public.budget_status where id = budget_id;
  if num <> 20000 then raise exception 'FAIL 4d a retry moved reserved to %', num; end if;
  select reserved into num from public.budget_status where id = budget_id;
  if num <> 20000 then raise exception 'FAIL 4e re-reading changed reserved to %', num; end if;
  raise notice 'PASS  4d-e approving twice is refused, and reserved is held exactly once';

  -- ======================================================================
  -- 5. A workflow status is not a settlement
  -- ======================================================================
  begin
    perform public.transition_finance_request(req, 'completed');
    raise exception 'FAIL 5a a request was completed with nothing to settle it';
  exception when feature_not_supported then
    raise notice 'PASS  5a completion is refused: no procurement, invoice or payment exists to settle';
  end;

  begin
    perform public.transition_finance_request(req, 'returned', 'x', account_id, 'OR-1');
    raise exception 'FAIL 5b payment details were accepted';
  exception when feature_not_supported then
    raise notice 'PASS  5b payment details are refused outright in this phase';
  end;

  select spent into num from public.budget_status where id = budget_id;
  if num <> 0 then raise exception 'FAIL 5c spent moved to % without a settlement', num; end if;
  raise notice 'PASS  5c spent cannot be moved by the request workflow at all';

  -- Withdrawing an approval releases the hold, exactly once.
  perform public.transition_finance_request(req, 'rejected', 'Not needed after all');
  select reserved into num from public.budget_status where id = budget_id;
  if num <> 0 then raise exception 'FAIL 5d reserved stayed at % after rejection', num; end if;
  select remaining into num from public.budget_status where id = budget_id;
  if num <> 100000 then raise exception 'FAIL 5e remaining reads %, expected the full ceiling', num; end if;
  raise notice 'PASS  5d-e withdrawing an approval releases the reservation and restores the ceiling';

  begin
    perform public.transition_finance_request(req, 'approved');
    raise exception 'FAIL 5f a rejected request was approved';
  exception when insufficient_privilege then
    raise notice 'PASS  5f a rejected request is terminal';
  end;
  reset role;

  -- The status exists for the phase that will be able to reach it. Even a row
  -- forced into it -- which no API role can do, but a service_role write or a
  -- future migration could -- must not make the budget claim money was spent,
  -- because nothing recorded a settlement.
  declare _forced uuid;
  begin
    -- Fully formed: the check constraint requires a completed request to carry
    -- the account it was settled from, and this one does. It STILL must not
    -- create spend, because a field somebody filled in is not a payments
    -- ledger, a supplier invoice or a journal -- and F3 has none of those.
    insert into public.finance_requests (type, title, requester_id, amount, budget_id, status,
                                         paid_from_account_id, paid_at)
    values ('purchase', 'ZZ Forced complete', worker, 50000, budget_id, 'completed',
            account_id, now())
    returning id into _forced;

    select spent into num from public.budget_status where id = budget_id;
    if num <> 0 then
      raise exception 'FAIL 5g a completed request moved spent to % with nothing settling it', num;
    end if;
    select reserved into num from public.budget_status where id = budget_id;
    if num <> 0 then
      raise exception 'FAIL 5g a completed request was counted as reserved (%)', num;
    end if;
    raise notice 'PASS  5g workflow completion alone moves neither spent nor reserved';

    delete from public.finance_requests where id = _forced;
  end;

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
  -- 8. The ceiling holds against reservations, cumulatively
  -- ======================================================================
  -- One approval fits; the next one would breach the ceiling once the first is
  -- counted. The ceiling is about the total held, not any single request.
  req := pg_temp.raise_request(worker, 70000, budget_id);
  perform pg_temp.acts_as(worker); set local role authenticated;
  perform public.transition_finance_request(req, 'pending_validation');
  reset role;
  perform pg_temp.acts_as(staff); set local role authenticated;
  perform public.transition_finance_request(req, 'pending_approval');
  reset role;
  perform pg_temp.acts_as(manager); set local role authenticated;
  perform public.transition_finance_request(req, 'approved');
  select reserved into num from public.budget_status where id = budget_id;
  if num <> 70000 then raise exception 'FAIL 8a reserved reads %, expected 70000', num; end if;
  reset role;

  req := pg_temp.raise_request(worker, 40000, budget_id);
  perform pg_temp.acts_as(worker); set local role authenticated;
  perform public.transition_finance_request(req, 'pending_validation');
  reset role;
  perform pg_temp.acts_as(staff); set local role authenticated;
  perform public.transition_finance_request(req, 'pending_approval');
  reset role;
  perform pg_temp.acts_as(manager); set local role authenticated;
  begin
    perform public.transition_finance_request(req, 'approved');
    raise exception 'FAIL 8b approvals accumulated past the ceiling';
  exception when check_violation then
    raise notice 'PASS  8a-b one approval reserves; the next that would breach the ceiling is refused';
  end;
  select reserved into num from public.budget_status where id = budget_id;
  if num <> 70000 then raise exception 'FAIL 8c a refused approval still moved reserved to %', num; end if;
  select spent into num from public.budget_status where id = budget_id;
  if num <> 0 then raise exception 'FAIL 8d spent moved to %', num; end if;
  raise notice 'PASS  8c-d a refused approval reserves nothing, and spent never moves';
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
