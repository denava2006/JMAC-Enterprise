-- F6B: paying a supplier, and the first time Reserved becomes Spent.
--
-- The claims this file defends:
--
--   preparing, submitting and APPROVING a payment move nothing
--   only recording the completed external payment moves anything
--   the payable falls by exactly what was paid, and no more
--   reserved falls by exactly what spent rises by, so available holds still
--   both reservation sources are consumed correctly, and never twice
--   an account cannot be overdrawn, and two payments cannot spend one balance
--   the preparer cannot approve, and no role can pay what nobody approved
--   a completed payment is permanent
--   paying a supplier moves no stock and changes no sale
--
-- The arithmetic is the brief's own worked example:
--
--   Ceiling    50,000    Reserved 6,300    Spent     0    Available 43,700
--   pay 800    ->        Reserved 5,500    Spent   800    Available 43,700
--   pay 500    ->        Reserved 5,000    Spent 1,300    Available 43,700
--
-- Available never moves, because paying a bill you had already set money aside
-- for does not give you more to spend.
--
-- Run:
--   docker exec -i supabase_db_harmony-suite psql -U postgres -d postgres \
--     -v ON_ERROR_STOP=1 -f - < supabase/tests/supplier_payment_rls.sql
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
  admin_id uuid; accountant uuid; accountant2 uuid; fin_mgr uuid; fin_staff uuid;
  pos_mgr uuid; branch_a uuid; general_id uuid; product uuid;
  cat_id uuid; vendor uuid; budget uuid; bank uuid; small_bank uuid;
  req_a uuid; req_b uuid; po_a uuid; po_b uuid; line_a uuid; invoice uuid;
  pay1 uuid; pay2 uuid; pay3 uuid;
  ceiling numeric; reserved numeric; spent numeric; available numeric;
  total numeric; paid numeric; balance numeric; bal numeric;
  state text; n integer; txt text;
  stock_before integer; stock_after integer;
  tag text := left(replace(gen_random_uuid()::text, '-', ''), 8);
begin
  select id into admin_id from public.profiles where role='admin' and status='active' limit 1;
  select id into branch_a from public.branches where is_active order by name limit 1;
  select id into general_id from public.pos_product_categories where normalized_name='general';

  accountant  := pg_temp.hire('Bookkeeper',   'Accountant');
  accountant2 := pg_temp.hire('Bookkeeper 2', 'Accountant');
  fin_mgr     := pg_temp.hire('Fin Manager',  'Finance Manager');
  fin_staff   := pg_temp.hire('Fin Staff',    'Finance Staff');
  pos_mgr     := pg_temp.hire('Store Mgr',    'POS Manager');

  delete from public.pos_branch_assignments;
  insert into public.pos_branch_assignments (profile_id, branch_id, pos_role, created_by)
  values (pos_mgr, branch_a, 'manager', admin_id);

  perform pg_temp.acts_as(admin_id);
  insert into public.pos_products (name, category_id, default_selling_price, default_unit_cost, status)
  values ('ZZ Payment Cola ' || tag, general_id, 100.00, 65.00, 'active') returning id into product;
  insert into public.pos_branch_products (branch_id, product_id, is_available)
  values (branch_a, product, true);
  perform set_config('harmony.pos_inventory_write', 'allowed', true);
  insert into public.pos_branch_inventory (branch_id, product_id, quantity_on_hand)
  values (branch_a, product, 0)
  on conflict (branch_id, product_id) do update set quantity_on_hand = 0;
  perform set_config('harmony.pos_inventory_write', '', true);

  select id into cat_id from public.finance_categories where kind='expense' and is_active limit 1;

  -- ======================================================================
  -- 0. The situation the brief describes
  -- ======================================================================
  --
  -- One 50,000 ceiling carrying two POS procurement commitments: 1,300 that
  -- will be invoiced and paid, and 5,000 that will not be touched. Together
  -- they are the 6,300 reserved.
  perform pg_temp.acts_as(fin_staff); set local role authenticated;
  insert into public.vendors (name, phone) values ('ZZ Sahara ' || tag, '09171234561')
  returning id into vendor;
  insert into public.budgets (name, finance_category_id, amount, fiscal_year)
  values ('ZZ Payment Budget ' || tag, cat_id, 50000, extract(year from current_date)::integer)
  returning id into budget;
  reset role;
  perform pg_temp.acts_as(fin_mgr); set local role authenticated;
  perform public.review_vendor(vendor, true, 'fixture');
  perform public.review_budget(budget, true, 'fixture');
  reset role;

  perform pg_temp.acts_as(pos_mgr); set local role authenticated;
  select public.create_pos_stock_request(branch_a, product, 20, 'ZZ to be paid') into req_a;
  reset role;
  perform pg_temp.acts_as(fin_staff); set local role authenticated;
  perform public.approve_pos_request(req_a, 'Accepted');
  select public.create_purchase_order_from_source(
    'pos_restock', req_a, vendor, null, null, 20, 65.00, null, true, budget) into po_a;
  reset role;
  perform pg_temp.acts_as(fin_mgr); set local role authenticated;
  perform public.transition_purchase_order(po_a, 'approved');
  reset role;

  perform pg_temp.acts_as(pos_mgr); set local role authenticated;
  select public.create_pos_stock_request(branch_a, product, 100, 'ZZ untouched') into req_b;
  reset role;
  perform pg_temp.acts_as(fin_staff); set local role authenticated;
  perform public.approve_pos_request(req_b, 'Accepted');
  select public.create_purchase_order_from_source(
    'pos_restock', req_b, vendor, null, null, 100, 50.00, null, true, budget) into po_b;
  reset role;
  perform pg_temp.acts_as(fin_mgr); set local role authenticated;
  perform public.transition_purchase_order(po_b, 'approved');
  reset role;

  select bs.amount, bs.reserved, bs.spent, bs.remaining
    into ceiling, reserved, spent, available
    from public.budget_status bs where bs.id = budget;
  if ceiling <> 50000 or reserved <> 6300 or spent <> 0 or available <> 43700 then
    raise exception 'FAIL 0a budget starts at ceiling % reserved % spent % available %, expected 50000/6300/0/43700',
      ceiling, reserved, spent, available;
  end if;
  raise notice 'PASS  0a the ceiling holds 6,300 reserved, nothing spent, 43,700 available';

  -- The goods arrive, and the Accountant records the bill.
  select id into line_a from public.purchase_order_items where purchase_order_id = po_a;
  perform pg_temp.acts_as(pos_mgr); set local role authenticated;
  perform public.receive_procurement_stock(line_a, 20, 'ZZ-DR-' || tag, gen_random_uuid());
  reset role;

  perform pg_temp.acts_as(accountant); set local role authenticated;
  select public.create_supplier_invoice(
    po_a, 'SI-' || tag, current_date, current_date + 30,
    jsonb_build_array(jsonb_build_object(
      'purchase_order_item_id', line_a, 'quantity', 20, 'unit_price', 65.00)),
    0, 0, null, 'ZZ payable') into invoice;
  perform public.transition_supplier_invoice(invoice, 'for_review');
  reset role;
  perform pg_temp.acts_as(fin_mgr); set local role authenticated;
  perform public.transition_supplier_invoice(invoice, 'approved');
  reset role;

  select v.total_amount, v.amount_paid, v.balance_due, v.settlement_state
    into total, paid, balance, state
    from public.supplier_invoice_status v where v.id = invoice;
  if total <> 1300 or paid <> 0 or balance <> 1300 then
    raise exception 'FAIL 0b invoice total % paid % balance %, expected 1300/0/1300', total, paid, balance;
  end if;
  if state <> 'awaiting_payment' then raise exception 'FAIL 0b state is %', state; end if;
  raise notice 'PASS  0b an approved invoice owes its whole total and is awaiting payment';

  -- A funded account, and a nearly empty one to prove the funds check.
  perform pg_temp.acts_as(accountant); set local role authenticated;
  insert into public.treasury_accounts (name, account_type, opening_balance, opening_balance_as_of)
  values ('ZZ Main Bank ' || tag, 'bank', 25000, current_date) returning id into bank;
  -- Deliberately short: the second payable below is 650, and this account
  -- holds 100, so completing from here has to be refused.
  insert into public.treasury_accounts (name, account_type, opening_balance, opening_balance_as_of)
  values ('ZZ Petty Cash ' || tag, 'cash', 100, current_date) returning id into small_bank;
  reset role;

  -- ======================================================================
  -- 1. Preparing and approving move nothing
  -- ======================================================================
  perform pg_temp.acts_as(accountant); set local role authenticated;
  select public.create_supplier_payment(invoice, bank, 800, 'bank_transfer', 'ZZ first', false)
    into pay1;
  reset role;

  select v.balance_due into balance from public.supplier_invoice_status v where v.id = invoice;
  select bs.reserved, bs.spent into reserved, spent from public.budget_status bs where bs.id = budget;
  select t.balance into bal from public.treasury_account_status t where t.id = bank;
  if balance <> 1300 or reserved <> 6300 or spent <> 0 or bal <> 25000 then
    raise exception 'FAIL 1a preparing changed something: balance % reserved % spent % bank %',
      balance, reserved, spent, bal;
  end if;
  raise notice 'PASS  1a preparing a payment changes no payable, budget or balance';

  perform pg_temp.acts_as(accountant); set local role authenticated;
  perform public.transition_supplier_payment(pay1, 'for_approval', null, null, null);
  reset role;

  select v.balance_due into balance from public.supplier_invoice_status v where v.id = invoice;
  if balance <> 1300 then raise exception 'FAIL 1b submitting changed the payable to %', balance; end if;
  raise notice 'PASS  1b submitting a payment changes no payable';

  -- The one the brief calls out specifically: approval is authorisation, and
  -- JMAC has no transfer API, so nothing has left the bank yet.
  perform pg_temp.acts_as(fin_mgr); set local role authenticated;
  perform public.transition_supplier_payment(pay1, 'approved', null, null, null);
  reset role;

  select v.balance_due into balance from public.supplier_invoice_status v where v.id = invoice;
  select bs.reserved, bs.spent into reserved, spent from public.budget_status bs where bs.id = budget;
  select t.balance into bal from public.treasury_account_status t where t.id = bank;
  if balance <> 1300 or reserved <> 6300 or spent <> 0 or bal <> 25000 then
    raise exception 'FAIL 1c APPROVAL moved money: balance % reserved % spent % bank %',
      balance, reserved, spent, bal;
  end if;
  raise notice 'PASS  1c approving a payment authorises it and moves nothing';

  -- ======================================================================
  -- 2. Recording the completed payment is what spends
  -- ======================================================================
  select quantity_on_hand into stock_before
    from public.pos_branch_inventory where branch_id = branch_a and product_id = product;

  perform pg_temp.acts_as(accountant); set local role authenticated;
  perform public.transition_supplier_payment(pay1, 'paid', null, 'TRF-800-' || tag, current_date);
  reset role;

  select v.amount_paid, v.balance_due, v.settlement_state
    into paid, balance, state from public.supplier_invoice_status v where v.id = invoice;
  if paid <> 800 or balance <> 500 then
    raise exception 'FAIL 2a after paying 800: paid % balance %, expected 800/500', paid, balance;
  end if;
  if state <> 'partially_paid' then raise exception 'FAIL 2a state is %', state; end if;
  raise notice 'PASS  2a a completed payment of 800 leaves 500 owing, partially paid';

  select t.balance into bal from public.treasury_account_status t where t.id = bank;
  if bal <> 24200 then raise exception 'FAIL 2b the bank is %, expected 24200', bal; end if;
  raise notice 'PASS  2b the money left the account it was paid from';

  -- The arithmetic the whole phase exists for.
  select bs.reserved, bs.spent, bs.remaining into reserved, spent, available
    from public.budget_status bs where bs.id = budget;
  if reserved <> 5500 then raise exception 'FAIL 2c reserved is %, expected 5500', reserved; end if;
  if spent <> 800 then raise exception 'FAIL 2c spent is %, expected 800', spent; end if;
  if available <> 43700 then
    raise exception 'FAIL 2c available moved to %, and it must stay 43700', available;
  end if;
  raise notice 'PASS  2c reserved 6300->5500, spent 0->800, and available holds at 43700';

  select quantity_on_hand into stock_after
    from public.pos_branch_inventory where branch_id = branch_a and product_id = product;
  if stock_before <> stock_after then
    raise exception 'FAIL 2d paying moved stock: % -> %', stock_before, stock_after;
  end if;
  raise notice 'PASS  2d paying a supplier moves no stock -- receiving already did';

  -- ======================================================================
  -- 3. The rest of it
  -- ======================================================================
  perform pg_temp.acts_as(accountant); set local role authenticated;
  select public.create_supplier_payment(invoice, bank, 500, 'bank_transfer', 'ZZ second', true)
    into pay2;
  reset role;
  perform pg_temp.acts_as(fin_mgr); set local role authenticated;
  perform public.transition_supplier_payment(pay2, 'approved', null, null, null);
  reset role;
  perform pg_temp.acts_as(accountant); set local role authenticated;
  perform public.transition_supplier_payment(pay2, 'paid', null, 'TRF-500-' || tag, current_date);
  reset role;

  select v.amount_paid, v.balance_due, v.settlement_state, v.payment_state
    into paid, balance, state, txt from public.supplier_invoice_status v where v.id = invoice;
  if paid <> 1300 or balance <> 0 then
    raise exception 'FAIL 3a after the rest: paid % balance %, expected 1300/0', paid, balance;
  end if;
  if state <> 'paid' then raise exception 'FAIL 3a state is %, expected paid', state; end if;
  -- A settled invoice is not overdue; there is nothing left to be late.
  if txt <> 'settled' then raise exception 'FAIL 3a payment_state is %, expected settled', txt; end if;
  raise notice 'PASS  3a the second payment clears the invoice, and it reads as paid';

  select bs.reserved, bs.spent, bs.remaining into reserved, spent, available
    from public.budget_status bs where bs.id = budget;
  if reserved <> 5000 then raise exception 'FAIL 3b reserved is %, expected 5000', reserved; end if;
  if spent <> 1300 then raise exception 'FAIL 3b spent is %, expected 1300', spent; end if;
  if available <> 43700 then
    raise exception 'FAIL 3b available moved to %, and it must stay 43700', available;
  end if;
  raise notice 'PASS  3b reserved 6300->5000, spent 0->1300, available never moved';

  -- The untouched commitment is exactly the 5,000 that remains reserved: the
  -- payment consumed its own obligation and nobody else's.
  select public.purchase_order_commitment(po_b) - public.purchase_order_paid(po_b) into bal;
  if bal <> 5000 then
    raise exception 'FAIL 3c the other order now reserves %, expected 5000', bal;
  end if;
  raise notice 'PASS  3c a payment consumes its own reservation and no other';

  select t.balance into bal from public.treasury_account_status t where t.id = bank;
  if bal <> 23700 then raise exception 'FAIL 3d the bank is %, expected 23700', bal; end if;
  raise notice 'PASS  3d the account is down by exactly the two payments';

  -- ======================================================================
  -- 4. What is refused
  -- ======================================================================
  perform pg_temp.acts_as(accountant); set local role authenticated;
  begin
    perform public.create_supplier_payment(invoice, bank, 1, 'bank_transfer', null, false);
    raise exception 'FAIL 4a a fully paid invoice took another payment';
  exception when check_violation then
    raise notice 'PASS  4a an invoice with nothing outstanding cannot be paid again';
  end;
  reset role;

  -- Overpayment, on a fresh payable.
  perform pg_temp.acts_as(pos_mgr); set local role authenticated;
  select public.create_pos_stock_request(branch_a, product, 10, 'ZZ overpay case') into req_b;
  reset role;
  perform pg_temp.acts_as(fin_staff); set local role authenticated;
  perform public.approve_pos_request(req_b, 'Accepted');
  select public.create_purchase_order_from_source(
    'pos_restock', req_b, vendor, null, null, 10, 65.00, null, true, budget) into po_b;
  reset role;
  perform pg_temp.acts_as(fin_mgr); set local role authenticated;
  perform public.transition_purchase_order(po_b, 'approved');
  reset role;
  select id into line_a from public.purchase_order_items where purchase_order_id = po_b;
  perform pg_temp.acts_as(pos_mgr); set local role authenticated;
  perform public.receive_procurement_stock(line_a, 10, 'ZZ-DR2-' || tag, gen_random_uuid());
  reset role;
  perform pg_temp.acts_as(accountant); set local role authenticated;
  select public.create_supplier_invoice(
    po_b, 'SI2-' || tag, current_date, current_date + 30,
    jsonb_build_array(jsonb_build_object(
      'purchase_order_item_id', line_a, 'quantity', 10, 'unit_price', 65.00)),
    0, 0, null, 'ZZ second payable') into invoice;
  perform public.transition_supplier_invoice(invoice, 'for_review');
  reset role;
  perform pg_temp.acts_as(fin_mgr); set local role authenticated;
  perform public.transition_supplier_invoice(invoice, 'approved');
  reset role;

  perform pg_temp.acts_as(accountant); set local role authenticated;
  begin
    perform public.create_supplier_payment(invoice, bank, 5000, 'bank_transfer', null, false);
    raise exception 'FAIL 4b a payment larger than the balance was accepted';
  exception when check_violation then
    raise notice 'PASS  4b a payment cannot exceed what is owed';
  end;

  -- Insufficient funds, in the exact words the brief asks for.
  select public.create_supplier_payment(invoice, small_bank, 650, 'cash', null, true) into pay3;
  reset role;
  perform pg_temp.acts_as(fin_mgr); set local role authenticated;
  perform public.transition_supplier_payment(pay3, 'approved', null, null, null);
  reset role;
  perform pg_temp.acts_as(accountant); set local role authenticated;
  begin
    perform public.transition_supplier_payment(pay3, 'paid', null, 'CASH-' || tag, current_date);
    raise exception 'FAIL 4c an account holding 100 paid out 650';
  exception when check_violation then
    if sqlerrm <> 'This account does not have enough available funds for this payment.' then
      raise exception 'FAIL 4c wrong message: %', sqlerrm;
    end if;
    raise notice 'PASS  4c an account cannot be overdrawn, and says so plainly';
  end;
  reset role;

  -- ======================================================================
  -- 5. Maker, checker, and the gap between them
  -- ======================================================================
  --
  -- Self-approval blocked on identity: two Accountants exist, so the second
  -- one preparing proves the rule is about who did it, not what role they hold.
  perform pg_temp.acts_as(accountant2); set local role authenticated;
  select public.create_supplier_payment(invoice, bank, 650, 'bank_transfer', null, true)
    into pay3;
  reset role;

  perform pg_temp.acts_as(accountant2); set local role authenticated;
  begin
    perform public.transition_supplier_payment(pay3, 'approved', null, null, null);
    raise exception 'FAIL 5a the preparer approved their own payment';
  exception when insufficient_privilege then
    raise notice 'PASS  5a the person who prepared a payment cannot approve it';
  end;
  reset role;

  -- Nor may procurement decide an accounting document.
  perform pg_temp.acts_as(fin_staff); set local role authenticated;
  begin
    perform public.transition_supplier_payment(pay3, 'approved', null, null, null);
    raise exception 'FAIL 5b Finance Staff approved a payment';
  exception when insufficient_privilege then
    raise notice 'PASS  5b only the Finance Manager approves a payment';
  end;
  begin
    perform public.create_supplier_payment(invoice, bank, 10, 'cash', null, false);
    raise exception 'FAIL 5b Finance Staff prepared a payment';
  exception when insufficient_privilege then
    raise notice 'PASS  5c preparing a payment is the Accountant''s, not procurement''s';
  end;
  reset role;

  -- The gap that matters most: nobody can record a payment that was never
  -- authorised, however senior they are.
  perform pg_temp.acts_as(accountant); set local role authenticated;
  begin
    perform public.transition_supplier_payment(pay3, 'paid', null, 'SNEAK-' || tag, current_date);
    raise exception 'FAIL 5d an unapproved payment was recorded as paid';
  exception when check_violation then
    raise notice 'PASS  5d a payment nobody approved cannot be recorded as paid';
  end;
  reset role;

  -- Rejecting needs a reason.
  perform pg_temp.acts_as(fin_mgr); set local role authenticated;
  begin
    perform public.transition_supplier_payment(pay3, 'rejected', null, null, null);
    raise exception 'FAIL 5e a payment was rejected with no reason';
  exception when check_violation then
    raise notice 'PASS  5e rejecting a payment requires a reason';
  end;
  perform public.transition_supplier_payment(pay3, 'approved', null, null, null);
  reset role;

  -- ======================================================================
  -- 6. Recorded once, and permanently
  -- ======================================================================
  perform pg_temp.acts_as(accountant); set local role authenticated;
  perform public.transition_supplier_payment(pay3, 'paid', null, 'TRF-650-' || tag, current_date);

  -- The retry. A refresh, a double click, a network replay: the row is already
  -- paid, so there is nothing left to move.
  begin
    perform public.transition_supplier_payment(pay3, 'paid', null, 'TRF-650-' || tag, current_date);
    raise exception 'FAIL 6a the same payment completed twice';
  exception when check_violation then
    raise notice 'PASS  6a a completed payment cannot be completed again';
  end;

  select count(*)::integer into n from public.treasury_movements
   where source_type = 'supplier_payment' and source_id = pay3;
  if n <> 1 then raise exception 'FAIL 6b one payment produced % movements', n; end if;
  raise notice 'PASS  6b one completed payment, exactly one treasury movement';

  begin
    update public.supplier_payments set amount = 1 where id = pay3;
    raise exception 'FAIL 6c a completed payment was edited';
  exception when insufficient_privilege then
    raise notice 'PASS  6c a completed payment is a permanent record';
  end;
  reset role;

  -- The second invoice is now settled, and the budget reflects all three
  -- payments: 800 + 500 + 650.
  select bs.reserved, bs.spent, bs.remaining into reserved, spent, available
    from public.budget_status bs where bs.id = budget;
  if spent <> 1950 then raise exception 'FAIL 6d spent is %, expected 1950', spent; end if;
  raise notice 'PASS  6d spent totals every completed payment against the budget';

  -- ======================================================================
  -- 7. Who may look
  -- ======================================================================
  perform pg_temp.acts_as(pos_mgr); set local role authenticated;
  select count(*)::integer into n from public.get_supplier_payments(null);
  if n <> 0 then raise exception 'FAIL 7a a POS Manager read supplier payments'; end if;
  select count(*)::integer into n from public.get_payable_invoices();
  if n <> 0 then raise exception 'FAIL 7a a POS Manager read the payables'; end if;
  reset role;
  raise notice 'PASS  7a POS roles cannot see supplier payments';

  perform pg_temp.acts_as(fin_staff); set local role authenticated;
  select count(*)::integer into n from public.get_supplier_payments(null);
  if n < 3 then raise exception 'FAIL 7b Finance Staff cannot read payments (%)', n; end if;
  reset role;
  raise notice 'PASS  7b the Finance group can read the payment history';

  raise notice '--------------------------------------------------';
  raise notice 'supplier_payment_rls: all checks passed';
end $$;

rollback;
