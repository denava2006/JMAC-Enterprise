-- POS sells. Finance reads. Nothing in between writes anything.
--
-- The claims this file defends:
--
--   a pos_sales row is the sale-complete fact, and nothing else is
--   money that moved without producing a sale is not revenue
--   Finance's Net Sales equals the POS report's, to the centavo
--   the Philippine business day is the POS business day
--   Finance can read every branch and edit no sale
--   a cashier, a POS manager and an HR account see nothing here
--   selling changes no budget, no supplier balance, and no stock
--
-- Run:
--   docker exec -i supabase_db_harmony-suite psql -U postgres -d postgres \
--     -v ON_ERROR_STOP=1 -f - < supabase/tests/finance_sales_bridge_rls.sql
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

-- One completed cash sale, returned by id. The till's own function does it, so
-- the row under test is made the way production makes it.
create or replace function pg_temp.ring_up(
  _cashier uuid, _branch uuid, _product uuid, _qty integer,
  _method text default 'cash', _reference text default null)
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
    -- POS validates e-wallet references as 6-32 digits, so the fixture has to
    -- offer a real-looking one rather than a readable tag.
    case when _method = 'cash' then null
         else coalesce(_reference, lpad((floor(random() * 1e10))::bigint::text, 10, '0')) end,
    case when _method = 'cash' then 100000 else null end);
  reset role;
  return (_r->>'sale_id')::uuid;
end;
$$;

do $$
declare
  admin_id uuid; staff uuid; fin_mgr uuid; accountant uuid;
  cashier_a uuid; cashier_b uuid; pos_mgr uuid; hr_staff uuid;
  branch_a uuid; branch_b uuid; general_id uuid; product uuid;
  cat_id uuid; budget uuid; vendor uuid;
  sale_cash uuid; sale_online uuid; sale_b uuid; attempt uuid; linked_sale uuid;
  po uuid; po_line uuid; fin_req uuid; invoice uuid;
  tz text; today date; sale_day date;
  gross numeric; disc numeric; refunds numeric; net numeric;
  fees numeric; collected numeric; n integer; amt numeric;
  pos_product_sales numeric; pos_fees numeric; pos_collected numeric;
  b_ceiling numeric; b_reserved numeric; b_spent numeric;
  ap_count integer; ap_total numeric; ap_balance numeric;
  ap_count2 integer; ap_total2 numeric; ap_balance2 numeric;
  stock_before integer; stock_after integer; moves_before integer; moves_after integer;
  txt text; who text; method_out text; ok boolean;
  tag text := left(replace(gen_random_uuid()::text, '-', ''), 8);
  -- POS validates an e-wallet reference as 6-32 digits.
  gcash_ref text := lpad((floor(random() * 1e10))::bigint::text, 10, '0');
begin
  select id into admin_id from public.profiles where role='admin' and status='active' limit 1;
  select id into general_id from public.pos_product_categories where normalized_name = 'general';
  tz := public.pos_business_timezone();
  today := public.pos_business_date();

  select id into branch_a from public.branches where is_active order by name limit 1;
  select id into branch_b from public.branches where is_active and id <> branch_a order by name limit 1;
  if branch_b is null then raise exception 'fixture: needs two active branches'; end if;

  staff      := pg_temp.hire('Fin Staff',   'Finance Staff');
  fin_mgr    := pg_temp.hire('Fin Manager', 'Finance Manager');
  accountant := pg_temp.hire('Bookkeeper',  'Accountant');
  cashier_a  := pg_temp.hire('Till A',      'Cashier');
  cashier_b  := pg_temp.hire('Till B',      'Cashier');
  pos_mgr    := pg_temp.hire('Store Mgr',   'POS Manager');
  hr_staff   := pg_temp.hire('HR Person',   'HR Staff');

  delete from public.pos_branch_assignments;
  insert into public.pos_branch_assignments (profile_id, branch_id, pos_role, created_by)
  values (cashier_a, branch_a, 'cashier', admin_id),
         (cashier_b, branch_b, 'cashier', admin_id),
         (pos_mgr,   branch_a, 'manager', admin_id);

  -- A branch that charges a fixed convenience fee, so the difference between
  -- what the goods cost and what the customer handed over is real and testable.
  insert into public.branch_pos_settings (branch_id, fees)
  values (branch_a, jsonb_build_array(jsonb_build_object(
            'id', 'svc', 'name', 'Service Fee', 'type', 'fixed', 'value', 5, 'enabled', true)))
  on conflict (branch_id) do update set fees = excluded.fees;

  perform pg_temp.acts_as(admin_id);
  insert into public.pos_products (name, category_id, default_selling_price, default_unit_cost, status)
  values ('ZZ Sales Bridge Cola ' || tag, general_id, 100.00, 60.00, 'active') returning id into product;
  insert into public.pos_branch_products (branch_id, product_id, is_available)
  values (branch_a, product, true), (branch_b, product, true);
  -- Stock is guarded against direct writes; the seeding flag is the same one
  -- the real inventory operations set.
  perform set_config('harmony.pos_inventory_write', 'allowed', true);
  insert into public.pos_branch_inventory (branch_id, product_id, quantity_on_hand)
  values (branch_a, product, 500), (branch_b, product, 500)
  on conflict (branch_id, product_id) do update set quantity_on_hand = 500;
  perform set_config('harmony.pos_inventory_write', '', true);

  -- ======================================================================
  -- 0. A day's trading, made the way production makes it
  -- ======================================================================
  --
  -- Branch A: one cash sale of 2 (200.00 + 5.00 fee = 205.00)
  --           one gcash sale of 1 (100.00 + 5.00 fee = 105.00)
  -- Branch B: one cash sale of 3 (300.00, no fee configured)
  sale_cash   := pg_temp.ring_up(cashier_a, branch_a, product, 2, 'cash');
  sale_online := pg_temp.ring_up(cashier_a, branch_a, product, 1, 'gcash', gcash_ref);
  sale_b      := pg_temp.ring_up(cashier_b, branch_b, product, 3, 'cash');

  -- The three attempts that must never become revenue. Each is money the
  -- provider talked to us about; none of them produced a sale.
  insert into public.pos_payment_attempts
    (branch_id, cashier_profile_id, checkout_key, method, amount_centavos, items,
     status, reference_number, failed_at)
  values (branch_a, cashier_a, gen_random_uuid(), 'card', 999900,
          jsonb_build_array(jsonb_build_object('product_id', product, 'quantity', 99)),
          'failed', 'ZZ-FAIL-' || tag, now());
  insert into public.pos_payment_attempts
    (branch_id, cashier_profile_id, checkout_key, method, amount_centavos, items,
     status, reference_number, cancelled_at)
  values (branch_a, cashier_a, gen_random_uuid(), 'gcash', 888800,
          jsonb_build_array(jsonb_build_object('product_id', product, 'quantity', 88)),
          'cancelled', 'ZZ-CANC-' || tag, now());
  -- paid_unfulfilled is the sharp one: the customer's money moved and the sale
  -- could not be created. finalize_pos_payment leaves sale_id null on every
  -- branch that returns it.
  insert into public.pos_payment_attempts
    (branch_id, cashier_profile_id, checkout_key, method, amount_centavos, items,
     status, reference_number, paid_at, last_error)
  values (branch_a, cashier_a, gen_random_uuid(), 'qrph', 777700,
          jsonb_build_array(jsonb_build_object('product_id', product, 'quantity', 77)),
          'paid_unfulfilled', 'ZZ-UNFUL-' || tag, now(), 'price_changed')
  returning id into attempt;
  insert into public.pos_payment_attempts
    (branch_id, cashier_profile_id, checkout_key, method, amount_centavos, items,
     status, reference_number, expires_at)
  values (branch_a, cashier_a, gen_random_uuid(), 'paymaya', 666600,
          jsonb_build_array(jsonb_build_object('product_id', product, 'quantity', 66)),
          'expired', 'ZZ-EXP-' || tag, now());

  -- The online sale is linked to its attempt exactly as finalize_pos_payment
  -- links it, so the fixture matches the production shape.
  insert into public.pos_payment_attempts
    (branch_id, cashier_profile_id, checkout_key, method, amount_centavos, items,
     status, reference_number, paid_at, sale_id, provider_payment_id)
  select branch_a, cashier_a, s.checkout_key, 'gcash', 10500,
         jsonb_build_array(jsonb_build_object('product_id', product, 'quantity', 1)),
         'paid', gcash_ref, now(), s.id, 'pay_zz_' || tag
  from public.pos_sales s where s.id = sale_online;

  -- ======================================================================
  -- 1. What counts as revenue is what POS says happened
  -- ======================================================================
  perform pg_temp.acts_as(staff); set local role authenticated;

  select count(*)::integer into n
  from public.get_finance_sales_transactions(today, today, branch_a, null, null, 200, 0) t
  where t.sale_id = sale_cash;
  if n <> 1 then raise exception 'FAIL 1a the cash sale appears % times, expected once', n; end if;
  raise notice 'PASS  1a a completed cash sale reaches Finance exactly once';

  select count(*)::integer into n
  from public.get_finance_sales_transactions(today, today, branch_a, null, null, 200, 0) t
  where t.sale_id = sale_online;
  if n <> 1 then raise exception 'FAIL 1b the PayMongo sale appears % times, expected once', n; end if;
  raise notice 'PASS  1b a completed PayMongo sale reaches Finance exactly once';

  -- Four attempts that produced no sale, and four amounts that must appear
  -- nowhere. 9999.00, 8888.00, 7777.00 and 6666.00 are large enough that any
  -- one of them leaking would move the branch total unmistakably.
  select coalesce(sum(t.total_collected), 0) into amt
  from public.get_finance_sales_transactions(today, today, branch_a, null, null, 200, 0) t;
  if amt <> 310.00 then
    raise exception 'FAIL 1c branch A collected %, expected 310.00 -- an attempt leaked in', amt;
  end if;
  raise notice 'PASS  1c failed, cancelled, expired and paid_unfulfilled attempts are not revenue';

  -- Named individually, because paid_unfulfilled is the one a reasonable person
  -- might think should count: the money genuinely moved.
  select a.sale_id into linked_sale from public.pos_payment_attempts a where a.id = attempt;
  if linked_sale is not null then
    raise exception 'FAIL 1d fixture: paid_unfulfilled should carry no sale';
  end if;
  select count(*)::integer into n from public.pos_sales s
   where s.branch_id = branch_a and s.total_amount = 7777.00;
  if n <> 0 then raise exception 'FAIL 1d paid_unfulfilled produced a sale'; end if;
  raise notice 'PASS  1d money that moved without producing a sale is not revenue';

  -- ======================================================================
  -- 2. Finance reconciles with the POS report, exactly
  -- ======================================================================
  --
  -- The acceptance test that matters. Same branch, same day, two systems.
  select s.gross_sales, s.discounts, s.refunds, s.net_sales, s.fees_collected, s.total_collected
    into gross, disc, refunds, net, fees, collected
  from public.get_finance_sales_summary(today, today, branch_a, null, null) s;
  reset role;

  perform pg_temp.acts_as(pos_mgr); set local role authenticated;
  select r.product_sales, r.fees_collected, r.sales_collected
    into pos_product_sales, pos_fees, pos_collected
  from public.get_pos_manager_report_summary(branch_a, today, today) r;
  reset role;

  if net <> pos_product_sales then
    raise exception 'FAIL 2a Finance net sales % <> POS product sales %', net, pos_product_sales;
  end if;
  raise notice 'PASS  2a Finance Net Sales equals the POS report, to the centavo';

  if collected <> pos_collected then
    raise exception 'FAIL 2b Finance collected % <> POS collected %', collected, pos_collected;
  end if;
  if fees <> pos_fees then
    raise exception 'FAIL 2b Finance fees % <> POS fees %', fees, pos_fees;
  end if;
  raise notice 'PASS  2b collections and fees agree with the POS report';

  -- Line for line, not merely in total: a Finance page that agreed on the sum
  -- while disagreeing on the split would still be wrong.
  perform pg_temp.acts_as(staff); set local role authenticated;
  select count(*)::integer into n
  from public.get_finance_sales_collections(today, today, branch_a, null, null) f
  full join (
    select 'cash'::text as m, 205.00::numeric as a
    union all select 'gcash', 105.00
  ) expected on expected.m = f.payment_method and expected.a = f.amount_collected
  where f.payment_method is null or expected.m is null;
  if n <> 0 then raise exception 'FAIL 2c the payment-method split does not match'; end if;
  raise notice 'PASS  2c collections by method match line for line';

  -- ======================================================================
  -- 3. The arithmetic Finance publishes
  -- ======================================================================
  if gross <> 300.00 then raise exception 'FAIL 3a gross is %, expected 300.00', gross; end if;
  if net <> gross - disc - refunds then
    raise exception 'FAIL 3a net % <> gross % - discounts % - refunds %', net, gross, disc, refunds;
  end if;
  raise notice 'PASS  3a Net Sales = Gross - Discounts - Refunds';

  if net + fees <> collected then
    raise exception 'FAIL 3b net % + fees % <> collected %', net, fees, collected;
  end if;
  raise notice 'PASS  3b Net Sales + Fees = Total Collected, as the sale rows require';

  -- Zero because POS has no discount column and no void status -- not because
  -- today happened to be quiet. If POS ever grows either, this test fails and
  -- somebody has to come back and mean it.
  if disc <> 0 or refunds <> 0 then
    raise exception 'FAIL 3c discounts % refunds % -- POS models neither', disc, refunds;
  end if;
  select count(*)::integer into n from pg_enum e
   join pg_type t on t.oid = e.enumtypid
   where t.typname = 'pos_sale_status';
  if n <> 1 then
    raise exception 'FAIL 3c pos_sale_status now has % values: refunds may be real now', n;
  end if;
  select count(*)::integer into n from information_schema.columns
   where table_name = 'pos_sales' and column_name in ('discount_total','discount_amount','voided_at');
  if n <> 0 then
    raise exception 'FAIL 3c pos_sales grew a discount or void column: Finance must stop reporting zero';
  end if;
  raise notice 'PASS  3c discounts and refunds are zero because POS models neither';

  -- ======================================================================
  -- 4. Branches
  -- ======================================================================
  select s.net_sales, s.total_collected into net, collected
    from public.get_finance_sales_summary(today, today, branch_b, null, null) s;
  if net <> 300.00 or collected <> 300.00 then
    raise exception 'FAIL 4a branch B net % collected %, expected 300.00 each', net, collected;
  end if;
  raise notice 'PASS  4a each branch totals only its own trading';

  select s.net_sales, s.total_collected, s.transaction_count into net, collected, n
    from public.get_finance_sales_summary(today, today, null, null, null) s;
  if net <> 600.00 then raise exception 'FAIL 4b enterprise net is %, expected 600.00', net; end if;
  if collected <> 610.00 then raise exception 'FAIL 4b enterprise collected is %, expected 610.00', collected; end if;
  if n <> 3 then raise exception 'FAIL 4b enterprise transaction count is %, expected 3', n; end if;
  raise notice 'PASS  4b Finance sees the enterprise when it asks for no branch';

  -- ======================================================================
  -- 5. The Philippine business day
  -- ======================================================================
  --
  -- Manila is UTC+8, so 23:30 local is 15:30 UTC the same day, and 00:30 local
  -- is 16:30 UTC the day BEFORE. A report built on ::date over a timestamptz
  -- would put the late-evening takings in tomorrow and the early-morning ones
  -- in yesterday. Both directions are tested.
  reset role;
  update public.pos_sales
     set created_at = ((today::text || ' 23:30')::timestamp at time zone tz)
   where id = sale_b;
  perform pg_temp.acts_as(staff); set local role authenticated;

  select s.net_sales into net from public.get_finance_sales_summary(today, today, branch_b, null, null) s;
  if net <> 300.00 then
    raise exception 'FAIL 5a a 23:30 Manila sale left its own business day (net %)', net;
  end if;
  select s.net_sales into net
    from public.get_finance_sales_summary(today + 1, today + 1, branch_b, null, null) s;
  if net <> 0 then
    raise exception 'FAIL 5a a 23:30 Manila sale leaked into tomorrow (net %)', net;
  end if;
  raise notice 'PASS  5a a 23:30 Manila sale stays in its own Philippine business day';

  reset role;
  update public.pos_sales
     set created_at = ((today::text || ' 00:30')::timestamp at time zone tz)
   where id = sale_b;
  perform pg_temp.acts_as(staff); set local role authenticated;

  select s.net_sales into net from public.get_finance_sales_summary(today, today, branch_b, null, null) s;
  if net <> 300.00 then
    raise exception 'FAIL 5b a 00:30 Manila sale is missing from its own day (net %)', net;
  end if;
  select s.net_sales into net
    from public.get_finance_sales_summary(today - 1, today - 1, branch_b, null, null) s;
  if net <> 0 then
    raise exception 'FAIL 5b a 00:30 Manila sale fell back into yesterday (net %)', net;
  end if;
  raise notice 'PASS  5b a 00:30 Manila sale does not fall into the previous UTC day';

  -- A range still bounds correctly at both ends.
  select s.net_sales into net
    from public.get_finance_sales_summary(today - 3, today, null, null, null) s;
  if net <> 600.00 then raise exception 'FAIL 5c a range covering today totals %', net; end if;
  raise notice 'PASS  5c a date range includes both boundary days';

  -- ======================================================================
  -- 6. Filters
  -- ======================================================================
  select s.net_sales, s.total_collected, s.transaction_count into net, collected, n
    from public.get_finance_sales_summary(today, today, null, 'gcash', null) s;
  if n <> 1 or net <> 100.00 or collected <> 105.00 then
    raise exception 'FAIL 6a gcash filter gave % sales, net %, collected %', n, net, collected;
  end if;
  raise notice 'PASS  6a the payment-method filter totals only that method';

  select s.net_sales into net
    from public.get_finance_sales_summary(today, today, null, 'card', null) s;
  if net <> 0 then
    raise exception 'FAIL 6b card shows % though only a FAILED card attempt exists', net;
  end if;
  raise notice 'PASS  6b a method with only a failed attempt reports nothing';

  select s.transaction_count into n
    from public.get_finance_sales_summary(today, today, null, null, cashier_b) s;
  if n <> 1 then raise exception 'FAIL 6c the cashier filter gave % sales, expected 1', n; end if;
  raise notice 'PASS  6c the cashier filter narrows to one till';

  -- ======================================================================
  -- 7. Who may look
  -- ======================================================================
  reset role;
  perform pg_temp.acts_as(fin_mgr); set local role authenticated;
  select s.net_sales into net from public.get_finance_sales_summary(today, today, null, null, null) s;
  if coalesce(net, -1) <> 600.00 then raise exception 'FAIL 7a a Finance Manager saw %', net; end if;
  reset role;

  perform pg_temp.acts_as(accountant); set local role authenticated;
  select s.net_sales into net from public.get_finance_sales_summary(today, today, null, null, null) s;
  if coalesce(net, -1) <> 600.00 then raise exception 'FAIL 7a an Accountant saw %', net; end if;
  reset role;

  perform pg_temp.acts_as(admin_id); set local role authenticated;
  select s.net_sales into net from public.get_finance_sales_summary(today, today, null, null, null) s;
  if coalesce(net, -1) <> 600.00 then raise exception 'FAIL 7a an Administrator saw %', net; end if;
  reset role;
  raise notice 'PASS  7a Finance Staff, Finance Manager, Accountant and Admin may read';

  -- The cashier who rang up two of these sales still has no business on the
  -- Finance surface. Creating a transaction is not a claim on the report.
  perform pg_temp.acts_as(cashier_a); set local role authenticated;
  select count(*)::integer into n
    from public.get_finance_sales_summary(today, today, null, null, null) s;
  if n <> 0 then raise exception 'FAIL 7b a cashier read the Finance summary'; end if;
  select count(*)::integer into n
    from public.get_finance_sales_transactions(today, today, null, null, null, 200, 0) t;
  if n <> 0 then raise exception 'FAIL 7b a cashier read Finance transactions'; end if;
  select count(*)::integer into n
    from public.get_finance_sales_collections(today, today, null, null, null) c;
  if n <> 0 then raise exception 'FAIL 7b a cashier read Finance collections'; end if;
  reset role;
  raise notice 'PASS  7b the cashier who made the sales cannot read the Finance surface';

  perform pg_temp.acts_as(pos_mgr); set local role authenticated;
  select count(*)::integer into n
    from public.get_finance_sales_summary(today, today, null, null, null) s;
  if n <> 0 then raise exception 'FAIL 7c a POS Manager read the Finance summary'; end if;
  select count(*)::integer into n
    from public.get_finance_sales_transactions(today, today, null, null, null, 200, 0) t;
  if n <> 0 then raise exception 'FAIL 7c a POS Manager read Finance transactions'; end if;
  reset role;
  raise notice 'PASS  7c a POS Manager keeps POS reports and gains no Finance surface';

  perform pg_temp.acts_as(hr_staff); set local role authenticated;
  select count(*)::integer into n
    from public.get_finance_sales_summary(today, today, null, null, null) s;
  if n <> 0 then raise exception 'FAIL 7d an HR account read the Finance summary'; end if;
  reset role;
  raise notice 'PASS  7d HR roles have no sales visibility';

  -- Anonymous, with no claims at all: the function is granted to authenticated,
  -- and the gate inside it still has to hold.
  perform set_config('request.jwt.claims', '', true);
  set local role anon;
  begin
    select count(*)::integer into n
      from public.get_finance_sales_summary(today, today, null, null, null) s;
    if n <> 0 then raise exception 'FAIL 7e anon read the Finance summary'; end if;
  exception when insufficient_privilege then
    n := 0;
  end;
  reset role;
  raise notice 'PASS  7e an anonymous caller reads nothing';

  -- Reading through the RPC does not imply reading the table. Finance never
  -- receives a blanket SELECT on the POS operational tables.
  perform pg_temp.acts_as(staff); set local role authenticated;
  select count(*)::integer into n from public.pos_sales;
  if n <> 0 then
    raise exception 'FAIL 7f Finance can SELECT pos_sales directly (% rows)', n;
  end if;
  select count(*)::integer into n from public.pos_sale_items;
  if n <> 0 then
    raise exception 'FAIL 7f Finance can SELECT pos_sale_items directly (% rows)', n;
  end if;
  reset role;
  raise notice 'PASS  7f the RPC is the only Finance door; the POS tables stay shut';

  -- ======================================================================
  -- 8. Finance reads. Finance does not edit.
  -- ======================================================================
  --
  -- Each of these is refused outright: Finance holds no UPDATE or DELETE
  -- privilege on the POS tables, so PostgreSQL stops the statement before RLS
  -- is even consulted. Both outcomes are accepted below -- a hard refusal, or
  -- zero rows touched -- because the claim is that the sale does not change,
  -- not which layer happened to say no.
  perform pg_temp.acts_as(staff); set local role authenticated;

  begin
    update public.pos_sales set total_amount = 999999 where id = sale_cash;
    if found then raise exception 'FAIL 8a Finance changed a receipt total'; end if;
  exception when insufficient_privilege then null;
  end;
  begin
    update public.pos_sales set cashier_id = staff where id = sale_cash;
    if found then raise exception 'FAIL 8a Finance changed the cashier'; end if;
  exception when insufficient_privilege then null;
  end;
  raise notice 'PASS  8a Finance cannot change a receipt total or its cashier';

  begin
    update public.pos_sale_items set quantity = 99 where sale_id = sale_cash;
    if found then raise exception 'FAIL 8b Finance changed a sold quantity'; end if;
  exception when insufficient_privilege then null;
  end;
  raise notice 'PASS  8b Finance cannot change a sold quantity';

  begin
    delete from public.pos_sales where id = sale_cash;
    if found then raise exception 'FAIL 8c Finance deleted a sale'; end if;
  exception when insufficient_privilege then null;
  end;
  raise notice 'PASS  8c Finance cannot delete a sale';
  reset role;

  -- The sale survived all of that intact.
  select total_amount into amt from public.pos_sales where id = sale_cash;
  if amt <> 205.00 then raise exception 'FAIL 8d the sale total is now %', amt; end if;
  raise notice 'PASS  8d the source sale is exactly as POS wrote it';

  -- ======================================================================
  -- 9. Selling does not touch the procurement budget
  -- ======================================================================
  --
  -- The failure this guards against is a plausible one: revenue quietly
  -- topping up a spending ceiling, so a branch that sold well could suddenly
  -- order more than Finance approved.
  select id into cat_id from public.finance_categories where kind='expense' and is_active limit 1;
  perform pg_temp.acts_as(staff); set local role authenticated;
  insert into public.vendors (name, phone) values ('ZZ Sales Bridge Vendor ' || tag, '09171234512')
  returning id into vendor;
  insert into public.budgets (name, finance_category_id, amount, fiscal_year)
  values ('ZZ Sales Bridge Budget ' || tag, cat_id, 50000, extract(year from current_date)::integer)
  returning id into budget;
  reset role;
  perform pg_temp.acts_as(fin_mgr); set local role authenticated;
  perform public.review_vendor(vendor, true, 'fixture');
  perform public.review_budget(budget, true, 'fixture');
  reset role;

  select bs.amount, bs.reserved, bs.spent into b_ceiling, b_reserved, b_spent
    from public.budget_status bs where bs.id = budget;

  -- Trade again, after the reading.
  perform pg_temp.ring_up(cashier_a, branch_a, product, 4, 'cash');
  reset role;

  select bs.amount, bs.reserved, bs.spent into net, fees, collected
    from public.budget_status bs where bs.id = budget;
  if net <> b_ceiling then raise exception 'FAIL 9a a sale moved the ceiling: % -> %', b_ceiling, net; end if;
  if fees <> b_reserved then raise exception 'FAIL 9a a sale moved reserved: % -> %', b_reserved, fees; end if;
  if collected <> b_spent then raise exception 'FAIL 9a a sale moved spent: % -> %', b_spent, collected; end if;
  raise notice 'PASS  9a a completed sale leaves ceiling, reserved and spent untouched';

  -- ======================================================================
  -- 10. Selling does not touch Accounts Payable
  -- ======================================================================
  --
  -- A real invoice, through the real F5 path, so this is a claim about AP and
  -- not about an empty table.
  perform pg_temp.acts_as(pos_mgr); set local role authenticated;
  select public.create_pos_stock_request(branch_a, product, 2, 'ZZ AP witness') into fin_req;
  reset role;
  perform pg_temp.acts_as(staff); set local role authenticated;
  perform public.approve_pos_request(fin_req, 'Accepted');
  select public.create_purchase_order_from_source(
    'pos_restock', fin_req, vendor, null, null, 2, 500.00, null, true, budget) into po;
  reset role;
  perform pg_temp.acts_as(fin_mgr); set local role authenticated;
  perform public.transition_purchase_order(po, 'approved', 'fixture');
  reset role;

  select id into po_line from public.purchase_order_items where purchase_order_id = po limit 1;
  perform pg_temp.acts_as(pos_mgr); set local role authenticated;
  perform public.receive_procurement_stock(po_line, 2, 'ZZ-DR-' || tag, gen_random_uuid());
  reset role;

  perform pg_temp.acts_as(accountant); set local role authenticated;
  select public.create_supplier_invoice(
    po, 'ZZ-INV-' || tag, current_date, current_date + 30,
    jsonb_build_array(jsonb_build_object(
      'purchase_order_item_id', po_line, 'quantity', 2, 'unit_price', 500)),
    0, 0, null, 'ZZ sales bridge AP witness') into invoice;
  reset role;

  select count(*)::integer, coalesce(sum(v.total_amount), 0), coalesce(sum(v.balance_due), 0)
    into ap_count, ap_total, ap_balance
  from public.supplier_invoice_status v;

  perform pg_temp.ring_up(cashier_a, branch_a, product, 5, 'cash');
  reset role;

  select count(*)::integer, coalesce(sum(v.total_amount), 0), coalesce(sum(v.balance_due), 0)
    into ap_count2, ap_total2, ap_balance2
  from public.supplier_invoice_status v;

  if ap_count <> ap_count2 then
    raise exception 'FAIL 10a a sale changed the invoice count: % -> %', ap_count, ap_count2;
  end if;
  if ap_total <> ap_total2 then
    raise exception 'FAIL 10a a sale changed supplier invoice totals: % -> %', ap_total, ap_total2;
  end if;
  if ap_balance <> ap_balance2 then
    raise exception 'FAIL 10a a sale changed the supplier balance due: % -> %', ap_balance, ap_balance2;
  end if;
  if ap_count = 0 then raise exception 'FAIL 10a fixture: no invoice to witness'; end if;
  raise notice 'PASS  10a a sale changes no supplier invoice total and no balance due';

  -- ======================================================================
  -- 11. Finance reading does not move stock
  -- ======================================================================
  --
  -- The sale already decremented inventory once, in the till. If the Finance
  -- bridge decremented again, every reported day would quietly eat the
  -- branch's stock a second time.
  select quantity_on_hand into stock_before
    from public.pos_branch_inventory where branch_id = branch_a and product_id = product;
  select count(*)::integer into moves_before
    from public.pos_inventory_movements where branch_id = branch_a and product_id = product;

  perform pg_temp.acts_as(staff); set local role authenticated;
  perform public.get_finance_sales_summary(today, today, null, null, null);
  perform public.get_finance_sales_collections(today, today, null, null, null);
  perform public.get_finance_sales_transactions(today, today, null, null, null, 200, 0);
  perform public.get_finance_sales_filters(today, today);
  reset role;

  select quantity_on_hand into stock_after
    from public.pos_branch_inventory where branch_id = branch_a and product_id = product;
  select count(*)::integer into moves_after
    from public.pos_inventory_movements where branch_id = branch_a and product_id = product;

  if stock_before <> stock_after then
    raise exception 'FAIL 11a reading Finance moved stock: % -> %', stock_before, stock_after;
  end if;
  if moves_before <> moves_after then
    raise exception 'FAIL 11a reading Finance wrote % new movement(s)', moves_after - moves_before;
  end if;
  raise notice 'PASS  11a a Finance read writes no inventory movement';

  -- And the sale itself moved stock exactly once, which is the other half of
  -- the claim: once, by POS, and never again.
  select count(*)::integer into n
    from public.pos_inventory_movements m
   where m.source_id = sale_cash and m.movement_type = 'sale';
  if n <> 1 then
    raise exception 'FAIL 11b the cash sale produced % stock movements, expected 1', n;
  end if;
  raise notice 'PASS  11b the sale decremented stock once, in POS, and only there';

  -- ======================================================================
  -- 12. Refunds and voids: the limitation, asserted
  -- ======================================================================
  --
  -- POS has no void or refund path today. Rather than invent an accounting
  -- reversal Finance could not trace to anything, this test pins the absence,
  -- so the day POS grows one, this fails and Finance is made to catch up.
  select count(*)::integer into n from pg_proc
   where pronamespace = 'public'::regnamespace
     and (proname like '%void%sale%' or proname like '%refund%');
  if n <> 0 then
    raise exception 'FAIL 12a POS grew % refund/void function(s): Finance must now report them', n;
  end if;
  raise notice 'PASS  12a POS has no refund or void path, and Finance invents none';

  -- ======================================================================
  -- 13. The drill-down carries what reconciles, and nothing else
  -- ======================================================================
  perform pg_temp.acts_as(staff); set local role authenticated;
  select t.branch_name, t.cashier_name, t.payment_method, t.net_sales, t.total_collected
    into txt, who, method_out, net, collected
  from public.get_finance_sales_transactions(today, today, branch_a, null, null, 200, 0) t
  where t.sale_id = sale_online;
  if txt is null or who is null then raise exception 'FAIL 13a drill-down lost branch or cashier'; end if;
  if method_out <> 'gcash' then raise exception 'FAIL 13a method is %', method_out; end if;
  if net <> 100.00 or collected <> 105.00 then
    raise exception 'FAIL 13a net % collected % on the online sale', net, collected;
  end if;
  raise notice 'PASS  13a drill-down reconciles a figure to its branch, cashier and method';

  -- No cost, no margin. Finance reconciles revenue here; unit cost belongs to
  -- the POS and procurement surfaces that already govern it.
  select count(*)::integer into n
  from unnest(string_to_array(
    pg_get_function_result((select oid from pg_proc
      where proname='get_finance_sales_transactions'
        and pronamespace='public'::regnamespace)), ',')) col
  where col ilike '%cogs%' or col ilike '%cost%' or col ilike '%margin%';
  if n <> 0 then raise exception 'FAIL 13b the drill-down exposes cost data'; end if;
  raise notice 'PASS  13b the drill-down carries no cost, COGS or margin';
  reset role;

  raise notice '--------------------------------------------------';
  raise notice 'finance_sales_bridge_rls: all checks passed';
end $$;

rollback;
