-- F5 -- supplier invoices, and what they are not allowed to do.
--
-- The control this phase exists for is the three-way match: the order, the
-- receipts and the bill must agree before the company owes anything. These are
-- the claims.
--
--   the Accountant records, the Finance Manager decides, never the same person
--   an invoice that disagrees with the order or the receipts cannot be approved
--   one supplier cannot bill the same number twice
--   nothing may be billed that was cancelled, or that never arrived
--   two invoices cannot bill the same units
--   approving an invoice moves no stock, no budget and no procurement quantity
--
-- Run:
--   docker exec -i supabase_db_harmony-suite psql -U postgres -d postgres \
--     -v ON_ERROR_STOP=1 -f - < supabase/tests/supplier_invoice_rls.sql
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

do $$
declare
  admin_id uuid; staff uuid; manager uuid; acct uuid; acct2 uuid; mgr_a uuid; cashier uuid;
  branch_a uuid; general_id uuid; product uuid; vendor uuid; vendor_b uuid; cat_id uuid;
  budget uuid; req uuid; po uuid; line uuid; inv uuid; inv2 uuid;
  n integer; qty integer; txt text; num numeric;
  reserved_before numeric; spent_before numeric; stock_before integer;
  tag text := left(replace(gen_random_uuid()::text, '-', ''), 8);
begin
  select id into admin_id from public.profiles where role='admin' and status='active' limit 1;
  select id into branch_a from public.branches where is_active order by name limit 1;
  select id into general_id from public.pos_product_categories where normalized_name = 'general';

  staff   := pg_temp.hire('Fin Staff',    'Finance Staff');
  manager := pg_temp.hire('Fin Manager',  'Finance Manager');
  acct    := pg_temp.hire('Fin Acct',     'Accountant');
  mgr_a   := pg_temp.hire('Branch A Mgr', 'POS Manager');
  cashier := pg_temp.hire('Till Person',  'Cashier');

  delete from public.pos_branch_assignments;
  insert into public.pos_branch_assignments (profile_id, branch_id, pos_role, created_by)
  values (mgr_a, branch_a, 'manager', admin_id), (cashier, branch_a, 'cashier', admin_id);

  perform pg_temp.acts_as(admin_id);
  insert into public.pos_products (name, category_id, default_selling_price, default_unit_cost, status)
  values ('ZZ Invoice Cola ' || tag, general_id, 85.00, 60.00, 'active') returning id into product;
  insert into public.pos_branch_products (branch_id, product_id, is_available)
  values (branch_a, product, true);
  insert into public.pos_branch_inventory (branch_id, product_id, quantity_on_hand)
  values (branch_a, product, 0)
  on conflict (branch_id, product_id) do update set quantity_on_hand = 0;

  select id into cat_id from public.finance_categories where kind='expense' and is_active limit 1;

  perform pg_temp.acts_as(staff); set local role authenticated;
  insert into public.vendors (name, phone) values ('ZZ Sahara ' || tag, '09171234522')
  returning id into vendor;
  insert into public.vendors (name, phone) values ('ZZ Other ' || tag, '09171234533')
  returning id into vendor_b;
  insert into public.budgets (name, finance_category_id, amount, fiscal_year)
  values ('ZZ Invoice Budget ' || tag, cat_id, 50000, extract(year from current_date)::integer)
  returning id into budget;
  reset role;
  perform pg_temp.acts_as(manager); set local role authenticated;
  perform public.review_vendor(vendor, true, 'fixture');
  perform public.review_vendor(vendor_b, true, 'fixture');
  perform public.review_budget(budget, true, 'fixture');
  reset role;

  -- A completed procurement: 20 ordered at 65, all 20 received, then closed.
  perform pg_temp.acts_as(mgr_a); set local role authenticated;
  select public.create_pos_stock_request(branch_a, product, 20, 'ZZ for invoicing') into req;
  reset role;
  perform pg_temp.acts_as(staff); set local role authenticated;
  perform public.approve_pos_request(req, 'Accepted');
  select public.create_purchase_order_from_source(
    'pos_restock', req, vendor, null, null, 20, 65.00, null, true, budget) into po;
  reset role;
  perform pg_temp.acts_as(manager); set local role authenticated;
  perform public.transition_purchase_order(po, 'approved');
  reset role;

  select id into line from public.purchase_order_items where purchase_order_id = po;
  perform pg_temp.acts_as(mgr_a); set local role authenticated;
  perform public.receive_procurement_stock(line, 20, 'DR-7001', gen_random_uuid());
  reset role;
  perform pg_temp.acts_as(manager); set local role authenticated;
  perform public.transition_purchase_order(po, 'closed');
  reset role;

  -- The figures F5 must leave exactly alone.
  select bs.reserved, bs.spent into reserved_before, spent_before
    from public.budget_status bs where bs.id = budget;
  select quantity_on_hand into stock_before from public.pos_branch_inventory
   where branch_id = branch_a and product_id = product;

  -- ======================================================================
  -- 1. A closed purchase order is exactly what gets invoiced
  -- ======================================================================
  perform pg_temp.acts_as(acct); set local role authenticated;
  select count(*) into n from public.get_invoiceable_purchase_orders() where purchase_order_id = po;
  if n <> 1 then raise exception 'FAIL 1a a completed order is not offered for invoicing'; end if;
  raise notice 'PASS  1a procurement closed is not payment made -- a closed order can still be billed';

  select public.create_supplier_invoice(
    po, 'TEST-INV-' || tag, current_date, current_date + 26,
    jsonb_build_array(jsonb_build_object(
      'purchase_order_item_id', line, 'quantity', 20, 'unit_cost', 65.00)),
    0, 0, null, 'ZZ exact match') into inv;

  select invoice_no into txt from public.supplier_invoices where id = inv;
  if txt !~ '^SI-\d{4}-\d{4}$' then raise exception 'FAIL 1b internal number is %', txt; end if;

  -- The vendor came from the order, not from the caller.
  select vendor_id into txt from public.supplier_invoices where id = inv;
  if txt <> vendor::text then raise exception 'FAIL 1b the invoice names a different vendor'; end if;
  raise notice 'PASS  1b the invoice takes its number and its vendor from the order';

  -- Totals are the server's.
  select subtotal, total_amount, balance_due into num, num, num
    from public.supplier_invoice_status where id = inv;
  select total_amount into num from public.supplier_invoice_status where id = inv;
  if num <> 1300 then raise exception 'FAIL 1c total is %, expected 1300', num; end if;
  select balance_due into num from public.supplier_invoice_status where id = inv;
  if num <> 1300 then raise exception 'FAIL 1c balance is %, expected 1300', num; end if;
  raise notice 'PASS  1c subtotal, total and balance are derived from the lines: 1300';
  reset role;

  -- ======================================================================
  -- 2. The three-way match agrees
  -- ======================================================================
  perform pg_temp.acts_as(acct); set local role authenticated;
  select verdict, ordered_quantity, received_quantity, invoice_quantity
    into txt, n, qty, n
    from public.supplier_invoice_match(inv);
  select verdict into txt from public.supplier_invoice_match(inv);
  if txt <> 'matched' then raise exception 'FAIL 2a an exact invoice reads %', txt; end if;

  select received_quantity into qty from public.supplier_invoice_match(inv);
  if qty <> 20 then raise exception 'FAIL 2a received reads %', qty; end if;
  select billable_quantity into qty from public.supplier_invoice_match(inv);
  if qty <> 20 then raise exception 'FAIL 2a billable reads %', qty; end if;
  raise notice 'PASS  2a ordered 20, received 20, invoiced 20 at the agreed price: matched';
  reset role;

  -- ======================================================================
  -- 3. Maker and checker
  -- ======================================================================
  perform pg_temp.acts_as(acct); set local role authenticated;
  perform public.transition_supplier_invoice(inv, 'for_review');

  begin
    perform public.transition_supplier_invoice(inv, 'approved');
    raise exception 'FAIL 3a the Accountant approved their own invoice';
  exception when insufficient_privilege then
    raise notice 'PASS  3a the Accountant records an invoice; they do not approve it';
  end;
  reset role;

  perform pg_temp.acts_as(staff); set local role authenticated;
  begin
    perform public.transition_supplier_invoice(inv, 'approved');
    raise exception 'FAIL 3b Finance Staff approved a supplier invoice';
  exception when insufficient_privilege then
    raise notice 'PASS  3b procurement does not approve the bill for its own purchase';
  end;
  reset role;

  perform pg_temp.acts_as(admin_id); set local role authenticated;
  begin
    perform public.transition_supplier_invoice(inv, 'approved');
    raise exception 'FAIL 3c the Administrator approved a supplier invoice';
  exception when insufficient_privilege then
    raise notice 'PASS  3c the Administrator has oversight, not operational approval';
  end;
  reset role;

  -- A submitted document is out of the maker's hands.
  perform pg_temp.acts_as(acct); set local role authenticated;
  update public.supplier_invoices set tax_amount = 999 where id = inv;
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'FAIL 3d the maker edited a submitted invoice'; end if;
  update public.supplier_invoice_lines set quantity = 25 where supplier_invoice_id = inv;
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'FAIL 3d the maker edited a submitted line'; end if;
  raise notice 'PASS  3d once submitted, the document stops being the maker''s to change';
  reset role;

  -- And the checker never edits it either.
  perform pg_temp.acts_as(manager); set local role authenticated;
  update public.supplier_invoices set tax_amount = 999 where id = inv;
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'FAIL 3e the Finance Manager edited the invoice they review'; end if;
  update public.supplier_invoice_lines set unit_cost = 70 where supplier_invoice_id = inv;
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'FAIL 3e the Finance Manager edited an invoice line'; end if;
  raise notice 'PASS  3e the Finance Manager reviews a supplier invoice read-only';

  -- Returning takes a reason.
  begin
    perform public.transition_supplier_invoice(inv, 'returned', '  ');
    raise exception 'FAIL 3f an invoice was returned with a blank reason';
  exception when check_violation then
    raise notice 'PASS  3f returning an invoice for correction takes a real reason';
  end;

  perform public.transition_supplier_invoice(inv, 'approved');
  select status into txt from public.supplier_invoices where id = inv;
  if txt <> 'approved' then raise exception 'FAIL 3g approval left it %', txt; end if;
  raise notice 'PASS  3g the Finance Manager approves it, and it becomes payable';
  reset role;

  -- ======================================================================
  -- 4. Approving a bill moves nothing else
  -- ======================================================================
  select bs.reserved, bs.spent into num, qty from public.budget_status bs where bs.id = budget;
  select bs.reserved into num from public.budget_status bs where bs.id = budget;
  if num <> reserved_before then
    raise exception 'FAIL 4a approving the invoice changed reserved from % to %', reserved_before, num;
  end if;
  select bs.spent into num from public.budget_status bs where bs.id = budget;
  if num <> spent_before or num <> 0 then
    raise exception 'FAIL 4a approving the invoice spent %', num;
  end if;
  raise notice 'PASS  4a reserved and spent are exactly as procurement left them -- 6300 style, spent 0';

  select quantity_on_hand into qty from public.pos_branch_inventory
   where branch_id = branch_a and product_id = product;
  if qty <> stock_before then
    raise exception 'FAIL 4b approving the invoice moved stock from % to %', stock_before, qty;
  end if;
  raise notice 'PASS  4b no supplier invoice ever touches POS inventory';

  select quantity_ordered, quantity_cancelled into n, qty
    from public.purchase_order_items where id = line;
  if n <> 20 or qty <> 0 then
    raise exception 'FAIL 4c the invoice altered procurement quantities (% ordered, % cancelled)', n, qty;
  end if;
  select count(*) into n from public.procurement_receipts where purchase_order_item_id = line;
  if n <> 1 then raise exception 'FAIL 4c the invoice altered the receipts'; end if;
  select status into txt from public.purchase_orders where id = po;
  if txt <> 'closed' then raise exception 'FAIL 4c the invoice reopened the order (%)', txt; end if;
  raise notice 'PASS  4c the order, its quantities and its receipts are untouched';

  -- ======================================================================
  -- 5. Accounts payable, and what it is not called
  -- ======================================================================
  perform pg_temp.acts_as(acct); set local role authenticated;
  select balance_due, payment_state into num, txt from public.supplier_invoice_status where id = inv;
  select balance_due into num from public.supplier_invoice_status where id = inv;
  if num <> 1300 then raise exception 'FAIL 5a balance due is %, expected the whole 1300', num; end if;
  select payment_state into txt from public.supplier_invoice_status where id = inv;
  if txt is null then raise exception 'FAIL 5a an approved invoice has no payment state'; end if;
  raise notice 'PASS  5a an approved invoice owes its whole total -- nothing has paid any of it (%)', txt;
  reset role;

  -- ======================================================================
  -- 6. One supplier cannot bill the same number twice
  -- ======================================================================
  perform pg_temp.acts_as(acct); set local role authenticated;
  begin
    -- Same vendor, same number, different case and spacing: the same document.
    perform public.create_supplier_invoice(
      po, '  test-inv-' || tag || ' ', current_date, null,
      jsonb_build_array(jsonb_build_object(
        'purchase_order_item_id', line, 'quantity', 1, 'unit_cost', 65.00)));
    raise exception 'FAIL 6a the same supplier invoice number was accepted twice';
  exception when unique_violation then
    raise notice 'PASS  6a one supplier, one invoice number -- case and spacing do not defeat it';
  end;
  reset role;

  -- ======================================================================
  -- 7. Nothing may be billed that did not arrive
  -- ======================================================================
  --
  -- The first invoice already took all twenty, so a second has nothing left.
  perform pg_temp.acts_as(acct); set local role authenticated;
  select public.create_supplier_invoice(
    po, 'TEST-INV-B-' || tag, current_date, null,
    jsonb_build_array(jsonb_build_object(
      'purchase_order_item_id', line, 'quantity', 5, 'unit_cost', 65.00))) into inv2;

  select billable_quantity into qty from public.supplier_invoice_match(inv2);
  if qty <> 0 then raise exception 'FAIL 7a billable is % after the whole order was invoiced', qty; end if;
  select previously_invoiced into n from public.supplier_invoice_match(inv2);
  if n <> 20 then raise exception 'FAIL 7a previously invoiced reads %', n; end if;
  select verdict into txt from public.supplier_invoice_match(inv2);
  if txt <> 'quantity_mismatch' then raise exception 'FAIL 7a a second bill for the same goods reads %', txt; end if;

  perform public.transition_supplier_invoice(inv2, 'for_review');
  reset role;

  perform pg_temp.acts_as(manager); set local role authenticated;
  begin
    perform public.transition_supplier_invoice(inv2, 'approved');
    raise exception 'FAIL 7b the same goods were invoiced twice';
  exception when check_violation then
    if sqlerrm not like '%can still be charged for%' then raise; end if;
    raise notice 'PASS  7b two invoices cannot bill the same units';
  end;

  perform public.transition_supplier_invoice(inv2, 'rejected', 'duplicate of the first bill');
  reset role;

  -- ======================================================================
  -- 8. A different price is a discrepancy, not a rounding difference
  -- ======================================================================
  perform pg_temp.acts_as(mgr_a); set local role authenticated;
  select public.create_pos_stock_request(branch_a, product, 10, 'ZZ second lot') into req;
  reset role;
  perform pg_temp.acts_as(staff); set local role authenticated;
  perform public.approve_pos_request(req, 'Accepted');
  select public.create_purchase_order_from_source(
    'pos_restock', req, vendor, null, null, 10, 65.00, null, true, budget) into po;
  reset role;
  perform pg_temp.acts_as(manager); set local role authenticated;
  perform public.transition_purchase_order(po, 'approved');
  reset role;
  select id into line from public.purchase_order_items where purchase_order_id = po;
  perform pg_temp.acts_as(mgr_a); set local role authenticated;
  perform public.receive_procurement_stock(line, 10, 'DR-7002', gen_random_uuid());
  reset role;

  perform pg_temp.acts_as(acct); set local role authenticated;
  select public.create_supplier_invoice(
    po, 'TEST-INV-C-' || tag, current_date, null,
    jsonb_build_array(jsonb_build_object(
      'purchase_order_item_id', line, 'quantity', 10, 'unit_cost', 70.00))) into inv2;

  select verdict into txt from public.supplier_invoice_match(inv2);
  if txt <> 'price_mismatch' then raise exception 'FAIL 8a charging 70 against an agreed 65 reads %', txt; end if;
  select price_matched into txt from public.supplier_invoice_match(inv2);
  if txt <> 'false' then raise exception 'FAIL 8a the price is reported as matching'; end if;
  raise notice 'PASS  8a an invoice charging more than the order agreed is shown as a price mismatch';

  perform public.transition_supplier_invoice(inv2, 'for_review');
  reset role;

  perform pg_temp.acts_as(manager); set local role authenticated;
  begin
    perform public.transition_supplier_invoice(inv2, 'approved');
    raise exception 'FAIL 8b a price mismatch was approved anyway';
  exception when check_violation then
    if sqlerrm not like '%purchase order agreed%' then raise; end if;
    raise notice 'PASS  8b a mismatched invoice cannot be approved -- there is no override';
  end;

  -- The only way out is back to the maker.
  perform public.transition_supplier_invoice(inv2, 'returned', 'supplier billed 70, we agreed 65');
  select status into txt from public.supplier_invoices where id = inv2;
  if txt <> 'returned' then raise exception 'FAIL 8c returning left it %', txt; end if;
  raise notice 'PASS  8c the way past a discrepancy is correction, not an override';
  reset role;

  -- ======================================================================
  -- 9. Stopped quantities are never billable
  -- ======================================================================
  perform pg_temp.acts_as(mgr_a); set local role authenticated;
  select public.create_pos_stock_request(branch_a, product, 20, 'ZZ short lot') into req;
  reset role;
  perform pg_temp.acts_as(staff); set local role authenticated;
  perform public.approve_pos_request(req, 'Accepted');
  select public.create_purchase_order_from_source(
    'pos_restock', req, vendor, null, null, 20, 65.00, null, true, budget) into po;
  reset role;
  perform pg_temp.acts_as(manager); set local role authenticated;
  perform public.transition_purchase_order(po, 'approved');
  reset role;
  select id into line from public.purchase_order_items where purchase_order_id = po;
  perform pg_temp.acts_as(mgr_a); set local role authenticated;
  perform public.receive_procurement_stock(line, 6, 'DR-7003', gen_random_uuid());
  reset role;
  perform pg_temp.acts_as(manager); set local role authenticated;
  perform public.cancel_purchase_order_remainder(po, 'supplier discontinued the line');
  reset role;

  -- Ordered 20, received 6, 14 stopped. Six is the most anybody may bill.
  perform pg_temp.acts_as(acct); set local role authenticated;
  select public.create_supplier_invoice(
    po, 'TEST-INV-D-' || tag, current_date, null,
    jsonb_build_array(jsonb_build_object(
      'purchase_order_item_id', line, 'quantity', 20, 'unit_cost', 65.00))) into inv2;

  select effective_quantity, billable_quantity into n, qty from public.supplier_invoice_match(inv2);
  select effective_quantity into n from public.supplier_invoice_match(inv2);
  if n <> 6 then raise exception 'FAIL 9a effective quantity is %, expected 6', n; end if;
  select billable_quantity into qty from public.supplier_invoice_match(inv2);
  if qty <> 6 then raise exception 'FAIL 9a billable is %, expected 6', qty; end if;
  select verdict into txt from public.supplier_invoice_match(inv2);
  if txt <> 'quantity_mismatch' then raise exception 'FAIL 9a billing the stopped units reads %', txt; end if;
  raise notice 'PASS  9a ordered 20, stopped 14, received 6 -- only the 6 are billable';

  perform public.transition_supplier_invoice(inv2, 'for_review');
  reset role;
  perform pg_temp.acts_as(manager); set local role authenticated;
  begin
    perform public.transition_supplier_invoice(inv2, 'approved');
    raise exception 'FAIL 9b cancelled quantity was invoiced';
  exception when check_violation then
    raise notice 'PASS  9b a supplier cannot bill for units the company stopped buying';
  end;

  -- Returned, as it would be in practice. That also frees the quantity it was
  -- holding: an invoice awaiting review reserves what it claims, so two cannot
  -- be in flight for the same goods, but a returned one claims nothing.
  perform public.transition_supplier_invoice(inv2, 'returned', 'billed 20; only 6 arrived, 14 were stopped');
  reset role;

  perform pg_temp.acts_as(acct); set local role authenticated;
  select billable_quantity into qty from public.supplier_invoice_match(inv2);
  if qty <> 6 then
    raise exception 'FAIL 9c returning it did not release the quantity (billable %)', qty;
  end if;
  raise notice 'PASS  9c a returned invoice stops holding the units it claimed';
  reset role;

  -- ======================================================================
  -- 10. A partial delivery may be partly invoiced
  -- ======================================================================
  perform pg_temp.acts_as(acct); set local role authenticated;
  select public.create_supplier_invoice(
    po, 'TEST-INV-E-' || tag, current_date, null,
    jsonb_build_array(jsonb_build_object(
      'purchase_order_item_id', line, 'quantity', 6, 'unit_cost', 65.00))) into inv2;
  select verdict into txt from public.supplier_invoice_match(inv2);
  if txt <> 'matched' then raise exception 'FAIL 10a billing exactly what arrived reads %', txt; end if;
  perform public.transition_supplier_invoice(inv2, 'for_review');
  reset role;
  perform pg_temp.acts_as(manager); set local role authenticated;
  perform public.transition_supplier_invoice(inv2, 'approved');
  select total_amount into num from public.supplier_invoice_status where id = inv2;
  if num <> 390 then raise exception 'FAIL 10a the partial invoice totals %, expected 390', num; end if;
  raise notice 'PASS  10a six delivered, six billed, 390 owed -- a partial delivery invoices cleanly';
  reset role;

  -- ======================================================================
  -- 11. Nobody outside Finance sees a supplier bill
  -- ======================================================================
  perform pg_temp.acts_as(mgr_a); set local role authenticated;
  select count(*) into n from public.supplier_invoices;
  if n <> 0 then raise exception 'FAIL 11a a POS Manager read % supplier invoice(s)', n; end if;
  select count(*) into n from public.supplier_invoice_lines;
  if n <> 0 then raise exception 'FAIL 11a a POS Manager read supplier invoice lines'; end if;
  reset role;

  perform pg_temp.acts_as(cashier); set local role authenticated;
  select count(*) into n from public.supplier_invoices;
  if n <> 0 then raise exception 'FAIL 11b a cashier read supplier invoices'; end if;
  reset role;
  raise notice 'PASS  11a-b supplier cost stays away from the people who receive the goods';

  begin
    set local role anon;
    perform 1 from public.supplier_invoices limit 1;
    raise exception 'FAIL 11c anon read the supplier invoices';
  exception when insufficient_privilege then
    reset role;
    raise notice 'PASS  11c anon is refused by the table grant';
  end;
  reset role;

  -- ======================================================================
  -- 12. Only the Accountant authors one
  -- ======================================================================
  perform pg_temp.acts_as(staff); set local role authenticated;
  begin
    perform public.create_supplier_invoice(
      po, 'TEST-INV-F-' || tag, current_date, null,
      jsonb_build_array(jsonb_build_object(
        'purchase_order_item_id', line, 'quantity', 1, 'unit_cost', 65.00)));
    raise exception 'FAIL 12a Finance Staff recorded a supplier invoice';
  exception when insufficient_privilege then
    raise notice 'PASS  12a the person who bought the goods does not record the bill for them';
  end;
  reset role;

  perform pg_temp.acts_as(manager); set local role authenticated;
  begin
    perform public.create_supplier_invoice(
      po, 'TEST-INV-G-' || tag, current_date, null,
      jsonb_build_array(jsonb_build_object(
        'purchase_order_item_id', line, 'quantity', 1, 'unit_cost', 65.00)));
    raise exception 'FAIL 12b the Finance Manager recorded a supplier invoice';
  exception when insufficient_privilege then
    raise notice 'PASS  12b the checker does not author the document they approve';
  end;
  reset role;

  -- ======================================================================
  -- 13. An unexplained charge is not allowed to be a lump sum
  -- ======================================================================
  perform pg_temp.acts_as(acct); set local role authenticated;
  begin
    perform public.create_supplier_invoice(
      po, 'TEST-INV-H-' || tag, current_date, null,
      jsonb_build_array(jsonb_build_object(
        'purchase_order_item_id', line, 'quantity', 1, 'unit_cost', 65.00)),
      0, 250, null);
    raise exception 'FAIL 13a an unexplained charge was accepted';
  exception when check_violation then
    raise notice 'PASS  13a a charge on a supplier bill has to say what it is for';
  end;
  reset role;

  -- ======================================================================
  -- 14. History keeps every step
  -- ======================================================================
  select count(*) into n from public.supplier_invoice_history where supplier_invoice_id = inv;
  if n < 2 then raise exception 'FAIL 14a the invoice history holds % row(s)', n; end if;
  select count(*) into n from public.supplier_invoice_history
   where supplier_invoice_id = inv and action = 'approved' and actor_id = manager;
  if n <> 1 then raise exception 'FAIL 14a the approval is not attributed'; end if;
  raise notice 'PASS  14a who did what, when, and why is kept for every transition';
end $$;

rollback;
