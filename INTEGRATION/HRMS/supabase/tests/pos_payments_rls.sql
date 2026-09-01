-- Provider-backed POS payments — database contract test.
--
-- A payment integration is where a bug becomes somebody's money, so the checks
-- here are about the properties that must hold no matter what the provider,
-- the network or the browser does:
--
--   * the amount charged is the amount the sale records, fees included;
--   * nothing a browser can reach may mark a payment paid;
--   * a webhook delivered many times creates exactly one sale;
--   * when the world changed underneath a payment, the sale is NOT created and
--     a person is left to decide about the refund.
--
-- Run:
--   docker exec -i supabase_db_harmony-suite psql -U postgres -d postgres \
--     -v ON_ERROR_STOP=1 -f - < supabase/tests/pos_payments_rls.sql
--
-- One transaction, rolled back at the end. Nothing is written.

begin;

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

do $$
declare
  admin_id     uuid;
  till_user    uuid;
  other_user   uuid;
  branch_a     uuid;
  branch_b     uuid;
  general_id   uuid;
  cola_id      uuid;
  attempt_id   uuid;
  attempt2_id  uuid;
  key1         uuid := gen_random_uuid();
  key2         uuid := gen_random_uuid();
  key3         uuid := gen_random_uuid();
  key4         uuid := gen_random_uuid();
  key5         uuid := gen_random_uuid();
  cart         jsonb;
  pricing      jsonb;
  result       jsonb;
  receipt      jsonb;
  n            integer;
  qty          integer;
  before_qty   integer;
  txt          text;
  ts           timestamptz;
  flag         boolean;
  tag          text := left(replace(gen_random_uuid()::text, '-', ''), 8);
begin
  ------------------------------------------------------------------ fixtures
  select id into admin_id from public.profiles where role = 'admin' and status = 'active' limit 1;
  select id into branch_a from public.branches where is_active order by name limit 1;
  select id into branch_b from public.branches where is_active and id <> branch_a order by name limit 1;
  select id into till_user from public.profiles
    where role = 'employee' and status = 'active' order by created_at, id limit 1;
  select id into other_user from public.profiles
    where role <> 'admin' and status = 'active' and id <> till_user order by created_at, id limit 1;
  select id into general_id from public.pos_product_categories where normalized_name = 'general';

  if admin_id is null or branch_a is null or branch_b is null or till_user is null
     or other_user is null or general_id is null then
    raise exception 'fixture: need an admin, two branches, an employee, another account, General';
  end if;

  delete from public.pos_branch_assignments;
  perform pg_temp.make_pos_eligible(till_user, 'Cashier');
  insert into public.pos_branch_assignments (profile_id, branch_id, pos_role, created_by)
  values (till_user, branch_a, 'cashier', admin_id);

  insert into public.pos_products (name, category_id, default_selling_price, default_unit_cost, status)
  values ('ZZ Pay Cola ' || tag, general_id, 100.00, 0, 'active') returning id into cola_id;

  insert into public.pos_branch_products (branch_id, product_id, is_available, selling_price_override)
  values (branch_a, cola_id, true, null);

  perform set_config('request.jwt.claims', json_build_object('sub', admin_id, 'role', 'authenticated')::text, true);
  set local role authenticated;
  perform public.receive_pos_stock(branch_a, cola_id, 50, 60.00, null);
  reset role;

  -- A 10% service charge, so fees are exercised rather than assumed away.
  -- This is the case that a naive line-sum pricing gets wrong: one 100.00 cola
  -- is a 110.00 sale, not a 100.00 one.
  insert into public.branch_pos_settings (branch_id, fees)
  values (branch_a, jsonb_build_array(jsonb_build_object(
    'id', 'f1', 'name', 'Service Charge', 'type', 'percent', 'value', 10, 'enabled', true)))
  on conflict (branch_id) do update set fees = excluded.fees;

  cart := jsonb_build_array(jsonb_build_object('product_id', cola_id, 'quantity', 1));

  -- ======================================================================
  -- 1. The amount charged is the amount recorded
  -- ======================================================================
  pricing := public.price_pos_cart(branch_a, cart);

  if (pricing->>'total')::numeric <> 110.00 then
    raise exception 'FAIL  1a priced % , expected 110.00 (100.00 + 10%% fee)', pricing->>'total';
  end if;
  raise notice 'PASS  1a price_pos_cart includes branch fees';

  if (pricing->>'total_centavos')::bigint <> 11000 then
    raise exception 'FAIL  1b centavos % , expected 11000', pricing->>'total_centavos';
  end if;
  raise notice 'PASS  1b pesos become centavos in exactly one place';

  -- The invariant that matters most: what price_pos_cart quotes is what
  -- checkout_pos_sale will charge. If these two ever drift, a customer is
  -- billed one number and the receipt shows another.
  perform set_config('request.jwt.claims', json_build_object('sub', till_user, 'role', 'authenticated')::text, true);
  set local role authenticated;
  receipt := public.checkout_pos_sale(branch_a, cart, 'cash', key1, null, 500);
  reset role;

  if (receipt->'sale'->>'total_amount')::numeric <> (pricing->>'total')::numeric then
    raise exception 'FAIL  1c quote % but the sale totalled %',
      pricing->>'total', receipt->'sale'->>'total_amount';
  end if;
  raise notice 'PASS  1c price_pos_cart agrees with checkout_pos_sale to the centavo';

  -- ======================================================================
  -- 2. Nothing a browser reaches may create or alter a payment
  -- ======================================================================
  set local role authenticated;
  begin
    perform public.price_pos_cart(branch_a, cart);
    raise exception 'FAIL  2a an authenticated caller priced a cart server-side';
  exception when insufficient_privilege then
    raise notice 'PASS  2a price_pos_cart is denied to authenticated';
  when raise_exception then
    if sqlerrm like 'FAIL%' then raise; end if;
    raise notice 'PASS  2a price_pos_cart is denied to authenticated';
  end;
  reset role;

  set local role authenticated;
  begin
    perform public.finalize_pos_payment(gen_random_uuid(), null, null);
    raise exception 'FAIL  2b an authenticated caller could finalize a payment';
  exception when insufficient_privilege then
    raise notice 'PASS  2b finalize_pos_payment is denied to authenticated';
  when raise_exception then
    if sqlerrm like 'FAIL%' then raise; end if;
    raise notice 'PASS  2b finalize_pos_payment is denied to authenticated';
  end;
  reset role;

  set local role authenticated;
  begin
    perform public.mark_pos_payment_state(gen_random_uuid(), 'failed', null);
    raise exception 'FAIL  2c an authenticated caller could set payment state';
  exception when insufficient_privilege then
    raise notice 'PASS  2c mark_pos_payment_state is denied to authenticated';
  when raise_exception then
    if sqlerrm like 'FAIL%' then raise; end if;
    raise notice 'PASS  2c mark_pos_payment_state is denied to authenticated';
  end;
  reset role;

  -- No INSERT policy exists, so a cashier cannot fabricate a paid attempt.
  perform set_config('request.jwt.claims', json_build_object('sub', till_user, 'role', 'authenticated')::text, true);
  set local role authenticated;
  begin
    insert into public.pos_payment_attempts
      (branch_id, cashier_profile_id, checkout_key, method, amount_centavos, items, reference_number, status)
    values (branch_a, till_user, gen_random_uuid(), 'gcash', 100, cart, 'JMAC-POS-FAKE01', 'paid');
    raise exception 'FAIL  2d a cashier inserted a payment attempt directly';
  exception when insufficient_privilege then
    raise notice 'PASS  2d a cashier cannot insert a payment attempt';
  when raise_exception then
    if sqlerrm like 'FAIL%' then raise; end if;
    raise notice 'PASS  2d a cashier cannot insert a payment attempt';
  end;
  reset role;

  -- ======================================================================
  -- 3. Test mode is enforced by the database, not by remembering
  -- ======================================================================
  begin
    insert into public.pos_payment_attempts
      (branch_id, cashier_profile_id, checkout_key, method, amount_centavos, items,
       reference_number, livemode)
    values (branch_a, till_user, gen_random_uuid(), 'card', 11000, cart, 'JMAC-POS-LIVE01', true);
    raise exception 'FAIL  3a a live-mode attempt was accepted';
  exception when check_violation then
    raise notice 'PASS  3a a live-mode payment attempt is rejected by CHECK';
  end;

  -- ======================================================================
  -- 4. A confirmed payment becomes a sale, exactly once
  -- ======================================================================
  select quantity_on_hand into before_qty from public.pos_branch_inventory
   where branch_id = branch_a and product_id = cola_id;

  insert into public.pos_payment_attempts
    (branch_id, cashier_profile_id, checkout_key, method, amount_centavos, items, reference_number)
  values (branch_a, till_user, key2, 'gcash', 11000, cart, 'JMAC-POS-AAAAAA01')
  returning id into attempt_id;

  result := public.finalize_pos_payment(attempt_id, 'pay_test_1', 11000);

  if result->>'status' <> 'paid' then
    raise exception 'FAIL  4a finalize returned % (%)', result->>'status', result->>'reason';
  end if;
  raise notice 'PASS  4a a confirmed payment becomes a sale';

  select count(*) into n from public.pos_sales where checkout_key = key2;
  if n <> 1 then
    raise exception 'FAIL  4b % sales for one payment', n;
  end if;
  raise notice 'PASS  4b exactly one sale was created';

  -- The attempt must POINT AT the sale, not merely coexist with one.
  --
  -- This check exists because the suite did not have it: finalize_pos_payment
  -- read the receipt at the wrong path, jsonb returned NULL for the missing
  -- key rather than raising, and the attempt was marked paid with a NULL
  -- sale_id. Everything the suite did assert -- the returned status, the sale
  -- count, the stock deduction -- was correct, so it passed. A real test
  -- payment caught it, because the till waits on exactly this field before it
  -- shows the receipt.
  if (result->>'sale_id') is null then
    raise exception 'FAIL  4b1 finalize returned no sale_id';
  end if;
  select sale_id into attempt2_id from public.pos_payment_attempts where id = attempt_id;
  if attempt2_id is null then
    raise exception 'FAIL  4b2 the paid attempt has no sale_id';
  end if;
  if attempt2_id <> (select id from public.pos_sales where checkout_key = key2) then
    raise exception 'FAIL  4b3 the attempt points at the wrong sale';
  end if;
  if (result->>'total')::numeric <> 110.00 then
    raise exception 'FAIL  4b4 finalize reported total %, expected 110.00', result->>'total';
  end if;
  raise notice 'PASS  4b1-4 the attempt links to its sale, and reports its real total';

  select quantity_on_hand into qty from public.pos_branch_inventory
   where branch_id = branch_a and product_id = cola_id;
  if qty <> before_qty - 1 then
    raise exception 'FAIL  4c stock went from % to %, expected one deducted', before_qty, qty;
  end if;
  raise notice 'PASS  4c stock is deducted only when the payment is confirmed';

  select payment_reference into txt from public.pos_sales where checkout_key = key2;
  if txt <> 'JMAC-POS-AAAAAA01' then
    raise exception 'FAIL  4d sale reference is %', txt;
  end if;
  raise notice 'PASS  4d the sale carries the JMAC payment reference';

  select count(*) into n from public.pos_sales
   where checkout_key = key2 and amount_tendered is null and change_given is null;
  if n <> 1 then
    raise exception 'FAIL  4e an electronic sale recorded cash tendered or change';
  end if;
  raise notice 'PASS  4e an electronic payment records no cash tendered and no change';

  -- A webhook redelivered is the normal case, not the exception.
  result := public.finalize_pos_payment(attempt_id, 'pay_test_1', 11000);
  if coalesce((result->>'already')::boolean, false) is not true then
    raise exception 'FAIL  4f a redelivered webhook was not recognised as already done';
  end if;
  select count(*) into n from public.pos_sales where checkout_key = key2;
  if n <> 1 then
    raise exception 'FAIL  4g redelivery created a second sale (% total)', n;
  end if;
  raise notice 'PASS  4f-g a webhook delivered twice finalizes exactly once';

  -- ======================================================================
  -- 5. When the world changed, refuse rather than record a wrong sale
  -- ======================================================================
  -- attempt2_id was borrowed above to hold a sale id; reassign it here.
  insert into public.pos_payment_attempts
    (branch_id, cashier_profile_id, checkout_key, method, amount_centavos, items, reference_number)
  values (branch_a, till_user, key3, 'card', 11000, cart, 'JMAC-POS-BBBBBB02')
  returning id into attempt2_id;

  -- The provider says a different amount was collected.
  result := public.finalize_pos_payment(attempt2_id, 'pay_test_2', 9900);
  if result->>'status' <> 'paid_unfulfilled' or result->>'reason' <> 'amount_mismatch' then
    raise exception 'FAIL  5a amount mismatch produced % / %', result->>'status', result->>'reason';
  end if;
  select count(*) into n from public.pos_sales where checkout_key = key3;
  if n <> 0 then
    raise exception 'FAIL  5b a sale was created despite an amount mismatch';
  end if;
  raise notice 'PASS  5a-b an amount mismatch is never turned into a sale';

  -- A price change between starting the payment and confirming it.
  insert into public.pos_payment_attempts
    (branch_id, cashier_profile_id, checkout_key, method, amount_centavos, items, reference_number)
  values (branch_a, till_user, key4, 'qrph', 11000, cart, 'JMAC-POS-CCCCCC03')
  returning id into attempt_id;

  perform set_config('request.jwt.claims', json_build_object('sub', admin_id, 'role', 'authenticated')::text, true);
  update public.pos_branch_products set selling_price_override = 150.00
   where branch_id = branch_a and product_id = cola_id;

  result := public.finalize_pos_payment(attempt_id, 'pay_test_3', 11000);
  if result->>'status' <> 'paid_unfulfilled' or result->>'reason' <> 'price_changed' then
    raise exception 'FAIL  5c price change produced % / %', result->>'status', result->>'reason';
  end if;
  select count(*) into n from public.pos_sales where checkout_key = key4;
  if n <> 0 then
    raise exception 'FAIL  5d a sale was created after the price changed';
  end if;
  raise notice 'PASS  5c-d a price change mid-payment leaves a refund decision to a person';

  update public.pos_branch_products set selling_price_override = null
   where branch_id = branch_a and product_id = cola_id;
  perform set_config('request.jwt.claims', json_build_object('sub', till_user, 'role', 'authenticated')::text, true);

  -- A cashier who lost POS access while the customer was paying.
  insert into public.pos_payment_attempts
    (branch_id, cashier_profile_id, checkout_key, method, amount_centavos, items, reference_number)
  values (branch_a, till_user, gen_random_uuid(), 'gcash', 11000, cart, 'JMAC-POS-DDDDDD04')
  returning id into attempt_id;

  delete from public.pos_branch_assignments where profile_id = till_user;

  result := public.finalize_pos_payment(attempt_id, 'pay_test_4', 11000);
  if result->>'status' <> 'paid_unfulfilled' then
    raise exception 'FAIL  5e a revoked cashier still completed a sale (%)', result->>'status';
  end if;
  raise notice 'PASS  5e a cashier who lost POS access mid-payment cannot complete the sale';

  insert into public.pos_branch_assignments (profile_id, branch_id, pos_role, created_by)
  values (till_user, branch_a, 'cashier', admin_id);

  -- ======================================================================
  -- 6. State transitions cannot launder a payment into paid
  -- ======================================================================
  begin
    perform public.mark_pos_payment_state(attempt2_id, 'paid', null);
    raise exception 'FAIL  6a mark_pos_payment_state accepted paid';
  exception when raise_exception then
    if sqlerrm like 'FAIL%' then raise; end if;
    raise notice 'PASS  6a mark_pos_payment_state refuses to mark anything paid';
  end;

  -- A late "expired" after a real payment must not unmake the sale.
  select id into attempt_id from public.pos_payment_attempts where checkout_key = key2;
  perform public.mark_pos_payment_state(attempt_id, 'expired', 'late event');
  select status::text into txt from public.pos_payment_attempts where id = attempt_id;
  if txt <> 'paid' then
    raise exception 'FAIL  6b a paid attempt was demoted to %', txt;
  end if;
  raise notice 'PASS  6b a late expiry event cannot demote a paid attempt';

  -- ======================================================================
  -- 7. Till-side cancellation, and who may see an attempt
  -- ======================================================================
  perform set_config('request.jwt.claims', json_build_object('sub', other_user, 'role', 'authenticated')::text, true);
  set local role authenticated;
  -- Cancelling is no longer reachable from a session at all: the grant was
  -- revoked when cancellation moved server-side, so that it can expire the
  -- provider session before recording anything. Branch authority is still
  -- enforced, now by may_cancel_pos_payment on the caller's behalf (11c).
  begin
    perform public.cancel_pos_payment_attempt(key3);
    raise exception 'FAIL  7a someone with no POS access cancelled a payment';
  exception when insufficient_privilege then
    raise notice 'PASS  7a cancelling is not reachable from a browser session';
  when raise_exception then
    if sqlerrm like 'FAIL%' then raise; end if;
    raise notice 'PASS  7a cancelling is not reachable from a browser session';
  end;
  reset role;

  perform set_config('request.jwt.claims', json_build_object('sub', other_user, 'role', 'authenticated')::text, true);
  set local role authenticated;
  select count(*) into n from public.pos_payment_attempts;
  reset role;
  if n <> 0 then
    raise exception 'FAIL  7b an account with no POS access saw % payment attempts', n;
  end if;
  raise notice 'PASS  7b payment attempts are invisible without POS access';

  perform set_config('request.jwt.claims', json_build_object('sub', till_user, 'role', 'authenticated')::text, true);
  set local role authenticated;
  select count(*) into n from public.pos_payment_attempts;
  reset role;
  if n < 1 then
    raise exception 'FAIL  7c a cashier could not see their own branch attempts';
  end if;
  raise notice 'PASS  7c a cashier sees their own branch payment attempts';

  -- ======================================================================
  -- 8. Idempotency key, and cash separation
  -- ======================================================================
  begin
    insert into public.pos_payment_attempts
      (branch_id, cashier_profile_id, checkout_key, method, amount_centavos, items, reference_number)
    values (branch_a, till_user, key2, 'card', 11000, cart, 'JMAC-POS-EEEEEE05');
    raise exception 'FAIL  8a a second attempt reused a checkout key';
  exception when unique_violation then
    raise notice 'PASS  8a one checkout key means one payment attempt';
  end;

  if public.pos_payment_is_cash('cash') is not true
     or public.pos_payment_is_cash('gcash') is not false
     or public.pos_payment_is_cash('card') is not false
     or public.pos_payment_is_cash('qrph') is not false then
    raise exception 'FAIL  8b cash classification is wrong';
  end if;
  raise notice 'PASS  8b only cash counts as cash for the drawer';


  -- ======================================================================
  -- 9. Abandonment: a session that is never paid must stop being payable
  -- ======================================================================
  --
  -- PayMongo checkout sessions never expire on their own and this account has
  -- no checkout_session.expired event, so JMAC owns the deadline. These checks
  -- cover the database half; the provider half is covered by the sweep's own
  -- tests, which assert it kills the session BEFORE recording anything.

  insert into public.pos_payment_attempts
    (branch_id, cashier_profile_id, checkout_key, method, amount_centavos, items, reference_number)
  values (branch_a, till_user, key5, 'gcash', 11000, cart, 'JMAC-POS-FFFFFF06')
  returning id into attempt_id;

  select expires_at into ts from public.pos_payment_attempts where id = attempt_id;
  if ts is null then
    raise exception 'FAIL  9a a new attempt has no deadline';
  end if;
  raise notice 'PASS  9a every attempt gets a deadline at insert';

  -- Before the deadline the sweep must not touch it.
  select count(*) into n from public.get_expirable_pos_payments(50) e where e.id = attempt_id;
  if n <> 0 then
    raise exception 'FAIL  9b a payment inside its window was offered for expiry';
  end if;
  raise notice 'PASS  9b a pending payment before its TTL is left alone';

  -- Past the deadline it must be offered.
  update public.pos_payment_attempts set expires_at = now() - interval '1 minute'
   where id = attempt_id;
  select count(*) into n from public.get_expirable_pos_payments(50) e where e.id = attempt_id;
  if n <> 1 then
    raise exception 'FAIL  9c an overdue payment was not offered for expiry';
  end if;
  raise notice 'PASS  9c a pending payment past its TTL is offered for expiry';

  -- The compare-and-set: the winner is told it won.
  select public.mark_pos_payment_state(attempt_id, 'expired', 'swept') into flag;
  if flag is not true then
    raise exception 'FAIL  9d the first writer was not told it won';
  end if;
  select status::text into txt from public.pos_payment_attempts where id = attempt_id;
  if txt <> 'expired' then
    raise exception 'FAIL  9d1 status is % after expiry', txt;
  end if;

  -- A second writer racing the first changes nothing and is told so. This is
  -- what keeps an expiry sweep and a payment webhook from both "succeeding".
  select public.mark_pos_payment_state(attempt_id, 'cancelled', 'racing') into flag;
  if flag is not false then
    raise exception 'FAIL  9e the losing writer was told it won';
  end if;
  select status::text into txt from public.pos_payment_attempts where id = attempt_id;
  if txt <> 'expired' then
    raise exception 'FAIL  9e1 a losing writer changed the status to %', txt;
  end if;
  raise notice 'PASS  9d-e exactly one writer records a terminal outcome';

  -- An expired attempt must never become a sale.
  select count(*) into n from public.pos_sales where checkout_key = key5;
  if n <> 0 then
    raise exception 'FAIL  9f an expired payment produced a sale';
  end if;
  raise notice 'PASS  9f an expired payment creates no sale and no movement';

  -- ======================================================================
  -- 10. Paid is a one-way door
  -- ======================================================================
  --
  -- The CAS already refuses to touch anything that is not pending. The trigger
  -- is the second lock on the same door: no path, present or future, may
  -- rewrite the record of money that actually moved.
  select id into attempt_id from public.pos_payment_attempts where checkout_key = key2;

  begin
    update public.pos_payment_attempts set status = 'expired' where id = attempt_id;
    raise exception 'FAIL 10a a paid payment was expired';
  exception when check_violation then
    raise notice 'PASS 10a a paid payment cannot be expired';
  end;

  begin
    update public.pos_payment_attempts set status = 'cancelled' where id = attempt_id;
    raise exception 'FAIL 10b a paid payment was cancelled';
  exception when check_violation then
    raise notice 'PASS 10b a paid payment cannot be cancelled';
  end;

  -- A paid attempt is never offered to the sweep in the first place.
  update public.pos_payment_attempts set expires_at = now() - interval '1 day'
   where id = attempt_id;
  select count(*) into n from public.get_expirable_pos_payments(50) e where e.id = attempt_id;
  if n <> 0 then
    raise exception 'FAIL 10c a paid payment was offered for expiry';
  end if;
  raise notice 'PASS 10c the sweep never offers a paid payment';

  -- paid_unfulfilled means somebody's money moved but no sale exists. That
  -- needs a refund decision, not a tidy-up.
  select id into attempt2_id from public.pos_payment_attempts where checkout_key = key3;
  begin
    update public.pos_payment_attempts set status = 'cancelled' where id = attempt2_id;
    raise exception 'FAIL 10d a paid-but-unfulfilled payment was cancelled away';
  exception when check_violation then
    raise notice 'PASS 10d a paid-but-unfulfilled payment cannot be tidied away';
  end;

  -- ======================================================================
  -- 11. The browser has no direct route to any of it
  -- ======================================================================
  set local role authenticated;
  begin
    perform public.get_expirable_pos_payments(10);
    raise exception 'FAIL 11a an authenticated caller listed expirable payments';
  exception when insufficient_privilege then
    raise notice 'PASS 11a get_expirable_pos_payments is denied to authenticated';
  when raise_exception then
    if sqlerrm like 'FAIL%' then raise; end if;
    raise notice 'PASS 11a get_expirable_pos_payments is denied to authenticated';
  end;
  reset role;

  -- Cancelling used to be a plain RPC the till called, which marked the attempt
  -- cancelled while the provider session stayed live and payable. That route is
  -- now closed; cancellation goes through the Edge Function, which expires the
  -- session first.
  set local role authenticated;
  begin
    perform public.cancel_pos_payment_attempt(key5);
    raise exception 'FAIL 11b the till could still cancel a payment directly';
  exception when insufficient_privilege then
    raise notice 'PASS 11b the till cannot cancel without going through the server';
  when raise_exception then
    if sqlerrm like 'FAIL%' then raise; end if;
    raise notice 'PASS 11b the till cannot cancel without going through the server';
  end;
  reset role;

  -- The TTL is configurable, but bounded so a bad value cannot expire payments
  -- the instant they are created.
  update public.system_settings set value = '0'::jsonb where key = 'pos_payment_ttl_minutes';
  if public.pos_payment_ttl_minutes() < 1 then
    raise exception 'FAIL 11d a TTL of zero was accepted';
  end if;
  update public.system_settings set value = '99999'::jsonb where key = 'pos_payment_ttl_minutes';
  if public.pos_payment_ttl_minutes() > 1440 then
    raise exception 'FAIL 11e an unbounded TTL was accepted';
  end if;
  update public.system_settings set value = '30'::jsonb where key = 'pos_payment_ttl_minutes';
  raise notice 'PASS 11d-e the TTL is configurable but bounded';


  -- ======================================================================
  -- 12. The till's menu shrank; the database's memory did not
  -- ======================================================================
  --
  -- The cashier can now pick only cash, gcash, paymaya, card and qrph. Sales
  -- taken before that carry 'maya', 'bank' and 'other', and those rows must
  -- stay valid and readable -- receipts, reports and audit all render from
  -- them. So the CHECK stays deliberately wider than the menu.
  for txt in
    select unnest(array['cash', 'gcash', 'maya', 'paymaya', 'card', 'qrph', 'bank', 'other'])
  loop
    begin
      insert into public.pos_sales
        (branch_id, cashier_id, subtotal, fees_total, total_amount, fees,
         payment_method, payment_reference, amount_tendered, change_given,
         total_cogs, branch_name, cashier_name, checkout_key, request_fingerprint)
      values (branch_a, till_user, 1, 0, 1, '[]'::jsonb,
              txt,
              case when txt = 'cash' then null else 'JMAC-POS-LEGACY01' end,
              case when txt = 'cash' then 1 else null end,
              case when txt = 'cash' then 0 else null end,
              0, 'B', 'C', gen_random_uuid(), 'fp-' || txt);
    exception when check_violation then
      raise exception 'FAIL 12a the database rejected the historical method %', txt;
    end;
  end loop;
  raise notice 'PASS 12a every historical payment method is still storable and readable';

  -- The reference validator likewise still understands the retired methods, so
  -- a historical row can still be re-validated if anything replays it.
  if public.validate_pos_payment_reference('maya', '091234567') is null then
    raise exception 'FAIL 12b the validator forgot the legacy maya format';
  end if;
  if public.validate_pos_payment_reference('bank', 'TRF 2026-0001') is null then
    raise exception 'FAIL 12c the validator forgot the legacy bank format';
  end if;
  if public.validate_pos_payment_reference('other', 'anything') is null then
    raise exception 'FAIL 12d the validator forgot the legacy other format';
  end if;
  raise notice 'PASS 12b-d the reference validator still accepts retired methods';

  raise notice '--- all POS payment contract checks passed ---';
end $$;

rollback;

select 'payment attempts after rollback: ' || count(*)::text as verify
from public.pos_payment_attempts;
