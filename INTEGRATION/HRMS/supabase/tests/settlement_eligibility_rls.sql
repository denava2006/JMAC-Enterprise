-- What is still waiting to be settled, and for how long it keeps waiting.
--
-- Three defects from hosted acceptance, pinned here so they cannot come back:
--
--   an unsettled collection stayed eligible for exactly one Manila day, then
--     silently vanished, because the query defaulted its date range to today
--   legacy 'maya' and current 'paymaya' were separate buckets, so historical
--     Maya rows were unlistable and therefore unsettleable
--   a provider settlement could not be scoped to a branch
--
-- The first is the one that mattered. Money does not stop needing to be banked
-- because the day ended.
--
-- Run:
--   docker exec -i supabase_db_harmony-suite psql -U postgres -d postgres \
--     -v ON_ERROR_STOP=1 -f - < supabase/tests/settlement_eligibility_rls.sql
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
  _cashier uuid, _branch uuid, _product uuid, _qty integer, _method text)
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
  admin_id uuid; accountant uuid; fin_mgr uuid;
  cashier_a uuid; cashier_b uuid;
  branch_a uuid; branch_b uuid; general_id uuid; product uuid; bank uuid;
  gc_today uuid; gc_yesterday uuid; gc_week uuid; gc_b uuid;
  maya_legacy uuid; maya_current uuid; qr_sale uuid; cash_sale uuid;
  settle uuid; n integer; amt numeric; tz text; today date;
  tag text := left(replace(gen_random_uuid()::text, '-', ''), 8);
begin
  select id into admin_id from public.profiles where role='admin' and status='active' limit 1;
  select id into general_id from public.pos_product_categories where normalized_name='general';
  tz := public.pos_business_timezone();
  today := public.pos_business_date();

  select id into branch_a from public.branches where is_active order by name limit 1;
  select id into branch_b from public.branches where is_active and id <> branch_a order by name limit 1;
  if branch_b is null then raise exception 'fixture: needs two active branches'; end if;

  accountant := pg_temp.hire('Bookkeeper',  'Accountant');
  fin_mgr    := pg_temp.hire('Fin Manager', 'Finance Manager');
  cashier_a  := pg_temp.hire('Till A',      'Cashier');
  cashier_b  := pg_temp.hire('Till B',      'Cashier');

  delete from public.pos_branch_assignments;
  insert into public.pos_branch_assignments (profile_id, branch_id, pos_role, created_by)
  values (cashier_a, branch_a, 'cashier', admin_id),
         (cashier_b, branch_b, 'cashier', admin_id);

  perform pg_temp.acts_as(admin_id);
  insert into public.pos_products (name, category_id, default_selling_price, default_unit_cost, status)
  values ('ZZ Eligibility Cola ' || tag, general_id, 100.00, 60.00, 'active') returning id into product;
  insert into public.pos_branch_products (branch_id, product_id, is_available)
  values (branch_a, product, true), (branch_b, product, true);
  perform set_config('harmony.pos_inventory_write', 'allowed', true);
  insert into public.pos_branch_inventory (branch_id, product_id, quantity_on_hand)
  values (branch_a, product, 900), (branch_b, product, 900)
  on conflict (branch_id, product_id) do update set quantity_on_hand = 900;
  perform set_config('harmony.pos_inventory_write', '', true);

  perform pg_temp.acts_as(accountant); set local role authenticated;
  insert into public.treasury_accounts (name, account_type, opening_balance, opening_balance_as_of)
  values ('ZZ Bank ' || tag, 'bank', 5000, current_date) returning id into bank;
  reset role;

  -- A week of trading, then backdated so the ages are real.
  gc_today     := pg_temp.ring_up(cashier_a, branch_a, product, 1, 'gcash');   -- 100
  gc_yesterday := pg_temp.ring_up(cashier_a, branch_a, product, 2, 'gcash');   -- 200
  gc_week      := pg_temp.ring_up(cashier_a, branch_a, product, 3, 'gcash');   -- 300
  gc_b         := pg_temp.ring_up(cashier_b, branch_b, product, 4, 'gcash');   -- 400
  maya_current := pg_temp.ring_up(cashier_a, branch_a, product, 5, 'paymaya'); -- 500
  qr_sale      := pg_temp.ring_up(cashier_a, branch_a, product, 6, 'qrph');    -- 600
  cash_sale    := pg_temp.ring_up(cashier_a, branch_a, product, 7, 'cash');    -- 700
  reset role;

  update public.pos_sales
     set created_at = ((today - 1)::text || ' 14:00')::timestamp at time zone tz
   where id = gc_yesterday;
  update public.pos_sales
     set created_at = ((today - 7)::text || ' 14:00')::timestamp at time zone tz
   where id = gc_week;

  -- A legacy Maya row. checkout_pos_sale writes 'paymaya' now, so the only
  -- honest way to have one is the way production has one: an older row that
  -- predates the rename. The pos_sales CHECK still permits it, which is why
  -- these rows exist at all.
  maya_legacy := pg_temp.ring_up(cashier_a, branch_a, product, 8, 'paymaya');  -- 800
  reset role;
  update public.pos_sales set payment_method = 'maya',
         created_at = ((today - 30)::text || ' 14:00')::timestamp at time zone tz
   where id = maya_legacy;

  perform pg_temp.acts_as(accountant); set local role authenticated;

  -- ======================================================================
  -- 1. Money keeps waiting until it is settled
  -- ======================================================================
  --
  -- The defect: with no date filter the query bounded itself to today, so a
  -- sale from yesterday was simply gone.
  select count(*)::integer into n
    from public.get_unsettled_collections('provider', branch_a, 'gcash', null, null)
   where sale_id = gc_yesterday;
  if n <> 1 then raise exception 'FAIL 1a yesterday''s unsettled GCash sale disappeared'; end if;
  raise notice 'PASS  1a an unsettled sale from yesterday is still eligible today';

  select count(*)::integer into n
    from public.get_unsettled_collections('provider', branch_a, 'gcash', null, null)
   where sale_id = gc_week;
  if n <> 1 then raise exception 'FAIL 1b a week-old unsettled sale disappeared'; end if;
  raise notice 'PASS  1b so is one from a week ago';

  select count(*)::integer into n
    from public.get_unsettled_collections('provider', branch_a, null, null, null)
   where sale_id = maya_legacy;
  if n <> 1 then raise exception 'FAIL 1c a month-old unsettled sale disappeared'; end if;
  raise notice 'PASS  1c and one from a month ago -- age is not a reason to stop owing';

  -- All three GCash sales at branch A, whatever their age.
  select coalesce(sum(amount), 0) into amt
    from public.get_unsettled_collections('provider', branch_a, 'gcash', null, null);
  if amt <> 600 then raise exception 'FAIL 1d branch A GCash totals %, expected 600', amt; end if;
  raise notice 'PASS  1d the default view is every outstanding collection, not today''s';

  -- ======================================================================
  -- 2. A date filter still works, and still means Manila days
  -- ======================================================================
  select count(*)::integer into n
    from public.get_unsettled_collections('provider', branch_a, 'gcash', today, today);
  if n <> 1 then raise exception 'FAIL 2a today-only gave % rows, expected 1', n; end if;
  raise notice 'PASS  2a asking for one day still gives one day';

  select count(*)::integer into n
    from public.get_unsettled_collections('provider', branch_a, 'gcash', today - 1, today);
  if n <> 2 then raise exception 'FAIL 2b two days gave % rows, expected 2', n; end if;
  raise notice 'PASS  2b a range covers the days it names';

  -- ======================================================================
  -- 3. Maya is one provider, spelled two ways
  -- ======================================================================
  select count(*)::integer into n
    from public.get_unsettled_collections('provider', branch_a, 'paymaya', null, null)
   where sale_id = maya_legacy;
  if n <> 1 then raise exception 'FAIL 3a a legacy maya sale is unreachable under Maya'; end if;
  raise notice 'PASS  3a choosing Maya finds the legacy ''maya'' rows';

  select count(*)::integer into n
    from public.get_unsettled_collections('provider', branch_a, 'paymaya', null, null)
   where sale_id = maya_current;
  if n <> 1 then raise exception 'FAIL 3b a current paymaya sale is missing under Maya'; end if;
  raise notice 'PASS  3b and the current ''paymaya'' rows, in the same list';

  select coalesce(sum(amount), 0) into amt
    from public.get_unsettled_collections('provider', branch_a, 'paymaya', null, null);
  if amt <> 1300 then raise exception 'FAIL 3c Maya totals %, expected 1300 (500 + 800)', amt; end if;
  raise notice 'PASS  3c both spellings total together, as one provider';

  -- Asking under the legacy spelling finds the same set: the family is
  -- normalised on both sides of the comparison.
  select coalesce(sum(amount), 0) into amt
    from public.get_unsettled_collections('provider', branch_a, 'maya', null, null);
  if amt <> 1300 then raise exception 'FAIL 3d asking as ''maya'' gave %, expected 1300', amt; end if;
  raise notice 'PASS  3d and either spelling may be asked for';

  -- Normalisation did not blur anything else together.
  if public.pos_provider_family('gcash') <> 'gcash'
     or public.pos_provider_family('card') <> 'card'
     or public.pos_provider_family('qrph') <> 'qrph'
     or public.pos_provider_family('cash') <> 'cash' then
    raise exception 'FAIL 3e the family function changed a method that is not Maya';
  end if;
  raise notice 'PASS  3e every other method is its own family, unchanged';

  -- ======================================================================
  -- 4. Branch narrows a provider settlement too
  -- ======================================================================
  select coalesce(sum(amount), 0) into amt
    from public.get_unsettled_collections('provider', branch_b, 'gcash', null, null);
  if amt <> 400 then raise exception 'FAIL 4a branch B GCash totals %, expected 400', amt; end if;
  raise notice 'PASS  4a a provider list can be narrowed to one branch';

  select coalesce(sum(amount), 0) into amt
    from public.get_unsettled_collections('provider', null, 'gcash', null, null);
  if amt <> 1000 then raise exception 'FAIL 4b all-branch GCash totals %, expected 1000', amt; end if;
  raise notice 'PASS  4b and left across all branches, as a real payout may be';

  -- ======================================================================
  -- 5. Cash is still cash
  -- ======================================================================
  select count(*)::integer into n
    from public.get_unsettled_collections('branch_cash', branch_a, null, null, null)
   where sale_id = cash_sale;
  if n <> 1 then raise exception 'FAIL 5a the cash sale is missing from the remittance list'; end if;
  select count(*)::integer into n
    from public.get_unsettled_collections('branch_cash', branch_a, null, null, null)
   where sale_id in (gc_today, maya_current, qr_sale);
  if n <> 0 then raise exception 'FAIL 5a a card or e-wallet sale appeared in the cash list'; end if;
  raise notice 'PASS  5a branch cash offers cash, and only cash';

  select count(*)::integer into n
    from public.get_unsettled_collections('provider', branch_a, null, null, null)
   where sale_id = cash_sale;
  if n <> 0 then raise exception 'FAIL 5b a cash sale appeared in a provider list'; end if;
  raise notice 'PASS  5b and a provider list never offers cash';

  -- QR Ph is present; Card genuinely has no sales, so it is genuinely empty.
  select count(*)::integer into n
    from public.get_unsettled_collections('provider', branch_a, 'qrph', null, null);
  if n <> 1 then raise exception 'FAIL 5c QR Ph gave % rows, expected 1', n; end if;
  select count(*)::integer into n
    from public.get_unsettled_collections('provider', branch_a, 'card', null, null);
  if n <> 0 then raise exception 'FAIL 5c Card gave % rows with no card sales', n; end if;
  raise notice 'PASS  5c QR Ph lists its sale; Card is empty because there are none';

  -- ======================================================================
  -- 6. Settling is what removes it, and only while the settlement counts
  -- ======================================================================
  select public.create_collection_settlement(
    'provider', bank, current_date, array[gc_week], branch_a, 'gcash', 0,
    'PM-' || tag, null, true) into settle;
  reset role;

  perform pg_temp.acts_as(accountant); set local role authenticated;
  select count(*)::integer into n
    from public.get_unsettled_collections('provider', branch_a, 'gcash', null, null)
   where sale_id = gc_week;
  if n <> 0 then raise exception 'FAIL 6a a sale on a live settlement is still offered'; end if;
  raise notice 'PASS  6a a sale covered by a live settlement drops out immediately';
  reset role;

  perform pg_temp.acts_as(fin_mgr); set local role authenticated;
  perform public.transition_collection_settlement(settle, 'confirmed', null);
  reset role;

  perform pg_temp.acts_as(accountant); set local role authenticated;
  select count(*)::integer into n
    from public.get_unsettled_collections('provider', branch_a, 'gcash', null, null)
   where sale_id = gc_week;
  if n <> 0 then raise exception 'FAIL 6b a confirmed sale came back'; end if;
  raise notice 'PASS  6b and stays out once the settlement is confirmed';

  -- A rejected settlement releases its sales, however old they are.
  select public.create_collection_settlement(
    'provider', bank, current_date, array[gc_yesterday], branch_a, 'gcash', 0,
    'PM2-' || tag, null, true) into settle;
  reset role;
  perform pg_temp.acts_as(fin_mgr); set local role authenticated;
  perform public.transition_collection_settlement(settle, 'rejected', 'wrong payout advice');
  reset role;

  perform pg_temp.acts_as(accountant); set local role authenticated;
  select count(*)::integer into n
    from public.get_unsettled_collections('provider', branch_a, 'gcash', null, null)
   where sale_id = gc_yesterday;
  if n <> 1 then raise exception 'FAIL 6c a rejected settlement kept its sale locked away'; end if;
  raise notice 'PASS  6c a rejected settlement releases its money back to the list';

  -- ======================================================================
  -- 7. The server holds the branch rule, not the form
  -- ======================================================================
  begin
    perform public.create_collection_settlement(
      'provider', bank, current_date, array[gc_b], branch_a, 'gcash', 0,
      'PM3-' || tag, null, false);
    raise exception 'FAIL 7a another branch''s sale went onto a branch-scoped settlement';
  exception when check_violation then
    raise notice 'PASS  7a a branch-scoped provider settlement refuses another branch''s sale';
  end;

  -- With no branch, a payout may span branches -- which is why branch is
  -- optional rather than required.
  select public.create_collection_settlement(
    'provider', bank, current_date, array[gc_today, gc_b], null, 'gcash', 0,
    'PM4-' || tag, null, false) into settle;
  select count(*)::integer into n
    from public.collection_settlement_items where settlement_id = settle;
  if n <> 2 then raise exception 'FAIL 7b an all-branch payout could not span branches'; end if;
  raise notice 'PASS  7b an unscoped payout may still cover several branches';

  -- And the family is stored canonically, so history reads one way.
  select public.create_collection_settlement(
    'provider', bank, current_date, array[maya_legacy], branch_a, 'maya', 0,
    'PM5-' || tag, null, false) into settle;
  select payment_method into tz from public.collection_settlements where id = settle;
  if tz <> 'paymaya' then
    raise exception 'FAIL 7c a settlement stored the method as %, expected the canonical paymaya', tz;
  end if;
  raise notice 'PASS  7c a settlement records the provider once, canonically';
  reset role;

  raise notice '--------------------------------------------------';
  raise notice 'settlement_eligibility_rls: all checks passed';
end $$;

rollback;
