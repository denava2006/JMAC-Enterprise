-- POS Manager dashboard and category summary — database contract test.
--
-- The claims:
--   a manager reads the branch they manage, and only that one
--   manager authority does not travel: manager at A, cashier at B reads A only
--   a cashier, an unassigned employee, a revoked assignment and a deactivated
--     profile all read nothing
--   an Administrator is NOT an alternative branch here -- these are
--     manager-only by design, and an admin POS dashboard is a later decision
--   "today" is the business day in Asia/Manila, not the server's UTC day
--   items_sold sums quantity; it is not a count of lines
--   top products group by product_id, so a rename cannot split one product
--   sales values come from historical snapshots, not current prices
--   low and out-of-stock counts are disjoint, and ignore draft, archived and
--     paused products
--   category counts do not let archived products inflate them, the manager
--     cannot modify a category, and General stays protected
--   no dashboard or category function declares a cost column
--
-- Run:
--   docker exec -i supabase_db_harmony-suite psql -U postgres -d postgres \
--     -v ON_ERROR_STOP=1 -f - < supabase/tests/pos_dashboard_rls.sql
--
-- One transaction, rolled back at the end. Nothing is written.

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
  admin_id     uuid;
  manager_id   uuid;   -- manager at A
  cashier_id   uuid;   -- cashier at A
  mixed_id     uuid;   -- manager at A, cashier at B
  outsider_id  uuid;   -- no POS assignment at all
  branch_a     uuid;
  branch_b     uuid;
  general_id   uuid;
  drinks_id    uuid;
  cola_id      uuid;   -- sold, and renamed mid-day
  chips_id     uuid;   -- sold once
  paused_id    uuid;   -- carried but not offered
  draft_id     uuid;   -- not active enterprise-wide
  today_ph     date;
  n            integer;
  m            integer;
  amt          numeric;
  txt          text;
  tag          text := left(replace(gen_random_uuid()::text, '-', ''), 8);
begin
  ------------------------------------------------------------------ fixtures
  select id into admin_id from public.profiles where role = 'admin' and status = 'active' limit 1;
  select id into branch_a from public.branches where is_active order by name limit 1;
  select id into branch_b from public.branches where is_active and id <> branch_a order by name limit 1;
  select id into general_id from public.pos_product_categories where normalized_name = 'general';

  select id into manager_id from public.profiles
    where role = 'employee' and status = 'active' order by created_at, id limit 1;
  select id into cashier_id from public.profiles
    where role = 'employee' and status = 'active' and id <> manager_id order by created_at, id limit 1;
  -- POS roles come from assignments, never from the HR role, so an hr_staff
  -- account is a perfectly good stand-in for the mixed-role user.
  select id into mixed_id from public.profiles
    where role = 'hr_staff' and status = 'active' order by created_at, id limit 1;
  select id into outsider_id from public.profiles
    where role = 'hr_manager' and status = 'active' order by created_at, id limit 1;

  if admin_id is null or branch_b is null or manager_id is null or cashier_id is null
     or mixed_id is null or outsider_id is null or general_id is null then
    raise exception 'fixture: need an admin, two branches, two employees, hr_staff, hr_manager, General';
  end if;

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
         (mixed_id,   branch_a, 'manager', admin_id),   -- manages A
         (mixed_id,   branch_b, 'cashier', admin_id);   -- only cashiers at B

  insert into public.pos_product_categories (name, description, color, is_active, sort_order, created_by)
  values ('ZZ Dash Drinks ' || tag, 'Bottled and canned', '#3366ff', true, 90, admin_id)
  returning id into drinks_id;

  insert into public.pos_products (name, category_id, default_selling_price, default_unit_cost, status)
  values ('ZZ Dash Cola ' || tag,  drinks_id, 100.00, 60.00, 'active') returning id into cola_id;
  insert into public.pos_products (name, category_id, default_selling_price, default_unit_cost, status)
  values ('ZZ Dash Chips ' || tag, drinks_id,  50.00, 30.00, 'active') returning id into chips_id;
  insert into public.pos_products (name, category_id, default_selling_price, default_unit_cost, status)
  values ('ZZ Dash Paused ' || tag, drinks_id, 25.00, 10.00, 'active') returning id into paused_id;
  -- A draft product must not appear in any operational count.
  insert into public.pos_products (name, category_id, default_selling_price, default_unit_cost, status)
  values ('ZZ Dash Draft ' || tag, drinks_id, 10.00, 5.00, 'draft') returning id into draft_id;

  insert into public.pos_branch_products (branch_id, product_id)
  values (branch_a, cola_id), (branch_a, chips_id), (branch_a, paused_id), (branch_a, draft_id),
         (branch_b, cola_id);

  perform set_config('request.jwt.claims', json_build_object('sub', admin_id, 'role', 'authenticated')::text, true);
  set local role authenticated;
  -- Cola: plenty. Chips: 2, with a low-stock level of 5, so it is LOW.
  -- Paused: 0 on hand, but not offered, so it is neither low nor out.
  perform public.receive_pos_stock(branch_a, cola_id, 100, 60.00, null);
  perform public.receive_pos_stock(branch_a, chips_id, 2, 30.00, null);
  perform public.receive_pos_stock(branch_b, cola_id, 50, 60.00, null);
  reset role;

  update public.pos_branch_inventory set low_stock_threshold = 5
   where branch_id = branch_a and product_id = chips_id;
  update public.pos_branch_products set is_available = false
   where branch_id = branch_a and product_id = paused_id;

  select business_date into today_ph from public.pos_day_bounds();

  -- Two sales at branch A today: 3 cola by the cashier, 2 cola + 1 chips by
  -- the manager. Units sold = 6 across three lines, which is the whole point
  -- of the items_sold check below.
  perform set_config('request.jwt.claims', json_build_object('sub', cashier_id, 'role', 'authenticated')::text, true);
  set local role authenticated;
  perform public.checkout_pos_sale(branch_a,
    jsonb_build_array(jsonb_build_object('product_id', cola_id, 'quantity', 3)),
    'cash', gen_random_uuid(), null, 1000);
  reset role;

  perform set_config('request.jwt.claims', json_build_object('sub', manager_id, 'role', 'authenticated')::text, true);
  set local role authenticated;
  perform public.checkout_pos_sale(branch_a,
    jsonb_build_array(
      jsonb_build_object('product_id', cola_id, 'quantity', 2),
      jsonb_build_object('product_id', chips_id, 'quantity', 1)),
    'gcash', gen_random_uuid(), '09171234567', null);
  reset role;

  -- A sale at branch B, where the mixed user only cashiers.
  perform set_config('request.jwt.claims', json_build_object('sub', mixed_id, 'role', 'authenticated')::text, true);
  set local role authenticated;
  perform public.checkout_pos_sale(branch_b,
    jsonb_build_array(jsonb_build_object('product_id', cola_id, 'quantity', 4)),
    'cash', gen_random_uuid(), null, 1000);
  reset role;

  -- One sale placed just BEFORE today's business day began, and one just after
  -- it ends. Neither may be counted. Written directly: checkout_pos_sale
  -- stamps now(), and the point is to straddle the boundary.
  insert into public.pos_sales (
    branch_id, cashier_id, status, subtotal, fees_total, total_amount, fees,
    payment_method, amount_tendered, change_given, branch_name, cashier_name,
    checkout_key, request_fingerprint, created_at)
  select branch_a, cashier_id, 'completed', 999.00, 0, 999.00, '[]'::jsonb,
         'cash', 1000.00, 1.00, 'x', 'x',
         gen_random_uuid(), 'boundary-before-' || tag,
         b.day_start - interval '1 second'
  from public.pos_day_bounds() b;
  insert into public.pos_sales (
    branch_id, cashier_id, status, subtotal, fees_total, total_amount, fees,
    payment_method, amount_tendered, change_given, branch_name, cashier_name,
    checkout_key, request_fingerprint, created_at)
  select branch_a, cashier_id, 'completed', 888.00, 0, 888.00, '[]'::jsonb,
         'cash', 900.00, 12.00, 'x', 'x',
         gen_random_uuid(), 'boundary-after-' || tag, b.day_end
  from public.pos_day_bounds() b;

  ---------------------------------------------- 1. business time, not UTC time
  if public.pos_business_timezone() <> 'Asia/Manila' then
    raise exception 'FAIL  1a business timezone is %, expected Asia/Manila', public.pos_business_timezone();
  end if;
  raise notice 'PASS  1a the business timezone is a single database-owned value';

  select count(*) into n from public.pos_day_bounds() b
   where b.day_end - b.day_start = interval '24 hours';
  if n <> 1 then raise exception 'FAIL  1b a business day is not 24 hours long'; end if;
  raise notice 'PASS  1b a business day runs a full 24 hours, half-open';

  -- Manila is UTC+8, so its day starts at 16:00 UTC the previous day. If this
  -- ever equals 00:00 UTC the window has silently become the server's day.
  select count(*) into n from public.pos_day_bounds() b
   where extract(hour from (b.day_start at time zone 'UTC')) = 16;
  if n <> 1 then raise exception 'FAIL  1c the day does not start at Manila midnight'; end if;
  raise notice 'PASS  1c the window is Manila midnight, not the server''s midnight';

  select count(*) into n from public.pos_day_bounds('2026-03-01'::date) b
   where b.business_date = '2026-03-01'::date;
  if n <> 1 then raise exception 'FAIL  1d an explicit date is not honoured'; end if;
  raise notice 'PASS  1d an explicit calendar date is honoured as given';

  ------------------------------------------------- 2. the manager's own branch
  perform set_config('request.jwt.claims', json_build_object('sub', manager_id, 'role', 'authenticated')::text, true);
  set local role authenticated;

  select count(*) into n from public.get_pos_dashboard_summary(branch_a);
  if n <> 1 then raise exception 'FAIL  2a the manager got % summary rows, expected 1', n; end if;
  raise notice 'PASS  2a a manager reads the dashboard for the branch they manage';

  select d.transaction_count into n from public.get_pos_dashboard_summary(branch_a) d;
  if n <> 2 then raise exception 'FAIL  2b transaction_count is %, expected today''s 2', n; end if;
  raise notice 'PASS  2b transaction_count counts today''s sales and excludes the boundary rows';

  -- THE check. Three lines, six units. Phase 6 found exactly this bug in
  -- item_count, and every new aggregate gets the same test.
  select d.items_sold into n from public.get_pos_dashboard_summary(branch_a) d;
  if n <> 6 then raise exception 'FAIL  2c items_sold is %, expected 6 units across 3 lines', n; end if;
  raise notice 'PASS  2c items_sold sums quantity -- it is not a count of lines';

  select d.product_sales, d.fees_collected, d.sales_collected
    into amt, n, m from public.get_pos_dashboard_summary(branch_a) d;
  -- 5 cola at 100 plus 1 chips at 50. The 999 and 888 boundary rows are out.
  if amt <> 550.00 then
    raise exception 'FAIL  2d product_sales is %, expected 5 cola + 1 chips = 550', amt;
  end if;
  raise notice 'PASS  2d product_sales is the subtotal of today''s sales only';

  select count(*) into n from public.get_pos_dashboard_summary(branch_a) d
   where d.sales_collected = d.product_sales + d.fees_collected;
  if n <> 1 then raise exception 'FAIL  2e the three money figures do not reconcile'; end if;
  raise notice 'PASS  2e sales_collected = product_sales + fees_collected';

  select count(*) into n from public.get_pos_dashboard_summary(branch_a) d
   where d.average_sale = round(d.sales_collected / 2, 2);
  if n <> 1 then raise exception 'FAIL  2f average_sale is not the day''s mean'; end if;
  raise notice 'PASS  2f average_sale is collected over transactions';

  select d.business_date into today_ph from public.get_pos_dashboard_summary(branch_a) d;
  if today_ph <> public.pos_business_date() then
    raise exception 'FAIL  2g the summary reports a different day from pos_business_date()';
  end if;
  raise notice 'PASS  2g the summary echoes the business day it actually used';

  ------------------------------------------------------- 3. stock, right now
  -- Chips: 2 on hand against a level of 5 -> LOW. Cola: 95 -> neither.
  -- Paused: 0 on hand but not offered -> neither. Draft: never counted.
  select d.low_stock_count, d.out_of_stock_count into n, m
    from public.get_pos_dashboard_summary(branch_a) d;
  if n <> 1 then raise exception 'FAIL  3a low_stock_count is %, expected 1', n; end if;
  if m <> 0 then raise exception 'FAIL  3b out_of_stock_count is %, expected 0', m; end if;
  raise notice 'PASS  3a low counts positive-but-not-enough, and excludes paused and draft';

  -- Take the chips down to zero and the row must move from Low to Out, never
  -- both. Through adjust_pos_stock, because a trigger refuses a direct write to
  -- the balance -- which is itself the Phase 4 contract.
  reset role;
  perform set_config('request.jwt.claims', json_build_object('sub', admin_id, 'role', 'authenticated')::text, true);
  set local role authenticated;
  perform public.adjust_pos_stock(branch_a, chips_id, -1, 'damaged', null);
  reset role;
  perform set_config('request.jwt.claims', json_build_object('sub', manager_id, 'role', 'authenticated')::text, true);
  set local role authenticated;

  select d.low_stock_count, d.out_of_stock_count into n, m
    from public.get_pos_dashboard_summary(branch_a) d;
  if n <> 0 or m <> 1 then
    raise exception 'FAIL  3c at zero the product is low=% out=%, expected 0/1', n, m;
  end if;
  raise notice 'PASS  3c the two counts are disjoint: zero is out, never also low';

  -- ...while the shipped is_low_stock contract is untouched.
  select count(*) into n from public.get_branch_inventory(branch_a) i
   where i.product_id = chips_id and i.is_low_stock;
  if n <> 1 then raise exception 'FAIL  3d get_branch_inventory.is_low_stock changed behaviour'; end if;
  raise notice 'PASS  3d the shipped is_low_stock contract is unchanged';

  reset role;
  perform set_config('request.jwt.claims', json_build_object('sub', admin_id, 'role', 'authenticated')::text, true);
  set local role authenticated;
  perform public.adjust_pos_stock(branch_a, chips_id, 1, 'found', null);
  reset role;
  perform set_config('request.jwt.claims', json_build_object('sub', manager_id, 'role', 'authenticated')::text, true);
  set local role authenticated;

  ------------------------------------------------------------- 4. top products
  select count(*) into n from public.get_pos_dashboard_top_products(branch_a);
  if n <> 2 then raise exception 'FAIL  4a top products returned % rows, expected 2', n; end if;

  select t.quantity_sold, t.sales_amount into n, amt
    from public.get_pos_dashboard_top_products(branch_a) t where t.product_id = cola_id;
  if n <> 5 then raise exception 'FAIL  4b cola quantity is %, expected 5', n; end if;
  if amt <> 500.00 then raise exception 'FAIL  4c cola sales is %, expected 500 from snapshots', amt; end if;
  raise notice 'PASS  4a top products rank by units, valued from historical line totals';

  -- Rename the product and re-price it. Neither may change today's figures,
  -- and the rename must not split one product into two ranked rows.
  reset role;
  update public.pos_products set name = 'ZZ Dash Cola RENAMED ' || tag, default_selling_price = 999.00
   where id = cola_id;
  perform set_config('request.jwt.claims', json_build_object('sub', manager_id, 'role', 'authenticated')::text, true);
  set local role authenticated;

  select count(*) into n from public.get_pos_dashboard_top_products(branch_a);
  if n <> 2 then raise exception 'FAIL  4d a rename split the ranking into % rows', n; end if;
  select t.quantity_sold, t.sales_amount into n, amt
    from public.get_pos_dashboard_top_products(branch_a) t where t.product_id = cola_id;
  if n <> 5 or amt <> 500.00 then
    raise exception 'FAIL  4e re-pricing rewrote history: qty=% amount=%', n, amt;
  end if;
  raise notice 'PASS  4b grouping is by product_id, so a rename cannot split a product';
  raise notice 'PASS  4c re-pricing a product does not rewrite what today earned';

  select count(*) into n from public.get_pos_dashboard_top_products(branch_a, null, 1);
  if n <> 1 then raise exception 'FAIL  4f the limit is not honoured'; end if;
  select count(*) into n from public.get_pos_dashboard_top_products(branch_a, null, 100000);
  if n > 100 then raise exception 'FAIL  4g an oversized limit was not clamped'; end if;
  raise notice 'PASS  4d the limit is honoured and an oversized one is clamped';

  ---------------------------------------------------------- 5. payment totals
  select count(*) into n from public.get_pos_dashboard_payment_totals(branch_a);
  if n <> 2 then raise exception 'FAIL  5a payment totals returned % methods, expected cash and gcash', n; end if;
  select p.amount_collected into amt from public.get_pos_dashboard_payment_totals(branch_a) p
   where p.payment_method = 'cash';
  if amt <> 300.00 then raise exception 'FAIL  5b cash total is %, expected 300', amt; end if;
  raise notice 'PASS  5a payment totals split today''s takings by method';

  -------------------------------------- 6. manager authority does not travel
  reset role;
  perform set_config('request.jwt.claims', json_build_object('sub', mixed_id, 'role', 'authenticated')::text, true);
  set local role authenticated;

  select count(*) into n from public.get_pos_dashboard_summary(branch_a);
  if n <> 1 then raise exception 'FAIL  6a the mixed user cannot read the branch they manage'; end if;
  raise notice 'PASS  6a manager at A reads A';

  select count(*) into n from public.get_pos_dashboard_summary(branch_b);
  if n <> 0 then raise exception 'FAIL  6b manager authority leaked into branch B, where they only cashier'; end if;
  select count(*) into n from public.get_pos_dashboard_top_products(branch_b);
  if n <> 0 then raise exception 'FAIL  6c top products leaked at branch B'; end if;
  select count(*) into n from public.get_pos_dashboard_payment_totals(branch_b);
  if n <> 0 then raise exception 'FAIL  6d payment totals leaked at branch B'; end if;
  select count(*) into n from public.get_branch_category_summary(branch_b);
  if n <> 0 then raise exception 'FAIL  6e the category summary leaked at branch B'; end if;
  raise notice 'PASS  6b none of the four reaches a branch they only cashier at';

  --------------------------------------------------- 7. everyone else is out
  reset role;
  perform set_config('request.jwt.claims', json_build_object('sub', cashier_id, 'role', 'authenticated')::text, true);
  set local role authenticated;
  select count(*) into n from public.get_pos_dashboard_summary(branch_a);
  if n <> 0 then raise exception 'FAIL  7a a cashier read the dashboard for their own branch'; end if;
  select count(*) into n from public.get_branch_category_summary(branch_a);
  if n <> 0 then raise exception 'FAIL  7b a cashier read the category summary'; end if;
  raise notice 'PASS  7a a cashier reads neither the dashboard nor the category summary';

  reset role;
  perform set_config('request.jwt.claims', json_build_object('sub', outsider_id, 'role', 'authenticated')::text, true);
  set local role authenticated;
  select count(*) into n from public.get_pos_dashboard_summary(branch_a);
  if n <> 0 then raise exception 'FAIL  7c an account with no POS assignment read the dashboard'; end if;
  raise notice 'PASS  7b an account with no POS assignment reads nothing';

  -- The Administrator, recorded honestly.
  --
  -- No is_admin() branch was ADDED to these four. They are gated by
  -- has_pos_role(branch, ['manager']), and that helper has read
  --   is_admin() OR (an active manager assignment at this branch)
  -- since Phase 2A -- get_branch_inventory, get_branch_movements,
  -- get_branch_catalogue_management, get_branch_transactions and
  -- get_pos_catalogue all inherit the same thing. So an Administrator reaches
  -- these RPCs too, consistently with every other branch-scoped read in the
  -- system.
  --
  -- What Phase 7A does NOT do is build them a surface: /pos/* is refused to an
  -- Administrator by blockRoles, and no /dashboard/* POS dashboard route
  -- exists. Excluding them at the RPC would mean adding `and not is_admin()`,
  -- which would make these four the only branch-scoped functions in the
  -- codebase that behave that way -- a change worth asking for rather than
  -- slipping in. This check pins the current truth so it cannot drift
  -- unnoticed either way.
  reset role;
  perform set_config('request.jwt.claims', json_build_object('sub', admin_id, 'role', 'authenticated')::text, true);
  set local role authenticated;
  select count(*) into n from public.get_pos_dashboard_summary(branch_a);
  if n <> 1 then
    raise exception 'FAIL  7d admin reach through has_pos_role changed: got % rows', n;
  end if;
  -- And what they get is still cost-free, like everyone else's.
  select count(*) into n from public.get_pos_dashboard_summary(branch_a) d
   where d.sales_collected = d.product_sales + d.fees_collected;
  if n <> 1 then raise exception 'FAIL  7e the administrator''s figures do not reconcile'; end if;
  raise notice 'PASS  7c an administrator inherits reach from has_pos_role, as on every other branch RPC';
  raise notice 'PASS  7d and receives the same receipt-safe, cost-free figures';

  -------------------------------------- 8. revoked, and deactivated, are out
  reset role;
  update public.pos_branch_assignments set status = 'inactive'
   where profile_id = manager_id and branch_id = branch_a;
  perform set_config('request.jwt.claims', json_build_object('sub', manager_id, 'role', 'authenticated')::text, true);
  set local role authenticated;
  select count(*) into n from public.get_pos_dashboard_summary(branch_a);
  if n <> 0 then raise exception 'FAIL  8a a deactivated assignment still read the dashboard'; end if;
  select count(*) into n from public.get_branch_category_summary(branch_a);
  if n <> 0 then raise exception 'FAIL  8b a deactivated assignment still read the category summary'; end if;
  raise notice 'PASS  8a deactivating the assignment closes both immediately';

  reset role;
  -- Phase 9A: a closed assignment cannot be reactivated -- re-granting
  -- creates a NEW row, which is the product's behaviour and not a test
  -- workaround (see 20260828060000).
  insert into public.pos_branch_assignments (profile_id, branch_id, pos_role, created_by)
  select a.profile_id, a.branch_id, a.pos_role, a.created_by
    from public.pos_branch_assignments a
   where a.profile_id = manager_id and a.branch_id = branch_a
   order by a.created_at desc limit 1;
  -- A trigger reserves profiles.status for an administrator, which is itself a
  -- Phase 2 contract. Become one to flip it rather than reaching around it.
  perform set_config('request.jwt.claims', json_build_object('sub', admin_id, 'role', 'authenticated')::text, true);
  update public.profiles set status = 'inactive' where id = manager_id;
  perform set_config('request.jwt.claims', null, true);
  perform set_config('request.jwt.claims', json_build_object('sub', manager_id, 'role', 'authenticated')::text, true);
  set local role authenticated;
  select count(*) into n from public.get_pos_dashboard_summary(branch_a);
  if n <> 0 then raise exception 'FAIL  8c a deactivated profile still read the dashboard'; end if;
  raise notice 'PASS  8b a live assignment on a deactivated profile grants nothing';

  reset role;
  perform set_config('request.jwt.claims', json_build_object('sub', admin_id, 'role', 'authenticated')::text, true);
  update public.profiles set status = 'active' where id = manager_id;
  perform set_config('request.jwt.claims', null, true);

  ------------------------------------------------------- 9. category summary
  perform set_config('request.jwt.claims', json_build_object('sub', manager_id, 'role', 'authenticated')::text, true);
  set local role authenticated;

  select c.product_count, c.offered_count into n, m
    from public.get_branch_category_summary(branch_a) c where c.category_id = drinks_id;
  -- Cola, Chips and Paused are active and carried. Draft is not active, so it
  -- must not inflate the count.
  if n <> 3 then raise exception 'FAIL  9a product_count is %, expected 3 active carried products', n; end if;
  if m <> 2 then raise exception 'FAIL  9b offered_count is %, expected 2 (Paused is switched off)', m; end if;
  raise notice 'PASS  9a category counts are the branch''s own, and exclude draft products';
  raise notice 'PASS  9b offered_count separates what is carried from what is switched on';

  reset role;
  update public.pos_products set status = 'archived' where id = chips_id;
  perform set_config('request.jwt.claims', json_build_object('sub', manager_id, 'role', 'authenticated')::text, true);
  set local role authenticated;
  select c.product_count into n
    from public.get_branch_category_summary(branch_a) c where c.category_id = drinks_id;
  if n <> 2 then raise exception 'FAIL  9c an archived product still counted: %', n; end if;
  raise notice 'PASS  9c archiving a product removes it from operational counts';

  reset role;
  update public.pos_products set status = 'active' where id = chips_id;
  -- A retired category holding live stock must still be visible, labelled.
  update public.pos_product_categories set is_active = false where id = drinks_id;
  perform set_config('request.jwt.claims', json_build_object('sub', manager_id, 'role', 'authenticated')::text, true);
  set local role authenticated;
  select count(*) into n from public.get_branch_category_summary(branch_a) c
   where c.category_id = drinks_id and not c.is_active;
  if n <> 1 then raise exception 'FAIL  9d a retired category holding carried products vanished'; end if;
  raise notice 'PASS  9d a retired category the branch still carries stays visible, flagged';

  select count(*) into n from public.get_branch_category_summary(branch_a) c
   where c.category_id = general_id;
  if n <> 1 then raise exception 'FAIL  9e an active category with no branch products was dropped'; end if;
  raise notice 'PASS  9e active categories appear even with nothing filed under them here';

  ------------------------------- 10. a manager still cannot touch the taxonomy
  begin
    update public.pos_product_categories set name = 'hijacked' where id = drinks_id;
    if found then raise exception 'FAIL 10a a manager renamed a global category'; end if;
    raise notice 'PASS 10a a manager''s rename of a global category changes nothing';
  exception when insufficient_privilege or raise_exception then
    raise notice 'PASS 10a a manager''s rename of a global category is refused';
  end;

  begin
    perform public.delete_pos_category(drinks_id, general_id);
    raise exception 'FAIL 10b a manager deleted a global category';
  exception when others then
    if sqlerrm like 'FAIL%' then raise; end if;
    raise notice 'PASS 10b delete_pos_category still refuses a manager';
  end;

  begin
    perform public.reorder_pos_category(drinks_id, 1);
    raise exception 'FAIL 10c a manager reordered the global taxonomy';
  exception when others then
    if sqlerrm like 'FAIL%' then raise; end if;
    raise notice 'PASS 10c reorder_pos_category still refuses a manager';
  end;

  reset role;
  begin
    update public.pos_product_categories set is_active = false where normalized_name = 'general';
    raise exception 'FAIL 10d General was archived';
  exception when others then
    if sqlerrm like 'FAIL%' then raise; end if;
    raise notice 'PASS 10d General is still protected';
  end;

  ------------------------------------------------------- 11. no cost anywhere
  for txt in
    select p.proname
    from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
    where ns.nspname = 'public'
      and p.proname in ('get_pos_dashboard_summary', 'get_pos_dashboard_payment_totals',
                        'get_pos_dashboard_top_products', 'get_branch_category_summary')
  loop
    if pg_get_function_result(('public.' || txt)::regproc) ~*
       '(unit_cost|average_unit_cost|cogs|margin|profit|net_sales)' then
      raise exception 'FAIL 11a % declares a cost column: %', txt,
        pg_get_function_result(('public.' || txt)::regproc);
    end if;
  end loop;
  raise notice 'PASS 11a no dashboard or category function declares cost, COGS, margin or profit';

  -- The sale tables still carry cost, and are still nobody's to read directly.
  perform set_config('request.jwt.claims', json_build_object('sub', manager_id, 'role', 'authenticated')::text, true);
  set local role authenticated;
  select count(*) into n from public.pos_sales;
  if n <> 0 then raise exception 'FAIL 11b a manager read pos_sales directly'; end if;
  select count(*) into n from public.pos_sale_items;
  if n <> 0 then raise exception 'FAIL 11c a manager read pos_sale_items directly'; end if;
  raise notice 'PASS 11b the cost-bearing sale tables remain unreadable to a manager';
  reset role;

  ------------------------------------------------------------------ 12. ACLs
  -- Asserted against pg_proc, never against the presence of a REVOKE line:
  -- this database has an ALTER DEFAULT PRIVILEGES rule that re-grants every new
  -- routine in public, and it has caught this project five times.
  for txt in
    select unnest(array[
      'public.get_pos_dashboard_summary(uuid,date)',
      'public.get_pos_dashboard_payment_totals(uuid,date)',
      'public.get_pos_dashboard_top_products(uuid,date,integer)',
      'public.get_branch_category_summary(uuid)',
      'public.pos_business_timezone()',
      'public.pos_business_date()',
      'public.pos_day_bounds(date)'
    ])
  loop
    if has_function_privilege('anon', txt, 'execute') then
      raise exception 'FAIL 12a anon holds EXECUTE on %', txt;
    end if;
    if not has_function_privilege('authenticated', txt, 'execute') then
      raise exception 'FAIL 12b authenticated lost EXECUTE on %', txt;
    end if;
  end loop;
  raise notice 'PASS 12a anon holds EXECUTE on none of the new functions';
  raise notice 'PASS 12b authenticated holds EXECUTE on all of them';

  select count(*) into n from pg_policies
   where tablename = 'pos_product_categories';
  if n <> 1 then
    raise exception 'FAIL 12c pos_product_categories now has % policies, expected the single admin one', n;
  end if;
  select count(*) into n from pg_policies
   where tablename = 'pos_product_categories' and qual like '%is_admin%';
  if n <> 1 then raise exception 'FAIL 12d the category policy is no longer is_admin()'; end if;
  raise notice 'PASS 12c the global category policy is still a single is_admin() rule';

  raise notice '--- all POS dashboard contract checks passed ---';
end $$;

rollback;

select 'sales after rollback: ' || count(*) as verify from public.pos_sales;
