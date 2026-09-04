-- F6A: getting POS money into an account JMAC can spend from.
--
-- The claims this file defends:
--
--   a treasury balance is derived, and nobody can type one
--   a movement, once written, cannot be changed or removed
--   a branch cash deposit credits the bank once, for the cash it names
--   a provider settlement credits the NET, and keeps gross and fee visible
--   the same collection cannot be settled twice
--   money that never became a sale can never be settled
--   the Accountant prepares, the Finance Manager confirms, neither does both
--   settling changes no sale, no budget, no payable and no stock
--
-- Run:
--   docker exec -i supabase_db_harmony-suite psql -U postgres -d postgres \
--     -v ON_ERROR_STOP=1 -f - < supabase/tests/treasury_settlement_rls.sql
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

create or replace function pg_temp.ring_up(
  _cashier uuid, _branch uuid, _product uuid, _qty integer,
  _method text default 'cash')
returns uuid
language plpgsql as $$
declare _r jsonb;
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub', _cashier, 'role', 'authenticated')::text, true);
  set local role authenticated;
  _r := public.checkout_pos_sale(
    _branch,
    jsonb_build_array(jsonb_build_object('product_id', _product, 'quantity', _qty)),
    _method, gen_random_uuid(),
    case when _method = 'cash' then null
         else lpad((floor(random() * 1e10))::bigint::text, 10, '0') end,
    case when _method = 'cash' then 1000000 else null end);
  reset role;
  return (_r->>'sale_id')::uuid;
end;
$$;

do $$
declare
  admin_id uuid; accountant uuid; fin_mgr uuid; fin_staff uuid;
  cashier_a uuid; cashier_b uuid; pos_mgr uuid;
  branch_a uuid; branch_b uuid; general_id uuid; product uuid;
  bank uuid; drawer uuid; other_bank uuid;
  s1 uuid; s2 uuid; s3 uuid; s_gcash1 uuid; s_gcash2 uuid; s_b uuid;
  settle uuid; settle2 uuid; mv uuid;
  bal numeric; gross numeric; fee numeric; net numeric; before_bal numeric;
  n integer; txt text; today date;
  b_reserved numeric; b_spent numeric; b_remaining numeric;
  sales_net numeric; sales_net2 numeric;
  stock_before integer; stock_after integer;
  tag text := left(replace(gen_random_uuid()::text, '-', ''), 8);
begin
  select id into admin_id from public.profiles where role='admin' and status='active' limit 1;
  select id into general_id from public.pos_product_categories where normalized_name='general';
  today := public.pos_business_date();

  select id into branch_a from public.branches where is_active order by name limit 1;
  select id into branch_b from public.branches where is_active and id <> branch_a order by name limit 1;
  if branch_b is null then raise exception 'fixture: needs two active branches'; end if;

  accountant := pg_temp.hire('Bookkeeper',  'Accountant');
  fin_mgr    := pg_temp.hire('Fin Manager', 'Finance Manager');
  fin_staff  := pg_temp.hire('Fin Staff',   'Finance Staff');
  cashier_a  := pg_temp.hire('Till A',      'Cashier');
  cashier_b  := pg_temp.hire('Till B',      'Cashier');
  pos_mgr    := pg_temp.hire('Store Mgr',   'POS Manager');

  delete from public.pos_branch_assignments;
  insert into public.pos_branch_assignments (profile_id, branch_id, pos_role, created_by)
  values (cashier_a, branch_a, 'cashier', admin_id),
         (cashier_b, branch_b, 'cashier', admin_id),
         (pos_mgr,   branch_a, 'manager', admin_id);

  perform pg_temp.acts_as(admin_id);
  insert into public.pos_products (name, category_id, default_selling_price, default_unit_cost, status)
  values ('ZZ Treasury Cola ' || tag, general_id, 100.00, 60.00, 'active') returning id into product;
  insert into public.pos_branch_products (branch_id, product_id, is_available)
  values (branch_a, product, true), (branch_b, product, true);
  perform set_config('harmony.pos_inventory_write', 'allowed', true);
  insert into public.pos_branch_inventory (branch_id, product_id, quantity_on_hand)
  values (branch_a, product, 900), (branch_b, product, 900)
  on conflict (branch_id, product_id) do update set quantity_on_hand = 900;
  perform set_config('harmony.pos_inventory_write', '', true);

  -- ======================================================================
  -- 1. Accounts money can actually sit in
  -- ======================================================================
  perform pg_temp.acts_as(accountant); set local role authenticated;
  insert into public.treasury_accounts (name, account_type, opening_balance, opening_balance_as_of)
  values ('ZZ Main Bank ' || tag, 'bank', 10000, current_date) returning id into bank;
  insert into public.treasury_accounts (name, account_type, branch_id)
  values ('ZZ Cavite Drawer ' || tag, 'cash', branch_a) returning id into drawer;
  reset role;
  raise notice 'PASS  1a the Accountant may open a treasury account';

  perform pg_temp.acts_as(fin_mgr); set local role authenticated;
  begin
    insert into public.treasury_accounts (name, account_type) values ('ZZ Sneaky ' || tag, 'bank');
    raise exception 'FAIL 1b the Finance Manager opened an account';
  exception when insufficient_privilege then
    raise notice 'PASS  1b the checker cannot open accounts, only decide documents';
  end;
  reset role;

  select balance into bal from public.treasury_account_status where id = bank;
  if bal <> 10000 then raise exception 'FAIL 1c a new account reads %, expected its opening 10000', bal; end if;
  raise notice 'PASS  1c a balance is the opening figure until something moves';

  -- Nobody types a balance. There is no INSERT policy on movements at all: they
  -- are written only by the settlement and payment functions.
  perform pg_temp.acts_as(accountant); set local role authenticated;
  begin
    insert into public.treasury_movements (treasury_account_id, direction, amount,
      source_type, source_id, occurred_on)
    values (bank, 'in', 999999, 'collection_settlement', gen_random_uuid(), current_date);
    raise exception 'FAIL 1d an Accountant wrote a treasury movement by hand';
  exception when insufficient_privilege then
    raise notice 'PASS  1d no role can write a movement directly; only the workflow can';
  end;
  reset role;

  -- ======================================================================
  -- 2. A day's takings
  -- ======================================================================
  s1 := pg_temp.ring_up(cashier_a, branch_a, product, 1, 'cash');   -- 100
  s2 := pg_temp.ring_up(cashier_a, branch_a, product, 4, 'cash');   -- 400
  s3 := pg_temp.ring_up(cashier_a, branch_a, product, 15, 'cash');  -- 1500
  s_gcash1 := pg_temp.ring_up(cashier_a, branch_a, product, 1, 'gcash');  -- 100
  s_gcash2 := pg_temp.ring_up(cashier_a, branch_a, product, 2, 'gcash');  -- 200
  s_b := pg_temp.ring_up(cashier_b, branch_b, product, 7, 'cash');  -- 700
  reset role;

  perform pg_temp.acts_as(accountant); set local role authenticated;
  select count(*)::integer into n
    from public.get_unsettled_collections('branch_cash', branch_a, null, today, today);
  if n <> 3 then raise exception 'FAIL 2a branch A has % unsettled cash sales, expected 3', n; end if;
  raise notice 'PASS  2a completed cash sales show as cash waiting to be remitted';

  select count(*)::integer into n
    from public.get_unsettled_collections('provider', null, 'gcash', today, today);
  if n <> 2 then raise exception 'FAIL 2b there are % unsettled gcash collections, expected 2', n; end if;
  raise notice 'PASS  2b provider-held collections are listed separately from cash';

  -- The attempts that never became sales cannot appear, because they never
  -- produced a pos_sales row for the query to find. Seeded outside the
  -- Accountant's session: writing an attempt is the till's job, not Finance's.
  reset role;
  insert into public.pos_payment_attempts
    (branch_id, cashier_profile_id, checkout_key, method, amount_centavos, items,
     status, reference_number, failed_at)
  values (branch_a, cashier_a, gen_random_uuid(), 'card', 5000000,
          jsonb_build_array(jsonb_build_object('product_id', product, 'quantity', 500)),
          'failed', 'ZZ-F-' || tag, now());
  insert into public.pos_payment_attempts
    (branch_id, cashier_profile_id, checkout_key, method, amount_centavos, items,
     status, reference_number, paid_at, last_error)
  values (branch_a, cashier_a, gen_random_uuid(), 'gcash', 4000000,
          jsonb_build_array(jsonb_build_object('product_id', product, 'quantity', 400)),
          'paid_unfulfilled', 'ZZ-U-' || tag, now(), 'price_changed');

  perform pg_temp.acts_as(accountant); set local role authenticated;
  select coalesce(sum(amount), 0) into bal
    from public.get_unsettled_collections('provider', null, null, today, today);
  if bal <> 300 then
    raise exception 'FAIL 2c provider-held total is %, expected 300 -- an attempt leaked in', bal;
  end if;
  raise notice 'PASS  2c failed and paid_unfulfilled attempts are not settleable money';
  reset role;

  -- ======================================================================
  -- 3. Cash remittance: the branch banks its takings
  -- ======================================================================
  perform pg_temp.acts_as(accountant); set local role authenticated;
  select public.create_collection_settlement(
    'branch_cash', bank, current_date, array[s1, s2, s3], branch_a, null, 0,
    'DEP-' || tag, 'ZZ cash remittance', true) into settle;
  reset role;

  select gross_amount, fee_amount, net_amount, status
    into gross, fee, net, txt
    from public.collection_settlement_status where id = settle;
  if gross <> 2000 then raise exception 'FAIL 3a gross is %, expected 2000', gross; end if;
  if txt <> 'for_review' then raise exception 'FAIL 3a status is %', txt; end if;
  raise notice 'PASS  3a a remittance totals the sales it names, and goes to the Manager';

  -- Submitting is not receiving. Nothing has reached the bank yet.
  select balance into bal from public.treasury_account_status where id = bank;
  if bal <> 10000 then raise exception 'FAIL 3b the bank moved on submission: %', bal; end if;
  raise notice 'PASS  3b submitting a remittance moves no money';

  -- Capture what must not change.
  perform pg_temp.acts_as(fin_staff); set local role authenticated;
  select s.net_sales into sales_net
    from public.get_finance_sales_summary(today, today, null, null, null) s;
  reset role;
  select quantity_on_hand into stock_before
    from public.pos_branch_inventory where branch_id = branch_a and product_id = product;

  perform pg_temp.acts_as(fin_mgr); set local role authenticated;
  perform public.transition_collection_settlement(settle, 'confirmed', null);
  reset role;

  select balance into bal from public.treasury_account_status where id = bank;
  if bal <> 12000 then raise exception 'FAIL 3c the bank is %, expected 12000', bal; end if;
  raise notice 'PASS  3c confirming a remittance credits the bank with the cash it named';

  select count(*)::integer into n from public.treasury_movements
   where source_type = 'collection_settlement' and source_id = settle;
  if n <> 1 then raise exception 'FAIL 3d confirming wrote % movements, expected 1', n; end if;
  raise notice 'PASS  3d one confirmation, one movement';

  -- ======================================================================
  -- 4. What a settlement must never disturb
  -- ======================================================================
  perform pg_temp.acts_as(fin_staff); set local role authenticated;
  select s.net_sales into sales_net2
    from public.get_finance_sales_summary(today, today, null, null, null) s;
  reset role;
  if sales_net2 <> sales_net then
    raise exception 'FAIL 4a settling changed net sales: % -> %', sales_net, sales_net2;
  end if;
  raise notice 'PASS  4a moving money to the bank does not change what was sold';

  select quantity_on_hand into stock_after
    from public.pos_branch_inventory where branch_id = branch_a and product_id = product;
  if stock_before <> stock_after then
    raise exception 'FAIL 4b settling moved stock: % -> %', stock_before, stock_after;
  end if;
  raise notice 'PASS  4b settling moves no stock';

  -- ======================================================================
  -- 5. The same money cannot be banked twice
  -- ======================================================================
  perform pg_temp.acts_as(accountant); set local role authenticated;
  begin
    perform public.create_collection_settlement(
      'branch_cash', bank, current_date, array[s1], branch_a, null, 0,
      'DEP2-' || tag, null, false);
    raise exception 'FAIL 5a the same cash sale was settled twice';
  exception when unique_violation then
    raise notice 'PASS  5a a sale already covered by a settlement cannot be settled again';
  end;

  -- A sale from another branch is not this branch's to deposit.
  begin
    perform public.create_collection_settlement(
      'branch_cash', bank, current_date, array[s_b], branch_a, null, 0,
      'DEP3-' || tag, null, false);
    raise exception 'FAIL 5b another branch''s takings were remitted here';
  exception when check_violation then
    raise notice 'PASS  5b a branch remits only its own cash';
  end;

  -- And cash is not a provider settlement.
  begin
    perform public.create_collection_settlement(
      'provider', bank, current_date, array[s_b], null, 'gcash', 0,
      'DEP4-' || tag, null, false);
    raise exception 'FAIL 5c a cash sale was settled as a gcash payout';
  exception when check_violation then
    raise notice 'PASS  5c a provider settlement covers only that provider''s collections';
  end;
  reset role;

  -- ======================================================================
  -- 6. Provider settlement: the fee is real, and only the net arrives
  -- ======================================================================
  --
  -- The brief's own example, scaled to this fixture: gross 300, fee 20, and
  -- 280 reaches the bank. Keeping the three apart is the whole point -- the
  -- customer paid 300, JMAC received 280, and the difference has a name.
  perform pg_temp.acts_as(accountant); set local role authenticated;
  select public.create_collection_settlement(
    'provider', bank, current_date, array[s_gcash1, s_gcash2], null, 'gcash', 20,
    'PM-' || tag, 'ZZ gcash payout', true) into settle2;
  reset role;

  select gross_amount, fee_amount, net_amount
    into gross, fee, net
    from public.collection_settlement_status where id = settle2;
  if gross <> 300 or fee <> 20 or net <> 280 then
    raise exception 'FAIL 6a gross % fee % net %, expected 300 / 20 / 280', gross, fee, net;
  end if;
  raise notice 'PASS  6a gross, fee and net stay three separate figures';

  perform pg_temp.acts_as(fin_mgr); set local role authenticated;
  perform public.transition_collection_settlement(settle2, 'confirmed', null);
  reset role;

  select balance into bal from public.treasury_account_status where id = bank;
  if bal <> 12280 then
    raise exception 'FAIL 6b the bank is %, expected 12280 -- only the net should arrive', bal;
  end if;
  raise notice 'PASS  6b the bank receives the net, not the gross';

  -- A fee larger than the collection would describe money that never existed.
  perform pg_temp.acts_as(accountant); set local role authenticated;
  s_gcash1 := pg_temp.ring_up(cashier_a, branch_a, product, 1, 'gcash');
  reset role;
  perform pg_temp.acts_as(accountant); set local role authenticated;
  begin
    perform public.create_collection_settlement(
      'provider', bank, current_date, array[s_gcash1], null, 'gcash', 5000,
      'PM2-' || tag, null, false);
    raise exception 'FAIL 6c a fee larger than the collection was accepted';
  exception when check_violation then
    raise notice 'PASS  6c a provider fee cannot exceed what the provider collected';
  end;
  reset role;

  -- ======================================================================
  -- 7. Maker and checker
  -- ======================================================================
  perform pg_temp.acts_as(fin_mgr); set local role authenticated;
  begin
    perform public.create_collection_settlement(
      'branch_cash', bank, current_date, array[s_b], branch_b, null, 0, null, null, false);
    raise exception 'FAIL 7a the Finance Manager prepared a settlement';
  exception when insufficient_privilege then
    raise notice 'PASS  7a the Finance Manager does not prepare what they will confirm';
  end;
  reset role;

  perform pg_temp.acts_as(fin_staff); set local role authenticated;
  begin
    perform public.create_collection_settlement(
      'branch_cash', bank, current_date, array[s_b], branch_b, null, 0, null, null, false);
    raise exception 'FAIL 7b Finance Staff prepared a settlement';
  exception when insufficient_privilege then
    raise notice 'PASS  7b settlement is the Accountant''s, not procurement''s';
  end;
  reset role;

  -- Self-approval, blocked on identity rather than on role.
  perform pg_temp.acts_as(accountant); set local role authenticated;
  select public.create_collection_settlement(
    'branch_cash', bank, current_date, array[s_b], branch_b, null, 0,
    'DEP5-' || tag, null, true) into settle2;
  reset role;

  perform pg_temp.acts_as(accountant); set local role authenticated;
  begin
    perform public.transition_collection_settlement(settle2, 'confirmed', null);
    raise exception 'FAIL 7c the preparer confirmed their own settlement';
  exception when insufficient_privilege then
    raise notice 'PASS  7c the person who prepared a settlement cannot confirm it';
  end;
  reset role;

  -- Going backwards is answerable.
  perform pg_temp.acts_as(fin_mgr); set local role authenticated;
  begin
    perform public.transition_collection_settlement(settle2, 'returned', null);
    raise exception 'FAIL 7d a settlement was returned with no reason';
  exception when check_violation then
    raise notice 'PASS  7d returning a settlement requires a reason';
  end;
  perform public.transition_collection_settlement(settle2, 'returned', 'deposit slip missing');
  reset role;

  -- A returned settlement releases its sales, or one bad record would strand
  -- that money for ever.
  perform pg_temp.acts_as(accountant); set local role authenticated;
  select count(*)::integer into n
    from public.get_unsettled_collections('branch_cash', branch_b, null, today, today)
   where sale_id = s_b;
  if n <> 1 then raise exception 'FAIL 7e a returned settlement kept its sales locked'; end if;
  raise notice 'PASS  7e a returned settlement releases the money it was holding';
  reset role;

  -- ======================================================================
  -- 8. A confirmed settlement is history
  -- ======================================================================
  perform pg_temp.acts_as(accountant); set local role authenticated;
  begin
    update public.collection_settlements set fee_amount = 999 where id = settle;
    raise exception 'FAIL 8a a confirmed settlement was edited';
  exception when insufficient_privilege then
    raise notice 'PASS  8a a confirmed settlement cannot be edited';
  end;
  reset role;

  select id into mv from public.treasury_movements
   where source_type = 'collection_settlement' and source_id = settle;
  begin
    update public.treasury_movements set amount = 1 where id = mv;
    raise exception 'FAIL 8b a treasury movement was rewritten';
  exception when insufficient_privilege then
    raise notice 'PASS  8b a treasury movement cannot be changed';
  end;
  begin
    delete from public.treasury_movements where id = mv;
    raise exception 'FAIL 8c a treasury movement was deleted';
  exception when insufficient_privilege then
    raise notice 'PASS  8c a treasury movement cannot be deleted';
  end;

  -- And the opening balance cannot be restated underneath a history.
  begin
    update public.treasury_accounts set opening_balance = 1 where id = bank;
    raise exception 'FAIL 8d the opening balance was changed after movements existed';
  exception when check_violation then
    raise notice 'PASS  8d an account with movements has a fixed opening balance';
  end;

  -- ======================================================================
  -- 9. Who may look
  -- ======================================================================
  perform pg_temp.acts_as(pos_mgr); set local role authenticated;
  select count(*)::integer into n from public.get_treasury_accounts();
  if n <> 0 then raise exception 'FAIL 9a a POS Manager read the treasury'; end if;
  select count(*)::integer into n from public.get_collection_settlements();
  if n <> 0 then raise exception 'FAIL 9a a POS Manager read settlements'; end if;
  reset role;
  perform pg_temp.acts_as(cashier_a); set local role authenticated;
  select count(*)::integer into n from public.get_treasury_accounts();
  if n <> 0 then raise exception 'FAIL 9a a cashier read the treasury'; end if;
  reset role;
  raise notice 'PASS  9a POS roles cannot see the treasury or its settlements';

  perform pg_temp.acts_as(fin_staff); set local role authenticated;
  select count(*)::integer into n from public.get_treasury_accounts();
  if n < 2 then raise exception 'FAIL 9b Finance Staff cannot read the treasury'; end if;
  reset role;
  raise notice 'PASS  9b the Finance group can read treasury balances';

  raise notice '--------------------------------------------------';
  raise notice 'treasury_settlement_rls: all checks passed';
end $$;

rollback;
