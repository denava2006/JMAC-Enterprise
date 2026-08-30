-- Phase 7B POS Reports -- database contract test.
--
-- This contract proves the report calendar, arithmetic, role boundaries,
-- stable-identity grouping, typed Manager cost-safety, completed-sale filters,
-- and the actual PostgreSQL ACL state. It writes fixtures in one transaction
-- and rolls everything back.
--
-- Run:
--   docker exec -i supabase_db_harmony-suite psql -U postgres -d postgres \
--     -v ON_ERROR_STOP=1 -f - < supabase/tests/pos_reports_rls.sql

begin;

-- ---------------------------------------------------------------------------
-- Phase 9A test fixture helper.
--
-- POS access now requires: an active profile with role 'employee', linked to an
-- active employee, whose position belongs to its department and is configured
-- in position_system_roles for the role being granted.
--
-- The demo accounts do not satisfy that (IT Support, Sales Associate, and an
-- hr_staff account that can never hold an operational POS role), which is the
-- whole point of this phase. So each suite builds the people it needs.
--
-- pg_temp: session-local. Rolled back with everything else, and it cannot ship.
create function pg_temp.make_pos_eligible(_profile_id uuid, _position_title text)
returns void
language plpgsql
as $helper$
declare
  _dept uuid;
  _position uuid;
  _employee uuid;
  _saved text := current_setting('request.jwt.claims', true);
  _admin uuid;
begin
  select d.id into _dept from public.departments d where d.name = 'Store Operations';
  select po.id into _position from public.positions po
   where po.department_id = _dept and po.title = _position_title;
  if _position is null then
    raise exception 'fixture: no % position in Store Operations', _position_title;
  end if;

  select p.employee_id into _employee from public.profiles p where p.id = _profile_id;

  if _employee is null then
    insert into public.employees (first_name, last_name, email, department_id, position_id,
                                  employment_status, hire_date)
    select coalesce(split_part(p.full_name, ' ', 1), 'Test'),
           coalesce(nullif(split_part(p.full_name, ' ', 2), ''), 'Worker'),
           p.email, _dept, _position, 'active', current_date
    from public.profiles p where p.id = _profile_id
    returning id into _employee;
  else
    update public.employees
       set department_id = _dept, position_id = _position, employment_status = 'active'
     where id = _employee;
  end if;

  -- profiles.role/status are guarded for API callers; the suite runs as owner,
  -- and an admin claim is set so the guard sees a legitimate actor.
  select p.id into _admin from public.profiles p
   where p.role = 'admin' and p.status = 'active' limit 1;
  perform set_config('request.jwt.claims',
                     json_build_object('sub', _admin, 'role', 'authenticated')::text, true);
  update public.profiles
     set employee_id = _employee, role = 'employee', status = 'active'
   where id = _profile_id;
  perform set_config('request.jwt.claims', coalesce(_saved, ''), true);
end;
$helper$;

-- A position eligible for BOTH POS roles, for the mixed-role cases. Under Phase
-- 9A a single position grants exactly the roles an Administrator configured for
-- it, so "manager at A, cashier at B" is only possible where both were granted.
create function pg_temp.make_dual_role_position() returns uuid
language plpgsql
as $dual$
declare _dept uuid; _pos uuid;
begin
  select d.id into _dept from public.departments d where d.name = 'Store Operations';
  insert into public.positions (title, department_id, description)
  values ('ZZ Test Branch Supervisor', _dept, 'Fixture: eligible for both POS roles')
  returning id into _pos;
  insert into public.position_system_roles (position_id, system, role_code)
  values (_pos, 'pos', 'manager'), (_pos, 'pos', 'cashier');
  return _pos;
end;
$dual$;

create function pg_temp.make_eligible_at(_profile_id uuid, _position_id uuid)
returns void language plpgsql as $at$
declare _employee uuid; _dept uuid; _saved text := current_setting('request.jwt.claims', true); _admin uuid;
begin
  select po.department_id into _dept from public.positions po where po.id = _position_id;
  select p.employee_id into _employee from public.profiles p where p.id = _profile_id;
  if _employee is null then
    insert into public.employees (first_name, last_name, email, department_id, position_id,
                                  employment_status, hire_date)
    select coalesce(split_part(p.full_name,' ',1),'Test'),
           coalesce(nullif(split_part(p.full_name,' ',2),''),'Worker'),
           p.email, _dept, _position_id, 'active', current_date
    from public.profiles p where p.id = _profile_id returning id into _employee;
  else
    update public.employees set department_id=_dept, position_id=_position_id,
           employment_status='active' where id=_employee;
  end if;
  select p.id into _admin from public.profiles p where p.role='admin' and p.status='active' limit 1;
  perform set_config('request.jwt.claims', json_build_object('sub',_admin,'role','authenticated')::text, true);
  update public.profiles set employee_id=_employee, role='employee', status='active' where id=_profile_id;
  perform set_config('request.jwt.claims', coalesce(_saved,''), true);
end;
$at$;

do $$
declare
  wf_dual_position uuid;
  admin_id       uuid;
  manager_id     uuid;
  cashier_id     uuid;
  mixed_id       uuid;
  outsider_id    uuid;
  branch_a       uuid;
  branch_b       uuid;
  category_id    uuid;
  cola_id        uuid;
  chips_id       uuid;
  sale_a_old     uuid := gen_random_uuid();
  sale_a_new     uuid := gen_random_uuid();
  sale_b         uuid := gen_random_uuid();
  sale_before    uuid := gen_random_uuid();
  sale_after     uuid := gen_random_uuid();
  today_ph       date := public.pos_business_date();
  yesterday_ph   date := public.pos_business_date() - 1;
  period_start   timestamptz;
  period_end     timestamptz;
  n              integer;
  m              integer;
  amount         numeric;
  amount_2       numeric;
  amount_3       numeric;
  label          text;
  definition     text;
  signature      text;
  rec            record;
  tag            text := left(replace(gen_random_uuid()::text, '-', ''), 8);
begin
  ---------------------------------------------------------------- fixtures
  select id into admin_id
  from public.profiles where role = 'admin' and status = 'active' limit 1;
  select id into manager_id
  from public.profiles where role = 'employee' and status = 'active'
  order by created_at, id limit 1;
  select id into cashier_id
  from public.profiles
  where role = 'employee' and status = 'active' and id <> manager_id
  order by created_at, id limit 1;
  select id into mixed_id
  from public.profiles where role = 'hr_staff' and status = 'active'
  order by created_at, id limit 1;
  select id into outsider_id
  from public.profiles where role = 'hr_manager' and status = 'active'
  order by created_at, id limit 1;
  select id into branch_a
  from public.branches where is_active order by name, id limit 1;
  select id into branch_b
  from public.branches where is_active and id <> branch_a order by name, id limit 1;

  if admin_id is null or manager_id is null or cashier_id is null
     or mixed_id is null or outsider_id is null or branch_b is null then
    raise exception 'fixture: need an active admin, two employees, hr_staff, hr_manager and two branches';
  end if;

  select b.period_start, b.period_end
    into period_start, period_end
  from public.pos_report_bounds(yesterday_ph, today_ph) b;

  delete from public.pos_branch_assignments;
    -- FIXTURE WIRED (Phase 9A): give these people the employment record
  -- their POS role now requires. The assignment INSERT below is refused
  -- otherwise, which is the point of the phase.
  wf_dual_position := pg_temp.make_dual_role_position();
  perform pg_temp.make_pos_eligible(cashier_id, 'Cashier');
  perform pg_temp.make_pos_eligible(manager_id, 'POS Manager');
  perform pg_temp.make_eligible_at(mixed_id, wf_dual_position);

insert into public.pos_branch_assignments (profile_id, branch_id, pos_role, created_by)
  values (manager_id, branch_a, 'manager', admin_id),
         (cashier_id, branch_a, 'cashier', admin_id),
         (mixed_id,   branch_a, 'manager', admin_id),
         (mixed_id,   branch_b, 'cashier', admin_id);

  insert into public.pos_product_categories
    (name, description, color, is_active, sort_order, created_by)
  values ('ZZ Reports ' || tag, 'Report fixtures', '#445566', true, 90, admin_id)
  returning id into category_id;

  insert into public.pos_products
    (name, category_id, default_selling_price, default_unit_cost, status)
  values ('ZZ Reports Cola ' || tag, category_id, 100.00, 60.00, 'active')
  returning id into cola_id;

  insert into public.pos_products
    (name, category_id, default_selling_price, default_unit_cost, status)
  values ('ZZ Reports Chips ' || tag, category_id, 50.00, 30.00, 'active')
  returning id into chips_id;

  -- Two A sales and one B sale. Fees are deliberately non-zero so reports
  -- must keep product sales separate from total customer collections.
  insert into public.pos_sales (
    id, branch_id, cashier_id, status, subtotal, fees_total, total_amount, fees,
    payment_method, payment_reference, amount_tendered, change_given, total_cogs, branch_name,
    cashier_name, checkout_key, request_fingerprint, created_at
  ) values
    (sale_a_old, branch_a, cashier_id, 'completed', 300.00, 30.00, 330.00,
     '[{"name":"Service","type":"percent","value":10,"amount":30}]',
     'cash', null, 500.00, 170.00, 180.00, 'Historical A', 'Fixture Cashier',
     gen_random_uuid(), 'report-a-old-' || tag, period_start + interval '1 hour'),
    (sale_a_new, branch_a, manager_id, 'completed', 250.00, 25.00, 275.00,
     '[{"name":"Service","type":"percent","value":10,"amount":25}]',
     'gcash', 'GCASH-REPORT', null, null, 150.00, 'Historical A renamed', 'Fixture Manager',
     gen_random_uuid(), 'report-a-new-' || tag, period_end - interval '22 hours'),
    (sale_b, branch_b, mixed_id, 'completed', 400.00, 40.00, 440.00,
     '[{"name":"Service","type":"percent","value":10,"amount":40}]',
     'bank', 'BANK-REPORT', null, null, 240.00, 'Historical B', 'Fixture Mixed',
     gen_random_uuid(), 'report-b-' || tag, period_end - interval '21 hours');

  insert into public.pos_sale_items (
    sale_id, product_id, product_name, category_name, quantity, unit_price,
    line_total, unit_cost_snapshot, line_cogs, created_at
  ) values
    (sale_a_old, cola_id, 'ZZ Reports Cola OLD ' || tag, 'Report fixtures',
     3, 100.00, 300.00, 60.00, 180.00, period_start + interval '1 hour'),
    (sale_a_new, cola_id, 'ZZ Reports Cola NEW ' || tag, 'Report fixtures',
     2, 100.00, 200.00, 60.00, 120.00, period_end - interval '22 hours'),
    (sale_a_new, chips_id, 'ZZ Reports Chips ' || tag, 'Report fixtures',
     1, 50.00, 50.00, 30.00, 30.00, period_end - interval '22 hours'),
    (sale_b, cola_id, 'ZZ Reports Cola BRANCH B ' || tag, 'Report fixtures',
     4, 100.00, 400.00, 60.00, 240.00, period_end - interval '21 hours');

  -- Half-open boundary sentinels. Both include lines so a boundary error would
  -- corrupt money, unit, trend and product aggregates at once.
  insert into public.pos_sales (
    id, branch_id, cashier_id, status, subtotal, fees_total, total_amount, fees,
    payment_method, payment_reference, amount_tendered, change_given, total_cogs, branch_name,
    cashier_name, checkout_key, request_fingerprint, created_at
  ) values
    (sale_before, branch_a, cashier_id, 'completed', 900.00, 90.00, 990.00,
     '[]', 'cash', null, 1000.00, 10.00, 540.00, 'Before', 'Before',
     gen_random_uuid(), 'report-before-' || tag, period_start - interval '1 second'),
    (sale_after, branch_a, cashier_id, 'completed', 800.00, 80.00, 880.00,
     '[]', 'cash', null, 1000.00, 120.00, 480.00, 'After', 'After',
     gen_random_uuid(), 'report-after-' || tag, period_end);

  insert into public.pos_sale_items (
    sale_id, product_id, product_name, category_name, quantity, unit_price,
    line_total, unit_cost_snapshot, line_cogs, created_at
  ) values
    (sale_before, cola_id, 'Boundary before', 'Report fixtures',
     9, 100.00, 900.00, 60.00, 540.00, period_start - interval '1 second'),
    (sale_after, cola_id, 'Boundary after', 'Report fixtures',
     8, 100.00, 800.00, 60.00, 480.00, period_end);

  ------------------------------------------------------ 1. database calendar
  if public.pos_business_timezone() <> 'Asia/Manila' then
    raise exception 'FAIL 1a business timezone is %, expected Asia/Manila',
      public.pos_business_timezone();
  end if;

  select count(*) into n
  from public.get_pos_report_presets() p
  where (p.preset, p.date_from, p.date_to, p.sort_order) in (
    ('today', today_ph, today_ph, 1),
    ('yesterday', today_ph - 1, today_ph - 1, 2),
    ('last_7_days', today_ph - 6, today_ph, 3),
    ('month_to_date', date_trunc('month', today_ph)::date, today_ph, 4),
    ('year_to_date', date_trunc('year', today_ph)::date, today_ph, 5)
  );
  if n <> 5 then raise exception 'FAIL 1b only % report presets match the database day', n; end if;
  select count(*) into n from public.get_pos_report_presets();
  if n <> 5 then raise exception 'FAIL 1c preset RPC returned % rows, expected exactly 5', n; end if;

  select count(*) into n
  from public.pos_report_bounds(null, null) b
  where b.date_from = today_ph
    and b.date_to = today_ph
    and b.period_end - b.period_start = interval '24 hours'
    and (b.period_start at time zone 'Asia/Manila')::time = time '00:00';
  if n <> 1 then raise exception 'FAIL 1d default bounds are not one Manila business day'; end if;
  raise notice 'PASS 1 presets are anchored by pos_business_date(), not a browser clock';

  select count(*) into n
  from public.pos_report_bounds(today_ph, today_ph + 365);
  if n <> 1 then raise exception 'FAIL 1c a 366-day inclusive range was refused'; end if;

  begin
    perform 1 from public.pos_report_bounds(today_ph, today_ph + 366);
    raise exception 'FAIL 1d a 367-day inclusive range was accepted';
  exception when sqlstate '22023' then null;
  end;

  begin
    perform 1 from public.pos_report_bounds(today_ph, today_ph - 1);
    raise exception 'FAIL 1e a reversed range was accepted';
  exception when sqlstate '22023' then null;
  end;
  raise notice 'PASS 2 report ranges are ordered and capped at 366 inclusive days';

  -------------------------------------------------- 2. Manager operational data
  perform set_config('request.jwt.claims',
    json_build_object('sub', manager_id, 'role', 'authenticated')::text, true);
  set local role authenticated;

  select r.sales_collected, r.product_sales, r.fees_collected,
         r.transaction_count, r.items_sold, r.average_sale
    into amount, amount_2, amount_3, n, m, label
  from public.get_pos_manager_report_summary(branch_a, yesterday_ph, today_ph) r;
  if amount <> 605.00 or amount_2 <> 550.00 or amount_3 <> 55.00
     or n <> 2 or m <> 6 or label::numeric <> 302.50 then
    raise exception 'FAIL 2a Manager summary got collected=% product=% fees=% tx=% items=% avg=%',
      amount, amount_2, amount_3, n, m, label;
  end if;
  raise notice 'PASS 3 Manager summary is operational, reconciled and sums item quantity';

  select p.amount_collected, p.transaction_count into amount, n
  from public.get_pos_manager_report_payment_totals(branch_a, yesterday_ph, today_ph) p
  where p.payment_method = 'cash';
  if amount <> 330.00 or n <> 1 then
    raise exception 'FAIL 2b cash amount_collected=% tx=%, expected SUM(total_amount)=330/1', amount, n;
  end if;
  raise notice 'PASS 4 payment amount_collected is SUM(total_amount)';

  select count(*) into n
  from public.get_pos_manager_report_top_products(branch_a, yesterday_ph, today_ph, 10) p
  where p.product_id = cola_id;
  if n <> 1 then raise exception 'FAIL 2c a product rename split into % ranking rows', n; end if;

  select p.product_name, p.quantity_sold, p.sales_amount
    into label, n, amount
  from public.get_pos_manager_report_top_products(branch_a, yesterday_ph, today_ph, 10) p
  where p.product_id = cola_id;
  if label <> 'ZZ Reports Cola NEW ' || tag or n <> 5 or amount <> 500.00 then
    raise exception 'FAIL 2d top product name=% qty=% sales=%, expected latest snapshot/5/500',
      label, n, amount;
  end if;
  raise notice 'PASS 5 top products group by product_id, value line_total and show the latest snapshot';

  -- The old sale is at 17:00 UTC on the preceding UTC date, but at 01:00 on
  -- yesterday's Asia/Manila business date.
  select t.transaction_count, t.sales_collected into n, amount
  from public.get_pos_manager_report_trend(branch_a, yesterday_ph, today_ph) t
  where t.business_date = yesterday_ph;
  if n <> 1 or amount <> 330.00 then
    raise exception 'FAIL 2e Manila trend bucket got tx=% collected=%', n, amount;
  end if;
  select count(*) into n
  from public.get_pos_manager_report_trend(branch_a, yesterday_ph, today_ph);
  if n <> 2 then raise exception 'FAIL 2f trend did not return both calendar days'; end if;
  raise notice 'PASS 6 daily trends group by Asia/Manila business date and fill every day';

  ----------------------------------------------------- 3. branch role boundary
  reset role;
  perform set_config('request.jwt.claims',
    json_build_object('sub', mixed_id, 'role', 'authenticated')::text, true);
  set local role authenticated;
  select count(*) into n
  from public.get_pos_manager_report_summary(branch_a, yesterday_ph, today_ph);
  select count(*) into m
  from public.get_pos_manager_report_summary(branch_b, yesterday_ph, today_ph);
  if n <> 1 or m <> 0 then
    raise exception 'FAIL 3a mixed-role user got manager rows A/B=%/%', n, m;
  end if;
  raise notice 'PASS 7 manager authority applies only at the branch they manage';

  reset role;
  perform set_config('request.jwt.claims',
    json_build_object('sub', cashier_id, 'role', 'authenticated')::text, true);
  set local role authenticated;
  select count(*) into n
  from public.get_pos_manager_report_summary(branch_a, yesterday_ph, today_ph);
  if n <> 0 then raise exception 'FAIL 3b a Cashier read Manager reports'; end if;

  reset role;
  perform set_config('request.jwt.claims',
    json_build_object('sub', outsider_id, 'role', 'authenticated')::text, true);
  set local role authenticated;
  select count(*) into n
  from public.get_pos_manager_report_summary(branch_a, yesterday_ph, today_ph);
  if n <> 0 then raise exception 'FAIL 3c an unassigned user read Manager reports'; end if;
  raise notice 'PASS 8 Cashiers and unassigned users read no Manager report rows';

  reset role;
  update public.pos_branch_assignments set status = 'inactive'
  where profile_id = manager_id and branch_id = branch_a;
  perform set_config('request.jwt.claims',
    json_build_object('sub', manager_id, 'role', 'authenticated')::text, true);
  set local role authenticated;
  select count(*) into n
  from public.get_pos_manager_report_summary(branch_a, yesterday_ph, today_ph);
  if n <> 0 then raise exception 'FAIL 3d an inactive assignment retained report access'; end if;

  reset role;
  -- Phase 9A: a closed assignment cannot be reactivated -- re-granting
  -- creates a NEW row, which is the product's behaviour and not a test
  -- workaround (see 20260828060000).
  insert into public.pos_branch_assignments (profile_id, branch_id, pos_role, created_by)
  select a.profile_id, a.branch_id, a.pos_role, a.created_by
    from public.pos_branch_assignments a
   where a.profile_id = manager_id and a.branch_id = branch_a
   order by a.created_at desc limit 1;
  perform set_config('request.jwt.claims',
    json_build_object('sub', admin_id, 'role', 'authenticated')::text, true);
  update public.profiles set status = 'inactive' where id = manager_id;
  perform set_config('request.jwt.claims',
    json_build_object('sub', manager_id, 'role', 'authenticated')::text, true);
  set local role authenticated;
  select count(*) into n
  from public.get_pos_manager_report_summary(branch_a, yesterday_ph, today_ph);
  if n <> 0 then raise exception 'FAIL 3e an inactive profile retained report access'; end if;
  reset role;
  perform set_config('request.jwt.claims',
    json_build_object('sub', admin_id, 'role', 'authenticated')::text, true);
  update public.profiles set status = 'active' where id = manager_id;
  perform set_config('request.jwt.claims', null, true);
  raise notice 'PASS 9 inactive assignments and profiles lose report access immediately';

  --------------------------------------------- 4. Administrator financial data
  perform set_config('request.jwt.claims',
    json_build_object('sub', admin_id, 'role', 'authenticated')::text, true);
  set local role authenticated;

  select r.sales_collected, r.product_sales, r.fees_collected, r.total_cogs,
         r.gross_product_profit, r.gross_product_margin,
         r.transaction_count, r.items_sold
    into amount, amount_2, amount_3, label, definition, signature, n, m
  from public.get_admin_pos_report_summary(null, yesterday_ph, today_ph) r;
  if amount <> 1045.00 or amount_2 <> 950.00 or amount_3 <> 95.00
     or label::numeric <> 570.00 or definition::numeric <> 380.00
     or signature::numeric <> 40.00 or n <> 3 or m <> 10 then
    raise exception 'FAIL 4a Admin totals collected=% product=% fees=% cogs=% profit=% margin=% tx=% items=%',
      amount, amount_2, amount_3, label, definition, signature, n, m;
  end if;
  raise notice 'PASS 10 Admin margin is ((Product Sales - COGS) / Product Sales) x 100';

  select count(*) into n
  from public.get_admin_pos_report_summary(branch_a, today_ph + 2, today_ph + 2) r
  where r.product_sales = 0 and r.gross_product_margin is null;
  if n <> 1 then raise exception 'FAIL 4b zero Product Sales did not return a NULL margin'; end if;
  raise notice 'PASS 11 zero Product Sales returns NULL Gross Product Margin';

  select count(*) into n
  from public.get_admin_pos_report_branch_comparison(yesterday_ph, today_ph) b
  where b.branch_id in (branch_a, branch_b) and b.transaction_count > 0;
  if n <> 2 then raise exception 'FAIL 4c branch comparison returned % fixture branches', n; end if;
  select count(distinct b.branch_id), count(*) into n, m
  from public.get_admin_pos_report_branch_comparison(yesterday_ph, today_ph) b
  where b.branch_id in (branch_a, branch_b);
  if n <> 2 or m <> 2 then
    raise exception 'FAIL 4d branch comparison grouped fixture branches as distinct ids=% rows=%', n, m;
  end if;
  select b.product_sales, b.total_cogs, b.gross_product_profit,
         b.gross_product_margin, b.items_sold
    into amount, amount_2, amount_3, label, n
  from public.get_admin_pos_report_branch_comparison(yesterday_ph, today_ph) b
  where b.branch_id = branch_a;
  if amount <> 550.00 or amount_2 <> 330.00 or amount_3 <> 220.00
     or label::numeric <> 40.00 or n <> 6 then
    raise exception 'FAIL 4e branch A comparison product=% cogs=% profit=% margin=% items=%',
      amount, amount_2, amount_3, label, n;
  end if;
  raise notice 'PASS 12 Administrator branch comparison aggregates by branch_id';

  reset role;
  perform set_config('request.jwt.claims',
    json_build_object('sub', manager_id, 'role', 'authenticated')::text, true);
  set local role authenticated;
  select count(*) into n
  from public.get_admin_pos_report_summary(null, yesterday_ph, today_ph);
  select count(*) into m
  from public.get_admin_pos_report_branch_comparison(yesterday_ph, today_ph);
  if n <> 0 or m <> 0 then
    raise exception 'FAIL 4f a non-Administrator read Admin reports summary/branches=%/%', n, m;
  end if;
  raise notice 'PASS 13 non-Administrators read no Administrator report rows';

  ------------------------------------------ 5. structural cost/status contracts
  reset role;
  for rec in
    select p.oid, p.proname
    from pg_proc p
    join pg_namespace ns on ns.oid = p.pronamespace
    where ns.nspname = 'public'
      and p.proname in (
        'get_pos_manager_report_summary',
        'get_pos_manager_report_trend',
        'get_pos_manager_report_payment_totals',
        'get_pos_manager_report_top_products'
      )
  loop
    signature := pg_get_function_result(rec.oid);
    definition := pg_get_functiondef(rec.oid);
    if signature ~* '(unit_cost|average_unit_cost|line_cogs|total_cogs|cogs|cost|margin|profit|net_sales|inventory_value|jsonb)' then
      raise exception 'FAIL 5a % declares a forbidden cost result: %', rec.proname, signature;
    end if;
    if definition ~* '(default_unit_cost|unit_cost_snapshot|average_unit_cost|line_cogs|total_cogs|gross_product_margin|gross_product_profit|net_profit|net_sales|inventory_value|get_admin_pos_report_)' then
      raise exception 'FAIL 5b % depends on a forbidden cost fact', rec.proname;
    end if;
  end loop;
  raise notice 'PASS 14 Manager result signatures and definitions contain no cost, COGS, margin or profit dependency';

  for rec in
    select p.oid, p.proname,
      case
        when p.proname in ('get_pos_manager_report_summary',
                           'get_pos_manager_report_trend',
                           'get_admin_pos_report_summary',
                           'get_admin_pos_report_trend',
                           'get_admin_pos_report_branch_comparison') then 2
        else 1
      end as expected_predicates
    from pg_proc p
    join pg_namespace ns on ns.oid = p.pronamespace
    where ns.nspname = 'public'
      and p.proname in (
        'get_pos_manager_report_summary',
        'get_pos_manager_report_trend',
        'get_pos_manager_report_payment_totals',
        'get_pos_manager_report_top_products',
        'get_admin_pos_report_summary',
        'get_admin_pos_report_trend',
        'get_admin_pos_report_branch_comparison'
      )
  loop
    definition := lower(pg_get_functiondef(rec.oid));
    n := regexp_count(definition, E'\\.status[[:space:]]*=[[:space:]]*''completed''');
    if n <> rec.expected_predicates then
      raise exception 'FAIL 5c % has % explicit completed predicates, expected %',
        rec.proname, n, rec.expected_predicates;
    end if;
  end loop;
  raise notice 'PASS 15 every sales-reading report query explicitly restricts status=completed';

  for rec in
    select p.oid, p.proname
    from pg_proc p
    join pg_namespace ns on ns.oid = p.pronamespace
    where ns.nspname = 'public'
      and p.proname in ('get_admin_pos_report_summary',
                        'get_admin_pos_report_trend',
                        'get_admin_pos_report_branch_comparison')
  loop
    signature := pg_get_function_result(rec.oid);
    if signature !~* 'total_cogs'
       or signature !~* 'gross_product_profit'
       or signature !~* 'gross_product_margin'
       or signature ~* '(net_profit|net_sales)' then
      raise exception 'FAIL 5d % has the wrong Administrator financial signature: %',
        rec.proname, signature;
    end if;
  end loop;

  select pg_get_functiondef(
    'public.get_pos_manager_report_trend(uuid,date,date)'::regprocedure)
  into definition;
  if definition ~* 'created_at[[:space:]]*::[[:space:]]*date'
     or regexp_count(definition, 'pos_business_timezone') <> 4 then
    raise exception 'FAIL 5e Manager trend does not consistently bucket in business time';
  end if;
  select pg_get_functiondef(
    'public.get_admin_pos_report_trend(uuid,date,date)'::regprocedure)
  into definition;
  if definition ~* 'created_at[[:space:]]*::[[:space:]]*date'
     or regexp_count(definition, 'pos_business_timezone') <> 4 then
    raise exception 'FAIL 5f Admin trend does not consistently bucket in business time';
  end if;

  select lower(pg_get_functiondef(
    'public.get_pos_manager_report_top_products(uuid,date,date,integer)'::regprocedure))
  into definition;
  if definition !~ 'group by[[:space:]]+x.product_id'
     or definition ~ 'group by[^;]+product_name' then
    raise exception 'FAIL 5g top products is not grouped solely by product_id';
  end if;
  select lower(pg_get_functiondef(
    'public.get_admin_pos_report_branch_comparison(date,date)'::regprocedure))
  into definition;
  if definition !~ 'group by[[:space:]]+x.branch_id'
     or definition ~ 'group by[^;]+branch_name' then
    raise exception 'FAIL 5h branch comparison is not grouped by branch_id';
  end if;
  raise notice 'PASS 16 trend and stable-identity grouping are pinned in function definitions';

  perform set_config('request.jwt.claims',
    json_build_object('sub', manager_id, 'role', 'authenticated')::text, true);
  set local role authenticated;
  select count(*) into n from public.pos_sales;
  select count(*) into m from public.pos_sale_items;
  if n <> 0 or m <> 0 then
    raise exception 'FAIL 5i Manager read cost-bearing sale tables directly: sales/items=%/%', n, m;
  end if;
  reset role;
  raise notice 'PASS 17 cost-bearing sale tables remain unreadable to a Manager';

  --------------------------------------------------------- 6. actual ACL/catalog
  for label in
    select unnest(array[
      'public.get_pos_report_presets()',
      'public.get_pos_manager_report_summary(uuid,date,date)',
      'public.get_pos_manager_report_trend(uuid,date,date)',
      'public.get_pos_manager_report_payment_totals(uuid,date,date)',
      'public.get_pos_manager_report_top_products(uuid,date,date,integer)',
      'public.get_admin_pos_report_summary(uuid,date,date)',
      'public.get_admin_pos_report_trend(uuid,date,date)',
      'public.get_admin_pos_report_branch_comparison(date,date)'
    ])
  loop
    if has_function_privilege('anon', label, 'execute') then
      raise exception 'FAIL 6a anon or PUBLIC holds EXECUTE on %', label;
    end if;
    if not has_function_privilege('authenticated', label, 'execute') then
      raise exception 'FAIL 6b authenticated lost EXECUTE on %', label;
    end if;
  end loop;

  label := 'public.pos_report_bounds(date,date)';
  if has_function_privilege('anon', label, 'execute')
     or has_function_privilege('authenticated', label, 'execute')
     or not has_function_privilege('service_role', label, 'execute') then
    raise exception 'FAIL 6c internal bounds helper ACL is wrong';
  end if;

  select count(*) into n
  from pg_proc p
  join pg_namespace ns on ns.oid = p.pronamespace
  cross join lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) acl
  where ns.nspname = 'public'
    and p.proname in (
      'get_pos_report_presets',
      'pos_report_bounds',
      'get_pos_manager_report_summary',
      'get_pos_manager_report_trend',
      'get_pos_manager_report_payment_totals',
      'get_pos_manager_report_top_products',
      'get_admin_pos_report_summary',
      'get_admin_pos_report_trend',
      'get_admin_pos_report_branch_comparison'
    )
    and acl.grantee = 0
    and acl.privilege_type = 'EXECUTE';
  if n <> 0 then raise exception 'FAIL 6d PUBLIC has % explicit report EXECUTE grants', n; end if;
  raise notice 'PASS 18 actual catalog ACLs exclude PUBLIC/anon and keep only intended API roles';

  select count(*) into n
  from pg_proc p
  join pg_namespace ns on ns.oid = p.pronamespace
  where ns.nspname = 'public'
    and p.proname in (
      'get_pos_manager_report_summary',
      'get_pos_manager_report_trend',
      'get_pos_manager_report_payment_totals',
      'get_pos_manager_report_top_products',
      'get_admin_pos_report_summary',
      'get_admin_pos_report_trend',
      'get_admin_pos_report_branch_comparison'
    )
    and p.prosecdef
    and p.provolatile = 's'
    and 'search_path=""' = any(p.proconfig);
  if n <> 7 then raise exception 'FAIL 6e only % of 7 protected report RPCs are hardened', n; end if;

  if to_regclass('public.pos_sales_completed_created_idx') is null then
    raise exception 'FAIL 6f the completed-sales report index is missing';
  end if;
  select count(*) into n
  from pg_index i
  where i.indexrelid = 'public.pos_sales_completed_created_idx'::regclass
    and pg_get_expr(i.indpred, i.indrelid) ~* 'status.*completed';
  if n <> 1 then raise exception 'FAIL 6g the report index is not partial on completed sales'; end if;
  raise notice 'PASS 19 protected report RPCs and the completed-sales index match the live catalog';

  raise notice '--- all Phase 7B POS Reports contract checks passed ---';
end $$;

rollback;

select 'sales after rollback: ' || count(*) as verify from public.pos_sales;
