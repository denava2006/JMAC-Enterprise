-- Voiding is not a reversal, and a returned payment is not a second chance.
--
-- Two defects from hosted acceptance, both mine:
--
--   an approved invoice could be voided while 1,300 had been paid against it,
--     leaving a payment and a treasury movement answering a bill the company
--     said was never real
--   a returned payment still offered Submit against an invoice with nothing
--     left to pay, because the over-instruction guard was only at creation
--
-- Plus the corrective repair for the row acceptance already created, and the
-- awaiting-invoice count that a voided invoice quietly inflated.
--
-- Run:
--   docker exec -i supabase_db_harmony-suite psql -U postgres -d postgres \
--     -v ON_ERROR_STOP=1 -f - < supabase/tests/invoice_void_integrity_rls.sql
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

-- A delivered order with an approved invoice on it, returned as both ids.
create or replace function pg_temp.deliver_and_bill(
  _staff uuid, _mgr uuid, _pos_mgr uuid, _accountant uuid,
  _branch uuid, _product uuid, _vendor uuid, _budget uuid,
  _qty integer, _cost numeric, _tag text, _bill boolean)
returns uuid[]
language plpgsql as $$
declare _req uuid; _po uuid; _line uuid; _inv uuid;
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub', _pos_mgr, 'role', 'authenticated')::text, true);
  set local role authenticated;
  select public.create_pos_stock_request(_branch, _product, _qty, 'ZZ ' || _tag) into _req;
  reset role;

  perform set_config('request.jwt.claims',
    json_build_object('sub', _staff, 'role', 'authenticated')::text, true);
  set local role authenticated;
  perform public.approve_pos_request(_req, 'Accepted');
  select public.create_purchase_order_from_source(
    'pos_restock', _req, _vendor, null, null, _qty, _cost, null, true, _budget) into _po;
  reset role;

  perform set_config('request.jwt.claims',
    json_build_object('sub', _mgr, 'role', 'authenticated')::text, true);
  set local role authenticated;
  perform public.transition_purchase_order(_po, 'approved');
  reset role;

  select id into _line from public.purchase_order_items where purchase_order_id = _po;
  perform set_config('request.jwt.claims',
    json_build_object('sub', _pos_mgr, 'role', 'authenticated')::text, true);
  set local role authenticated;
  perform public.receive_procurement_stock(_line, _qty, 'ZZ-DR-' || _tag, gen_random_uuid());
  reset role;

  if not _bill then
    return array[_po, null::uuid];
  end if;

  perform set_config('request.jwt.claims',
    json_build_object('sub', _accountant, 'role', 'authenticated')::text, true);
  set local role authenticated;
  select public.create_supplier_invoice(
    _po, 'SI-' || _tag, current_date, current_date + 30,
    jsonb_build_array(jsonb_build_object(
      'purchase_order_item_id', _line, 'quantity', _qty, 'unit_price', _cost)),
    0, 0, null, 'ZZ ' || _tag) into _inv;
  perform public.transition_supplier_invoice(_inv, 'for_review');
  reset role;

  perform set_config('request.jwt.claims',
    json_build_object('sub', _mgr, 'role', 'authenticated')::text, true);
  set local role authenticated;
  perform public.transition_supplier_invoice(_inv, 'approved');
  reset role;

  return array[_po, _inv];
end;
$$;

do $$
declare
  admin_id uuid; accountant uuid; fin_mgr uuid; fin_staff uuid; pos_mgr uuid;
  branch_a uuid; general_id uuid; product uuid; cat_id uuid; vendor uuid;
  budget uuid; bank uuid;
  po_a uuid; po_b uuid; po_c uuid; po_d uuid; po_b_line uuid;
  inv_a uuid; inv_b uuid; inv_c uuid; r uuid[];
  pay uuid; pay2 uuid; pay3 uuid;
  n integer; txt text; amt numeric;
  b_reserved numeric; b_spent numeric; bal numeric;
  tag text := left(replace(gen_random_uuid()::text, '-', ''), 8);
begin
  select id into admin_id from public.profiles where role='admin' and status='active' limit 1;
  select id into branch_a from public.branches where is_active order by name limit 1;
  select id into general_id from public.pos_product_categories where normalized_name='general';

  accountant := pg_temp.hire('Bookkeeper',  'Accountant');
  fin_mgr    := pg_temp.hire('Fin Manager', 'Finance Manager');
  fin_staff  := pg_temp.hire('Fin Staff',   'Finance Staff');
  pos_mgr    := pg_temp.hire('Store Mgr',   'POS Manager');

  delete from public.pos_branch_assignments;
  insert into public.pos_branch_assignments (profile_id, branch_id, pos_role, created_by)
  values (pos_mgr, branch_a, 'manager', admin_id);

  perform pg_temp.acts_as(admin_id);
  insert into public.pos_products (name, category_id, default_selling_price, default_unit_cost, status)
  values ('ZZ Void Cola ' || tag, general_id, 100.00, 65.00, 'active') returning id into product;
  insert into public.pos_branch_products (branch_id, product_id, is_available)
  values (branch_a, product, true);
  perform set_config('harmony.pos_inventory_write', 'allowed', true);
  insert into public.pos_branch_inventory (branch_id, product_id, quantity_on_hand)
  values (branch_a, product, 0)
  on conflict (branch_id, product_id) do update set quantity_on_hand = 0;
  perform set_config('harmony.pos_inventory_write', '', true);

  select id into cat_id from public.finance_categories where kind='expense' and is_active limit 1;
  perform pg_temp.acts_as(fin_staff); set local role authenticated;
  insert into public.vendors (name, phone) values ('ZZ Void Vendor ' || tag, '09171234571')
  returning id into vendor;
  insert into public.budgets (name, finance_category_id, amount, fiscal_year)
  values ('ZZ Void Budget ' || tag, cat_id, 50000, extract(year from current_date)::integer)
  returning id into budget;
  reset role;
  perform pg_temp.acts_as(fin_mgr); set local role authenticated;
  perform public.review_vendor(vendor, true, 'fixture');
  perform public.review_budget(budget, true, 'fixture');
  reset role;

  perform pg_temp.acts_as(accountant); set local role authenticated;
  insert into public.treasury_accounts (name, account_type, opening_balance, opening_balance_as_of)
  values ('ZZ Bank ' || tag, 'bank', 50000, current_date) returning id into bank;
  reset role;

  -- Three delivered orders: A billed and payable, B never billed, C billed
  -- then voided before anybody paid.
  r := pg_temp.deliver_and_bill(fin_staff, fin_mgr, pos_mgr, accountant,
        branch_a, product, vendor, budget, 20, 65.00, 'a' || tag, true);
  po_a := r[1]; inv_a := r[2];
  r := pg_temp.deliver_and_bill(fin_staff, fin_mgr, pos_mgr, accountant,
        branch_a, product, vendor, budget, 10, 65.00, 'b' || tag, false);
  po_b := r[1];
  r := pg_temp.deliver_and_bill(fin_staff, fin_mgr, pos_mgr, accountant,
        branch_a, product, vendor, budget, 5, 65.00, 'c' || tag, true);
  po_c := r[1]; inv_c := r[2];
  reset role;

  -- ======================================================================
  -- 1. Voiding, while nothing has been paid or promised
  -- ======================================================================
  perform pg_temp.acts_as(fin_mgr); set local role authenticated;
  perform public.transition_supplier_invoice(inv_c, 'voided', 'ZZ not a real bill');
  reset role;
  select status into txt from public.supplier_invoices where id = inv_c;
  if txt <> 'voided' then raise exception 'FAIL 1a an unpaid invoice could not be voided'; end if;
  raise notice 'PASS  1a an invoice with nothing paid or promised can still be voided';

  -- ======================================================================
  -- 2. A pending instruction blocks it
  -- ======================================================================
  perform pg_temp.acts_as(accountant); set local role authenticated;
  select public.create_supplier_payment(inv_a, bank, 500, 'bank_transfer', 'ZZ part', true)
    into pay;
  reset role;

  perform pg_temp.acts_as(fin_mgr); set local role authenticated;
  begin
    perform public.transition_supplier_invoice(inv_a, 'voided', 'ZZ trying it on');
    raise exception 'FAIL 2a an invoice with a live instruction was voided';
  exception when check_violation then
    if sqlerrm <> 'Resolve the pending payment instructions before voiding this invoice.' then
      raise exception 'FAIL 2a wrong message: %', sqlerrm;
    end if;
    raise notice 'PASS  2a a live payment instruction blocks the void';
  end;
  reset role;

  -- ======================================================================
  -- 3. Money that has moved blocks it, partly or wholly
  -- ======================================================================
  perform pg_temp.acts_as(fin_mgr); set local role authenticated;
  perform public.transition_supplier_payment(pay, 'approved', null, null, null);
  reset role;
  perform pg_temp.acts_as(accountant); set local role authenticated;
  perform public.transition_supplier_payment(pay, 'paid', null, 'TRF-A-' || tag, current_date);
  reset role;

  select v.amount_paid, v.balance_due into amt, bal
    from public.supplier_invoice_status v where v.id = inv_a;
  if amt <> 500 or bal <> 800 then
    raise exception 'FAIL 3a paid % balance %, expected 500/800', amt, bal;
  end if;

  perform pg_temp.acts_as(fin_mgr); set local role authenticated;
  begin
    perform public.transition_supplier_invoice(inv_a, 'voided', 'ZZ trying it on');
    raise exception 'FAIL 3a a partly paid invoice was voided';
  exception when check_violation then
    if sqlerrm <>
      'This invoice already has recorded payments and cannot be voided. A reversal process is required.'
    then raise exception 'FAIL 3a wrong message: %', sqlerrm; end if;
    raise notice 'PASS  3a a partly paid invoice cannot be voided';
  end;
  reset role;

  -- Pay the rest, and it is still refused -- more firmly, not less.
  perform pg_temp.acts_as(accountant); set local role authenticated;
  select public.create_supplier_payment(inv_a, bank, 800, 'bank_transfer', 'ZZ rest', true)
    into pay2;
  reset role;
  perform pg_temp.acts_as(fin_mgr); set local role authenticated;
  perform public.transition_supplier_payment(pay2, 'approved', null, null, null);
  reset role;
  perform pg_temp.acts_as(accountant); set local role authenticated;
  perform public.transition_supplier_payment(pay2, 'paid', null, 'TRF-B-' || tag, current_date);
  reset role;

  perform pg_temp.acts_as(fin_mgr); set local role authenticated;
  begin
    perform public.transition_supplier_invoice(inv_a, 'voided', 'ZZ trying it on');
    raise exception 'FAIL 3b a fully paid invoice was voided';
  exception when check_violation then
    raise notice 'PASS  3b nor a fully paid one';
  end;
  reset role;

  -- The guard sits on the row, so writing around the workflow changes nothing.
  begin
    update public.supplier_invoices set status = 'voided' where id = inv_a;
    raise exception 'FAIL 3c a direct update voided a paid invoice';
  exception when check_violation then
    raise notice 'PASS  3c and a direct update is refused the same way';
  end;

  -- ======================================================================
  -- 4. A returned payment cannot be resubmitted into a full payable
  -- ======================================================================
  --
  -- Its own delivered order, so section 6 still has an unbilled one to count.
  r := pg_temp.deliver_and_bill(fin_staff, fin_mgr, pos_mgr, accountant,
        branch_a, product, vendor, budget, 10, 65.00, 'd' || tag, false);
  po_d := r[1];
  reset role;

  select id into po_b_line from public.purchase_order_items where purchase_order_id = po_d;
  perform pg_temp.acts_as(accountant); set local role authenticated;
  select public.create_supplier_invoice(
    po_d, 'SI-D-' || tag, current_date, current_date + 30,
    jsonb_build_array(jsonb_build_object(
      'purchase_order_item_id', po_b_line, 'quantity', 10, 'unit_price', 65.00)),
    0, 0, null, 'ZZ resubmission') into inv_b;
  perform public.transition_supplier_invoice(inv_b, 'for_review');
  reset role;
  perform pg_temp.acts_as(fin_mgr); set local role authenticated;
  perform public.transition_supplier_invoice(inv_b, 'approved');
  reset role;

  -- Returned, with nothing else claiming the invoice. It must be resubmittable
  -- -- and it only is because the sum excludes the payment being submitted.
  -- Counting it against itself would refuse every resubmission there is.
  perform pg_temp.acts_as(accountant); set local role authenticated;
  select public.create_supplier_payment(inv_b, bank, 650, 'bank_transfer', 'ZZ whole', true)
    into pay;
  reset role;
  perform pg_temp.acts_as(fin_mgr); set local role authenticated;
  perform public.transition_supplier_payment(pay, 'returned', 'ZZ sent back');
  reset role;

  perform pg_temp.acts_as(accountant); set local role authenticated;
  if not public.payment_can_be_submitted(pay) then
    raise exception 'FAIL 4a a returned payment is not resubmittable with the balance free';
  end if;
  perform public.transition_supplier_payment(pay, 'for_approval', null, null, null);
  reset role;
  raise notice 'PASS  4a a returned payment excludes itself, so it can be resubmitted';

  -- Now a sibling takes most of the balance. 650 - 400 = 250 available, and
  -- the returned 650 no longer fits.
  perform pg_temp.acts_as(fin_mgr); set local role authenticated;
  perform public.transition_supplier_payment(pay, 'returned', 'ZZ sent back again');
  reset role;
  perform pg_temp.acts_as(accountant); set local role authenticated;
  select public.create_supplier_payment(inv_b, bank, 400, 'bank_transfer', 'ZZ sibling', true)
    into pay2;

  if public.payment_can_be_submitted(pay) then
    raise exception 'FAIL 4b a 650 payment looked submittable against 250 available';
  end if;
  begin
    perform public.transition_supplier_payment(pay, 'for_approval', null, null, null);
    raise exception 'FAIL 4b a returned payment was resubmitted over the available balance';
  exception when check_violation then
    if sqlerrm not like '%only has 250.00 available%' then
      raise exception 'FAIL 4b wrong message: %', sqlerrm;
    end if;
    raise notice 'PASS  4b a returned payment larger than what is left is refused';
  end;
  reset role;

  -- Trim it to what fits, and it goes through.
  reset role;
  update public.supplier_payments set amount = 250 where id = pay;
  perform pg_temp.acts_as(accountant); set local role authenticated;
  if not public.payment_can_be_submitted(pay) then
    raise exception 'FAIL 4c 250 is not submittable against 250 available';
  end if;
  perform public.transition_supplier_payment(pay, 'for_approval', null, null, null);
  reset role;
  raise notice 'PASS  4c trimmed to what remains, the same payment submits cleanly';

  -- Fully paid, and a returned voucher can never come back.
  perform pg_temp.acts_as(fin_mgr); set local role authenticated;
  perform public.transition_supplier_payment(pay, 'returned', 'ZZ park it');
  perform public.transition_supplier_payment(pay2, 'approved', null, null, null);
  reset role;
  perform pg_temp.acts_as(accountant); set local role authenticated;
  perform public.transition_supplier_payment(pay2, 'paid', null, 'TRF-C-' || tag, current_date);
  select public.create_supplier_payment(inv_b, bank, 250, 'bank_transfer', 'ZZ rest', true)
    into pay3;
  reset role;
  perform pg_temp.acts_as(fin_mgr); set local role authenticated;
  perform public.transition_supplier_payment(pay3, 'approved', null, null, null);
  reset role;
  perform pg_temp.acts_as(accountant); set local role authenticated;
  perform public.transition_supplier_payment(pay3, 'paid', null, 'TRF-D-' || tag, current_date);

  select v.balance_due into bal from public.supplier_invoice_status v where v.id = inv_b;
  if bal <> 0 then raise exception 'FAIL 4d balance is %, expected 0', bal; end if;

  if public.payment_can_be_submitted(pay) then
    raise exception 'FAIL 4d a returned payment looked submittable against a settled invoice';
  end if;
  begin
    perform public.transition_supplier_payment(pay, 'for_approval', null, null, null);
    raise exception 'FAIL 4d a returned payment was resubmitted against a settled invoice';
  exception when check_violation then
    if sqlerrm <> 'This invoice no longer has a balance available for this payment.' then
      raise exception 'FAIL 4d wrong message: %', sqlerrm;
    end if;
    raise notice 'PASS  4d a returned payment cannot come back once nothing is payable';
  end;
  reset role;

  -- And it stays in history rather than being tidied away.
  select count(*)::integer into n from public.supplier_payments where id = pay;
  if n <> 1 then raise exception 'FAIL 4e the returned payment was removed'; end if;
  raise notice 'PASS  4e the returned payment remains on the record';

  -- ======================================================================
  -- 5. The corrective repair, and the invariant it restores
  -- ======================================================================
  --
  -- Recreate the impossible state the only way it can still be made: writing
  -- it directly, with the guard disabled for one statement. Then prove the
  -- repair puts it right and touches nothing financial.
  -- The workflow writes a history row when it voids, so the fixture does too.
  -- Production reached this state through the workflow, back when the void was
  -- still permitted; staging it without that record would let the migration
  -- delete history and still pass.
  alter table public.supplier_invoices disable trigger trg_invoice_void_guard;
  insert into public.supplier_invoice_history
    (supplier_invoice_id, actor_id, role_at_action, action, from_status, to_status, remarks)
  values (inv_a, fin_mgr, 'finance_manager', 'voided', 'approved', 'voided', 'duplicate request');
  update public.supplier_invoices set status = 'voided' where id = inv_a;
  alter table public.supplier_invoices enable trigger trg_invoice_void_guard;

  select count(*)::integer into n
  from public.supplier_invoice_status v where v.status = 'voided' and v.amount_paid > 0;
  if n <> 1 then raise exception 'FAIL 5a fixture: % impossible invoices, expected 1', n; end if;
  raise notice 'PASS  5a the impossible state is reproducible, and detectable by its invariant';

  select t.balance into bal from public.treasury_account_status t where t.id = bank;

  -- The repair, as the migration performs it.
  insert into public.supplier_invoice_history
    (supplier_invoice_id, actor_id, role_at_action, action, from_status, to_status, remarks)
  select v.id, null, 'system', 'system_correction', 'voided', 'approved',
         'Invalid void-after-payment state restored to approved.'
  from public.supplier_invoice_status v where v.status = 'voided' and v.amount_paid > 0;

  update public.supplier_invoices si set status = 'approved'
  where si.id in (select v.id from public.supplier_invoice_status v
                   where v.status = 'voided' and v.amount_paid > 0);

  select count(*)::integer into n
  from public.supplier_invoice_status v where v.status = 'voided' and v.amount_paid > 0;
  if n <> 0 then raise exception 'FAIL 5b % invoices still voided while paid', n; end if;
  raise notice 'PASS  5b the repair leaves nothing matching the impossible condition';

  select v.status, v.amount_paid, v.balance_due, v.settlement_state
    into txt, amt, bal, txt from public.supplier_invoice_status v where v.id = inv_a;
  select v.amount_paid, v.balance_due into amt, bal
    from public.supplier_invoice_status v where v.id = inv_a;
  if amt <> 1300 or bal <> 0 then
    raise exception 'FAIL 5c after repair paid % balance %, expected 1300/0', amt, bal;
  end if;
  raise notice 'PASS  5c the amount paid and the balance are exactly as they were';

  select count(*)::integer into n from public.supplier_payments
   where supplier_invoice_id = inv_a and status = 'paid';
  if n <> 2 then raise exception 'FAIL 5d % paid payments survive, expected 2', n; end if;
  select count(*)::integer into n from public.treasury_movements
   where source_type = 'supplier_payment'
     and source_id in (select id from public.supplier_payments where supplier_invoice_id = inv_a);
  if n <> 2 then raise exception 'FAIL 5d % treasury movements survive, expected 2', n; end if;
  raise notice 'PASS  5d both payments and both treasury movements are untouched';

  select count(*)::integer into n from public.supplier_invoice_history
   where supplier_invoice_id = inv_a and action = 'system_correction';
  if n <> 1 then raise exception 'FAIL 5e no correction was recorded'; end if;
  select count(*)::integer into n from public.supplier_invoice_history
   where supplier_invoice_id = inv_a and to_status = 'voided';
  if n = 0 then raise exception 'FAIL 5e the original void record was lost'; end if;
  raise notice 'PASS  5e the correction is recorded, and the original void still stands beside it';

  -- Running it again finds nothing, which is what makes the migration safe to
  -- replay.
  update public.supplier_invoices si set status = 'approved'
  where si.id in (select v.id from public.supplier_invoice_status v
                   where v.status = 'voided' and v.amount_paid > 0);
  select count(*)::integer into n
  from public.supplier_invoice_status v where v.status = 'voided' and v.amount_paid > 0;
  if n <> 0 then raise exception 'FAIL 5f a second pass changed something'; end if;
  raise notice 'PASS  5f the repair is idempotent -- a second pass matches nothing';

  -- ======================================================================
  -- 6. What a delivered order still needs an invoice for
  -- ======================================================================
  --
  -- A is billed and paid, B was never billed, C's invoice was voided before
  -- payment -- so C genuinely needs one again, and A does not.
  perform pg_temp.acts_as(accountant); set local role authenticated;
  select count(*)::integer into n
    from public.get_invoiceable_purchase_orders() q where q.purchase_order_id in (po_a, po_b, po_c);
  if n <> 2 then
    raise exception 'FAIL 6a % orders await an invoice, expected 2 (B and C)', n;
  end if;
  raise notice 'PASS  6a a voided unpaid invoice returns its order to the awaiting list';

  select count(*)::integer into n
    from public.get_invoiceable_purchase_orders() q where q.purchase_order_id = po_a;
  if n <> 0 then
    raise exception 'FAIL 6b a fully paid live invoice still counted as awaiting one';
  end if;
  raise notice 'PASS  6b an order with a paid live invoice does not await another';
  reset role;

  -- Restore C's invoice, and the count falls by one. This is the shape of the
  -- production repair: a live invoice removes its order from the list.
  update public.supplier_invoices set status = 'approved' where id = inv_c;

  perform pg_temp.acts_as(accountant); set local role authenticated;
  select count(*)::integer into n
    from public.get_invoiceable_purchase_orders() q where q.purchase_order_id in (po_a, po_b, po_c);
  if n <> 1 then
    raise exception 'FAIL 6c after restoring C, % await an invoice, expected 1 (B only)', n;
  end if;
  raise notice 'PASS  6c restoring an invoice removes its order from the awaiting list';

  -- A partly paid live invoice is still a valid bill, so its order does not
  -- come back either.
  select count(*)::integer into n
    from public.get_invoiceable_purchase_orders() q where q.purchase_order_id = po_c;
  if n <> 0 then raise exception 'FAIL 6d a live invoice''s order counted as awaiting'; end if;
  raise notice 'PASS  6d a live invoice keeps its order off the list, paid or not';
  reset role;

  -- ======================================================================
  -- 7. The repair moves no money
  -- ======================================================================
  select bs.reserved, bs.spent into b_reserved, b_spent
    from public.budget_status bs where bs.id = budget;
  -- Four completed payments across two invoices: 500 + 800 on A, 400 + 250 on
  -- D. 1,950 in total, every peso of it from a recorded payment and none of it
  -- from the repair.
  if b_spent <> 1950 then
    raise exception 'FAIL 7a spent is %, expected 1950 -- from the payments, not the repair', b_spent;
  end if;
  select t.balance into bal from public.treasury_account_status t where t.id = bank;
  if bal <> 48050 then
    raise exception 'FAIL 7a the bank is %, expected 48050 (50000 - 1950)', bal;
  end if;
  raise notice 'PASS  7a budget and treasury reflect the payments, and nothing the repair did';

  raise notice '--------------------------------------------------';
  raise notice 'invoice_void_integrity_rls: all checks passed';
end $$;

rollback;
