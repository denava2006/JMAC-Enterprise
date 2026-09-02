-- A branch manager receives their own stock — database contract test.
--
-- Every physical stock movement used to need an Administrator: the manager
-- asked, an Administrator approved, and an Administrator also pressed Receive
-- when the delivery arrived at the manager's branch. The person holding the
-- boxes was the one person who could not say they had arrived.
--
-- Two things this must NOT become:
--
--   Approval moving stock. approve_pos_request deliberately touches no
--   quantity, because approval means the business agreed to buy -- not that
--   goods exist. Checked here so nobody "fixes" it later.
--
--   A manager typing a cost. They confirm units arrived, which they can see;
--   what those units cost is on an invoice they do not hold.
--
-- Run:
--   docker exec -i supabase_db_harmony-suite psql -U postgres -d postgres \
--     -v ON_ERROR_STOP=1 -f - < supabase/tests/pos_manager_inventory_rls.sql
--
-- One transaction, rolled back at the end. Nothing is written.

begin;

/** A Finance Staff reviewer.
 *
 * F4.1 moved restock review out of the Administrator's hands: a branch asking
 * for stock is asking Finance to buy something. These suites therefore need a
 * finance actor for the restock steps, and keep the Administrator for the
 * catalogue ones.
 */
create or replace function pg_temp.finance_reviewer()
returns uuid
language plpgsql as $helper$
declare
  _emp uuid; _uid uuid; _pos uuid; _dept uuid; _admin uuid;
  _tag text := left(replace(gen_random_uuid()::text, '-', ''), 8);
  _saved text := current_setting('request.jwt.claims', true);
begin
  select id into _admin from public.profiles where role='admin' and status='active' limit 1;
  perform set_config('request.jwt.claims',
    json_build_object('sub', _admin, 'role', 'authenticated')::text, true);

  select p.id, p.department_id into _pos, _dept
  from public.positions p where lower(p.title) = 'finance staff' limit 1;
  if _pos is null then raise exception 'fixture: no Finance Staff position'; end if;

  insert into public.employees (first_name, last_name, email, department_id, position_id,
                                hire_date, employment_status)
  values ('ZZ', 'Fin Reviewer ' || _tag, 'zz.fin.' || _tag || '@jmac-test.invalid',
          _dept, _pos, current_date, 'active')
  returning id into _emp;

  insert into auth.users (instance_id, id, aud, role, email, encrypted_password,
                          email_confirmed_at, raw_app_meta_data, raw_user_meta_data,
                          created_at, updated_at, confirmation_token, email_change,
                          email_change_token_new, recovery_token)
  values ('00000000-0000-0000-0000-000000000000', gen_random_uuid(), 'authenticated',
          'authenticated', 'zz.fin.' || _tag || '@jmac-test.invalid',
          crypt('x', gen_salt('bf')), now(),
          '{"provider":"email","providers":["email"]}', '{}', now(), now(), '', '', '', '')
  returning id into _uid;

  update public.profiles set employee_id = _emp, status = 'active' where id = _uid;
  perform set_config('request.jwt.claims', coalesce(_saved, ''), true);
  return _uid;
end;
$helper$;


create or replace function pg_temp.acts_as(_uid uuid) returns void
language sql as $$
  select set_config('request.jwt.claims',
    json_build_object('sub', _uid, 'role', 'authenticated')::text, true);
$$;

do $$
declare
  admin_id uuid;
  mgr_uid  uuid;
  cash_uid uuid;
  branch_a uuid;
  branch_b uuid;
  ops_dept uuid;
  mgr_pos  uuid;
  cash_pos uuid;
  general  uuid;
  product  uuid;
  emp      uuid;
  n        integer;
  before_q integer;
  req      uuid;
  txt      text;
  tag      text := left(replace(gen_random_uuid()::text, '-', ''), 8);
begin
  select id into admin_id from public.profiles where role='admin' and status='active' limit 1;
  select id into branch_a from public.branches where is_active order by name limit 1;
  select id into branch_b from public.branches where is_active and id <> branch_a order by name limit 1;
  select id into general from public.pos_product_categories where lower(name)='general' limit 1;
  select p.id, p.department_id into mgr_pos, ops_dept from public.positions p
    join public.position_system_roles r on r.position_id=p.id and r.system='pos' and r.role_code='manager' limit 1;
  select p.id into cash_pos from public.positions p
    join public.position_system_roles r on r.position_id=p.id and r.system='pos' and r.role_code='cashier' limit 1;

  if admin_id is null or branch_a is null or branch_b is null or general is null
     or mgr_pos is null or cash_pos is null then
    raise exception 'fixture: need an admin, two branches, General, a manager position and a cashier position';
  end if;

  -- Manager at branch A.
  insert into public.employees (first_name, last_name, email, department_id, position_id, hire_date, employment_status)
  values ('ZZ','Inv Mgr '||tag,'zz.invmgr.'||tag||'@jmac-test.invalid',ops_dept,mgr_pos,current_date,'active')
  returning id into emp;
  insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
                          raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
                          confirmation_token, email_change, email_change_token_new, recovery_token)
  values ('00000000-0000-0000-0000-000000000000', gen_random_uuid(), 'authenticated','authenticated',
          'zz.invmgr.'||tag||'@jmac-test.invalid', crypt('x', gen_salt('bf')), now(),
          '{"provider":"email","providers":["email"]}','{}',now(),now(),'','','','')
  returning id into mgr_uid;
  update public.profiles set employee_id=emp, role='employee', status='active' where id=mgr_uid;
  delete from public.pos_branch_assignments where profile_id=mgr_uid;
  insert into public.pos_branch_assignments (profile_id, branch_id, pos_role, status)
  values (mgr_uid, branch_a, 'manager', 'active');

  -- Cashier at branch A.
  insert into public.employees (first_name, last_name, email, department_id, position_id, hire_date, employment_status)
  values ('ZZ','Inv Cash '||tag,'zz.invcash.'||tag||'@jmac-test.invalid',ops_dept,cash_pos,current_date,'active')
  returning id into emp;
  insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
                          raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
                          confirmation_token, email_change, email_change_token_new, recovery_token)
  values ('00000000-0000-0000-0000-000000000000', gen_random_uuid(), 'authenticated','authenticated',
          'zz.invcash.'||tag||'@jmac-test.invalid', crypt('x', gen_salt('bf')), now(),
          '{"provider":"email","providers":["email"]}','{}',now(),now(),'','','','')
  returning id into cash_uid;
  update public.profiles set employee_id=emp, role='employee', status='active' where id=cash_uid;
  delete from public.pos_branch_assignments where profile_id=cash_uid;
  insert into public.pos_branch_assignments (profile_id, branch_id, pos_role, status)
  values (cash_uid, branch_a, 'cashier', 'active');

  -- A product carried at both branches, with known cost at A.
  insert into public.pos_products (name, category_id, default_selling_price, default_unit_cost, status)
  values ('ZZ Inv '||tag, general, 100, 60, 'active') returning id into product;
  insert into public.pos_branch_products (branch_id, product_id, is_available)
  values (branch_a, product, true), (branch_b, product, true);

  perform set_config('request.jwt.claims',
    json_build_object('sub', admin_id, 'role','authenticated')::text, true);
  perform public.receive_pos_stock(branch_a, product, 10, 60, 'opening stock');

  select quantity_on_hand into before_q from public.pos_branch_inventory
   where branch_id=branch_a and product_id=product;
  if before_q <> 10 then raise exception 'FAIL  0a fixture stock is %', before_q; end if;

  -- ======================================================================
  -- 1. The manager receives a delivery at their own branch
  -- ======================================================================
  perform pg_temp.acts_as(mgr_uid);
  set local role authenticated;
  perform public.receive_pos_stock(branch_a, product, 5, null, 'delivery arrived');
  reset role;

  select quantity_on_hand into n from public.pos_branch_inventory
   where branch_id=branch_a and product_id=product;
  if n <> 15 then raise exception 'FAIL  1a stock is % after receiving 5, expected 15', n; end if;
  raise notice 'PASS  1a a manager may receive a delivery at their own branch';

  -- Through the ledger, like everything else.
  select count(*) into n from public.pos_inventory_movements
   where branch_id=branch_a and product_id=product and movement_type='receipt' and actor_id=mgr_uid;
  if n <> 1 then raise exception 'FAIL  1b the receipt left % ledger entries', n; end if;
  raise notice 'PASS  1b the movement is recorded against the manager who received it';

  -- The branch average is carried forward, not guessed at.
  select average_unit_cost into txt from public.pos_branch_inventory
   where branch_id=branch_a and product_id=product;
  if txt::numeric <> 60 then
    raise exception 'FAIL  1c the manager''s receipt moved the average cost to %', txt;
  end if;
  raise notice 'PASS  1c a manager''s receipt leaves the cost where procurement set it';

  -- ======================================================================
  -- 2. A manager does not set cost
  -- ======================================================================
  perform pg_temp.acts_as(mgr_uid);
  set local role authenticated;
  begin
    perform public.receive_pos_stock(branch_a, product, 1, 999, 'trying to price it');
    reset role;
    raise exception 'FAIL  2a a manager set a unit cost';
  exception when others then
    reset role;
    if sqlerrm like 'FAIL%' then raise; end if;
    raise notice 'PASS  2a a manager cannot set a unit cost when receiving';
  end;

  -- ======================================================================
  -- 3. Adjusting, with a reason
  -- ======================================================================
  perform pg_temp.acts_as(mgr_uid);
  set local role authenticated;
  perform public.adjust_pos_stock(branch_a, product, -2, 'damaged', 'crushed in transit');
  reset role;

  select quantity_on_hand into n from public.pos_branch_inventory
   where branch_id=branch_a and product_id=product;
  if n <> 13 then raise exception 'FAIL  3a stock is % after adjusting -2, expected 13', n; end if;
  raise notice 'PASS  3a a manager may adjust their own branch, with a reason';

  perform pg_temp.acts_as(mgr_uid);
  set local role authenticated;
  begin
    perform public.adjust_pos_stock(branch_a, product, -1, 'because', null);
    reset role;
    raise exception 'FAIL  3b an unrecognised adjustment reason was accepted';
  exception when others then
    reset role;
    if sqlerrm like 'FAIL%' then raise; end if;
    raise notice 'PASS  3b an adjustment still needs a reason from the known list';
  end;

  -- ======================================================================
  -- 4. Someone else's branch is still someone else's
  -- ======================================================================
  perform pg_temp.acts_as(mgr_uid);
  set local role authenticated;
  begin
    perform public.receive_pos_stock(branch_b, product, 5, null, 'not my branch');
    reset role;
    raise exception 'FAIL  4a a manager received stock at another branch';
  exception when others then
    reset role;
    if sqlerrm like 'FAIL%' then raise; end if;
    raise notice 'PASS  4a a manager cannot receive at a branch they do not manage';
  end;

  perform pg_temp.acts_as(mgr_uid);
  set local role authenticated;
  begin
    perform public.adjust_pos_stock(branch_b, product, -1, 'recount', null);
    reset role;
    raise exception 'FAIL  4b a manager adjusted another branch';
  exception when others then
    reset role;
    if sqlerrm like 'FAIL%' then raise; end if;
    raise notice 'PASS  4b a manager cannot adjust a branch they do not manage';
  end;

  -- ======================================================================
  -- 5. A cashier does neither
  -- ======================================================================
  perform pg_temp.acts_as(cash_uid);
  set local role authenticated;
  begin
    perform public.receive_pos_stock(branch_a, product, 5, null, null);
    reset role;
    raise exception 'FAIL  5a a cashier received stock';
  exception when others then
    reset role;
    if sqlerrm like 'FAIL%' then raise; end if;
    raise notice 'PASS  5a a cashier cannot receive stock';
  end;

  perform pg_temp.acts_as(cash_uid);
  set local role authenticated;
  begin
    perform public.adjust_pos_stock(branch_a, product, -1, 'recount', null);
    reset role;
    raise exception 'FAIL  5b a cashier adjusted stock';
  exception when others then
    reset role;
    if sqlerrm like 'FAIL%' then raise; end if;
    raise notice 'PASS  5b a cashier cannot adjust stock';
  end;

  -- ======================================================================
  -- 6. Nobody types a quantity directly
  -- ======================================================================
  perform pg_temp.acts_as(mgr_uid);
  set local role authenticated;
  begin
    update public.pos_branch_inventory set quantity_on_hand = 500
     where branch_id=branch_a and product_id=product;
    get diagnostics n = row_count;
    reset role;
    if n <> 0 then
      raise exception 'FAIL  6a a manager wrote a quantity directly on % row(s)', n;
    end if;
    raise notice 'PASS  6a quantities move only through the inventory engines';
  exception when insufficient_privilege or raise_exception then
    reset role;
    if sqlerrm like 'FAIL%' then raise; end if;
    raise notice 'PASS  6a quantities move only through the inventory engines';
  end;

  -- ======================================================================
  -- 7. Approval is not receipt
  -- ======================================================================
  --
  -- The check this file exists to protect. Approving a restock request means
  -- the business agreed to buy; it does not mean anything arrived. If this ever
  -- starts failing because approval moves stock, the ledger has begun inventing
  -- units nobody received.
  select quantity_on_hand into before_q from public.pos_branch_inventory
   where branch_id=branch_a and product_id=product;

  perform pg_temp.acts_as(mgr_uid);
  set local role authenticated;
  -- Through the same engine the screen uses. A manager cannot write this table
  -- directly -- nor read it -- which is itself part of the design, so the id
  -- comes back from the call rather than from a query.
  req := public.create_pos_stock_request(branch_a, product, 20, 'running low');
  reset role;

  -- Restock review is Finance's now, not the Administrator's.
  perform set_config('request.jwt.claims',
    json_build_object('sub', pg_temp.finance_reviewer(), 'role','authenticated')::text, true);
  set local role authenticated;
  perform public.approve_pos_request(req, null);
  reset role;

  select quantity_on_hand into n from public.pos_branch_inventory
   where branch_id=branch_a and product_id=product;
  if n <> before_q then
    raise exception 'FAIL  7a approving a request moved stock from % to %', before_q, n;
  end if;
  raise notice 'PASS  7a approving a request approves a purchase -- it moves no stock';

  -- ======================================================================
  -- 8. Stock does not enter at a cost nobody established
  -- ======================================================================
  --
  -- A manager may receive without naming a cost, because the invoice is not in
  -- their hands. The fallback used to be the branch average -- which for a
  -- product nobody had ever bought is 0, so ten real units entered valued at
  -- nothing. Stock at zero cost reports as free inventory with infinite margin,
  -- and every figure downstream inherits it.
  perform pg_temp.acts_as(mgr_uid);
  set local role authenticated;
  declare
    _fresh uuid;
    _before int;
  begin
    _fresh := public.create_pos_product_for_branch(branch_a, 'ZZ Unvalued ' || tag, general, 40);

    select quantity_on_hand into _before from public.pos_branch_inventory
     where branch_id = branch_a and product_id = _fresh;

    begin
      perform public.receive_pos_stock(branch_a, _fresh, 10, null, 'first delivery');
      reset role;
      raise exception 'FAIL  8a stock was received with no cost basis';
    exception when others then
      if sqlerrm like 'FAIL%' then raise; end if;
      if sqlerrm not like '%Purchase cost has not been established%' then
        raise exception 'FAIL  8a refused with the wrong reason: %', sqlerrm;
      end if;
    end;

    -- Refused means refused: nothing moved, and no ledger entry claims it did.
    select quantity_on_hand into n from public.pos_branch_inventory
     where branch_id = branch_a and product_id = _fresh;
    if n <> _before then
      raise exception 'FAIL  8b a refused receipt still moved stock from % to %', _before, n;
    end if;
    select count(*) into n from public.pos_inventory_movements
     where branch_id = branch_a and product_id = _fresh;
    if n <> 0 then
      raise exception 'FAIL  8c a refused receipt wrote % movement rows', n;
    end if;
    reset role;
    raise notice 'PASS  8a-c receiving is refused with no cost basis, and nothing moves';

    -- Once somebody with the authority establishes it, the manager may receive.
    perform set_config('request.jwt.claims',
      json_build_object('sub', admin_id, 'role','authenticated')::text, true);
    perform public.receive_pos_stock(branch_a, _fresh, 4, 25, 'opening, priced by finance');

    perform pg_temp.acts_as(mgr_uid);
    set local role authenticated;
    perform public.receive_pos_stock(branch_a, _fresh, 6, null, 'second delivery');
    reset role;

    select quantity_on_hand into n from public.pos_branch_inventory
     where branch_id = branch_a and product_id = _fresh;
    if n <> 10 then
      raise exception 'FAIL  8d stock is % after 4 + 6, expected 10', n;
    end if;

    select average_unit_cost into txt from public.pos_branch_inventory
     where branch_id = branch_a and product_id = _fresh;
    if txt::numeric <> 25 then
      raise exception 'FAIL  8e the established valuation drifted to %', txt;
    end if;
    raise notice 'PASS  8d-e once a cost is established, the manager receives against it';
  end;

  raise notice '--- all manager inventory checks passed ---';
end $$;

rollback;

select 'inventory rows after rollback: ' || count(*)::text as verify
from public.pos_branch_inventory;
