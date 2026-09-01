-- New-product proposals — database contract test.
--
-- A branch with nothing in it could not ask for anything. Both existing
-- request types need a product to point at: restock needs one the branch
-- already carries, carry needs one the catalogue already has. On a fresh
-- deployment neither exists, so the first branch could not be started without
-- an Administrator hand-creating a product outside any workflow.
--
-- The third type is a PROPOSAL, and that word carries the whole security
-- argument: pos_products is enterprise-wide, so a manager who could insert
-- into it could add a row every other branch sells. They describe; an
-- Administrator approves; the approval creates.
--
-- What must remain true, and is what this suite is mostly about: approving a
-- proposal creates a product and a listing but NOT stock. Product approval is
-- not stock received, exactly as request approval is not stock received.
--
-- Run:
--   docker exec -i supabase_db_harmony-suite psql -U postgres -d postgres \
--     -v ON_ERROR_STOP=1 -f - < supabase/tests/pos_new_product_request_rls.sql
--
-- One transaction, rolled back at the end. Nothing is written.

begin;

create function pg_temp.make_manager(_profile_id uuid, _branch_id uuid)
returns void language plpgsql as $helper$
declare
  _dept uuid; _position uuid; _employee uuid; _admin uuid;
  _saved text := current_setting('request.jwt.claims', true);
begin
  select d.id into _dept from public.departments d where d.name = 'Store Operations';
  select po.id into _position from public.positions po
   where po.department_id = _dept and po.title = 'POS Manager';
  select p.employee_id into _employee from public.profiles p where p.id = _profile_id;
  if _employee is null then
    insert into public.employees (first_name, last_name, email, department_id, position_id,
                                  employment_status, hire_date)
    select coalesce(split_part(p.full_name,' ',1),'Test'),
           coalesce(nullif(split_part(p.full_name,' ',2),''),'Worker'),
           p.email, _dept, _position, 'active', current_date
    from public.profiles p where p.id = _profile_id returning id into _employee;
  else
    update public.employees set department_id=_dept, position_id=_position,
           employment_status='active' where id=_employee;
  end if;
  select p.id into _admin from public.profiles p where p.role='admin' and p.status='active' limit 1;
  perform set_config('request.jwt.claims',
                     json_build_object('sub',_admin,'role','authenticated')::text, true);
  update public.profiles set employee_id=_employee, role='employee', status='active'
   where id=_profile_id;
  insert into public.pos_branch_assignments (profile_id, branch_id, pos_role, created_by)
  values (_profile_id, _branch_id, 'manager', _admin);
  perform set_config('request.jwt.claims', coalesce(_saved,''), true);
end;
$helper$;

do $$
declare
  admin_id  uuid;
  manager   uuid;
  other     uuid;
  branch_a  uuid;
  branch_b  uuid;
  general   uuid;
  req       uuid;
  prod      uuid;
  n         integer;
  qty       integer;
  txt       text;
  tag       text := left(replace(gen_random_uuid()::text, '-', ''), 8);
begin
  select id into admin_id from public.profiles where role='admin' and status='active' limit 1;
  select id into branch_a from public.branches where is_active order by name limit 1;
  select id into branch_b from public.branches where is_active and id <> branch_a order by name limit 1;
  select id into general from public.pos_product_categories where normalized_name='general';
  select id into manager from public.profiles
   where role='employee' and status='active' order by created_at, id limit 1;
  select id into other from public.profiles
   where role <> 'admin' and status='active' and id <> manager order by created_at, id limit 1;
  if admin_id is null or branch_a is null or branch_b is null or general is null
     or manager is null or other is null then
    raise exception 'fixture: need an admin, two branches, General and two employees';
  end if;

  delete from public.pos_branch_assignments;
  perform pg_temp.make_manager(manager, branch_a);

  -- ======================================================================
  -- 1. A manager may propose; the proposal creates nothing
  -- ======================================================================
  perform set_config('request.jwt.claims',
    json_build_object('sub', manager, 'role', 'authenticated')::text, true);
  set local role authenticated;

  select public.create_pos_new_product_request(
    branch_a, 'ZZ Proposed ' || tag, general, 55.00, 'Nothing to sell at opening'
  ) into req;
  reset role;

  if req is null then
    raise exception 'FAIL  1a a manager could not propose a product';
  end if;
  raise notice 'PASS  1a a manager may propose a product for their branch';

  select count(*) into n from public.pos_products where name = 'ZZ Proposed ' || tag;
  if n <> 0 then
    raise exception 'FAIL  1b proposing created the product before review';
  end if;
  raise notice 'PASS  1b proposing creates no enterprise product';

  select count(*) into n from public.pos_branch_products bp
   join public.pos_inventory_requests r on r.id = req
   where bp.branch_id = branch_a and bp.product_id = r.product_id;
  if n <> 0 then
    raise exception 'FAIL  1c proposing created a branch listing before review';
  end if;
  raise notice 'PASS  1c proposing creates no branch listing and no stock';

  -- The row carries no quantity, so approving it has nothing to add.
  select requested_quantity into qty from public.pos_inventory_requests where id = req;
  if qty is not null then
    raise exception 'FAIL  1d a proposal carries an opening quantity of %', qty;
  end if;
  raise notice 'PASS  1d a proposal cannot carry an opening quantity';

  -- ======================================================================
  -- 2. Branch scope and duplicates
  -- ======================================================================
  perform set_config('request.jwt.claims',
    json_build_object('sub', manager, 'role', 'authenticated')::text, true);
  set local role authenticated;
  begin
    perform public.create_pos_new_product_request(
      branch_b, 'ZZ Elsewhere ' || tag, general, 10.00, 'not my branch');
    raise exception 'FAIL  2a a manager proposed for a branch they do not manage';
  exception when raise_exception then
    if sqlerrm like 'FAIL%' then raise; end if;
    raise notice 'PASS  2a a manager cannot propose for another branch';
  end;

  begin
    perform public.create_pos_new_product_request(
      branch_a, 'ZZ Proposed ' || tag, general, 55.00, 'again');
    raise exception 'FAIL  2b the same product was proposed twice while pending';
  exception when raise_exception then
    if sqlerrm like 'FAIL%' then raise; end if;
    raise notice 'PASS  2b the same proposal cannot be raised twice while pending';
  end;

  begin
    perform public.create_pos_new_product_request(
      branch_a, 'ZZ Proposed ' || tag, general, 0, 'free');
    raise exception 'FAIL  2c a non-positive price was accepted';
  exception when raise_exception then
    if sqlerrm like 'FAIL%' then raise; end if;
    raise notice 'PASS  2c a suggested price must be positive and bounded';
  end;
  reset role;

  -- A cashier cannot propose at all.
  perform set_config('request.jwt.claims',
    json_build_object('sub', other, 'role', 'authenticated')::text, true);
  set local role authenticated;
  begin
    perform public.create_pos_new_product_request(
      branch_a, 'ZZ Cashier ' || tag, general, 10.00, 'hostile');
    raise exception 'FAIL  2d an account with no manager assignment proposed a product';
  exception when raise_exception then
    if sqlerrm like 'FAIL%' then raise; end if;
    raise notice 'PASS  2d only a manager of that branch may propose';
  end;
  reset role;

  -- ======================================================================
  -- 3. Only an Administrator reviews, and never their own
  -- ======================================================================
  perform set_config('request.jwt.claims',
    json_build_object('sub', manager, 'role', 'authenticated')::text, true);
  set local role authenticated;
  begin
    perform public.approve_pos_request(req, 'self-approved');
    raise exception 'FAIL  3a a manager approved a product proposal';
  exception when raise_exception then
    if sqlerrm like 'FAIL%' then raise; end if;
    raise notice 'PASS  3a a manager cannot approve a product proposal';
  end;
  reset role;

  -- can_review_pos_request used to be a CASE with no ELSE, so an unnamed type
  -- returned NULL and `if not null then raise` never fired. This is the check
  -- that the new type is genuinely named rather than falling through.
  if public.can_review_pos_request('new_product') is null then
    raise exception 'FAIL  3b review authority for new_product is undefined';
  end if;
  raise notice 'PASS  3b review authority for the new type is explicitly defined';

  -- ======================================================================
  -- 4. Approval creates a product and a listing -- and no stock
  -- ======================================================================
  perform set_config('request.jwt.claims',
    json_build_object('sub', admin_id, 'role', 'authenticated')::text, true);
  set local role authenticated;
  perform public.approve_pos_request(req, 'approved for opening');
  reset role;

  select product_id into prod from public.pos_inventory_requests where id = req;
  if prod is null then
    raise exception 'FAIL  4a the approved proposal does not point at a product';
  end if;
  raise notice 'PASS  4a approval creates the product and links it to the proposal';

  select status::text into txt from public.pos_products where id = prod;
  if txt <> 'active' then
    raise exception 'FAIL  4b the created product is %', txt;
  end if;

  select count(*) into n from public.pos_branch_products
   where branch_id = branch_a and product_id = prod and is_available = false;
  if n <> 1 then
    raise exception 'FAIL  4c the branch listing was not created switched off';
  end if;
  raise notice 'PASS  4b-c the product is listed at the branch, switched off';

  select quantity_on_hand into qty from public.pos_branch_inventory
   where branch_id = branch_a and product_id = prod;
  if qty is null then
    raise exception 'FAIL  4d no inventory row was created for the new product';
  end if;
  if qty <> 0 then
    raise exception 'FAIL  4e approving a proposal created % units of stock', qty;
  end if;
  raise notice 'PASS  4d-e stock starts at exactly zero -- approval is not receiving';

  select count(*) into n from public.pos_inventory_movements
   where branch_id = branch_a and product_id = prod;
  if n <> 0 then
    raise exception 'FAIL  4f approving a proposal wrote % inventory movements', n;
  end if;
  raise notice 'PASS  4f approving a proposal writes no inventory movement';

  -- It is not sellable: the till only offers what is available.
  select count(*) into n from public.get_pos_catalogue(branch_a) c where c.product_id = prod;
  if n <> 0 then
    raise exception 'FAIL  4g a product with no stock is already on the till';
  end if;
  raise notice 'PASS  4g the product is not sellable until it is stocked and offered';

  -- ======================================================================
  -- 5. The rest of the workflow still works from here
  -- ======================================================================
  --
  -- The whole point of the proposal is to reach the existing engine. From a
  -- listed, zero-stock product a manager can now do what they could not before.
  perform set_config('request.jwt.claims',
    json_build_object('sub', manager, 'role', 'authenticated')::text, true);
  set local role authenticated;
  select public.create_pos_stock_request(branch_a, prod, 24, 'Initial branch stock') into req;
  reset role;
  if req is null then
    raise exception 'FAIL  5a a manager could not request stock for the new product';
  end if;
  raise notice 'PASS  5a the new product can immediately be restocked through the existing engine';

  perform set_config('request.jwt.claims',
    json_build_object('sub', admin_id, 'role', 'authenticated')::text, true);
  set local role authenticated;
  perform public.approve_pos_request(req, 'ok');
  reset role;

  select quantity_on_hand into qty from public.pos_branch_inventory
   where branch_id = branch_a and product_id = prod;
  if qty <> 0 then
    raise exception 'FAIL  5b approving the stock request moved stock to %', qty;
  end if;
  raise notice 'PASS  5b approving the stock request still moves no stock';

  -- Receiving is what actually creates inventory, and it is Administrator-only.
  perform set_config('request.jwt.claims',
    json_build_object('sub', admin_id, 'role', 'authenticated')::text, true);
  set local role authenticated;
  perform public.receive_pos_stock(branch_a, prod, 24, 12.00, 'opening delivery');
  reset role;

  select quantity_on_hand into qty from public.pos_branch_inventory
   where branch_id = branch_a and product_id = prod;
  if qty <> 24 then
    raise exception 'FAIL  5c receiving left % units', qty;
  end if;
  raise notice 'PASS  5c receiving is what actually creates the stock';

  raise notice '--- all new-product proposal checks passed ---';
end $$;

rollback;

select 'requests after rollback: ' || count(*)::text as verify
from public.pos_inventory_requests;
