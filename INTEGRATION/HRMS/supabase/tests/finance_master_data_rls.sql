-- FMS F2 — Finance master data, database contract test.
--
-- The role matrix in docs/fms-authorization.md, checked against the database
-- rather than against the navigation. Every denial here is a denial for a
-- signed-in account that has a real session and a real finance privilege --
-- the interesting failures are never anonymous ones.
--
-- Run:
--   docker exec -i supabase_db_harmony-suite psql -U postgres -d postgres \
--     -v ON_ERROR_STOP=1 -f - < supabase/tests/finance_master_data_rls.sql
--
-- One transaction, rolled back at the end. Nothing is written.

begin;

create or replace function pg_temp.acts_as(_uid uuid) returns void
language sql as $$
  select set_config('request.jwt.claims',
    json_build_object('sub', _uid, 'role', 'authenticated')::text, true);
$$;

/** Hire somebody into a position and give them a login. */
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
  admin_id  uuid;
  staff     uuid;
  manager   uuid;
  acct      uuid;
  hr        uuid;
  cashier   uuid;
  cat_id    uuid;
  vendor_id uuid;
  budget_id uuid;
  alloc_id  uuid;
  other_id  uuid;
  n         integer;
  num       numeric;
  tag       text := left(replace(gen_random_uuid()::text, '-', ''), 8);
begin
  select id into admin_id from public.profiles where role='admin' and status='active' limit 1;
  if admin_id is null then raise exception 'fixture: need an active administrator'; end if;

  staff   := pg_temp.hire('Fin Staff',   'Finance Staff');
  manager := pg_temp.hire('Fin Manager', 'Finance Manager');
  acct    := pg_temp.hire('Fin Acct',    'Accountant');
  hr      := pg_temp.hire('HR Person',   'HR Staff');
  cashier := pg_temp.hire('Till Person', 'Cashier');

  -- ======================================================================
  -- 1. Who may look at Finance master data at all
  -- ======================================================================
  perform pg_temp.acts_as(staff);
  set local role authenticated;
  select count(*) into n from public.finance_categories;
  if n = 0 then raise exception 'FAIL 1a Finance Staff sees no categories'; end if;
  reset role;

  perform pg_temp.acts_as(manager); set local role authenticated;
  select count(*) into n from public.finance_categories;
  if n = 0 then raise exception 'FAIL 1b Finance Manager sees no categories'; end if;
  reset role;

  perform pg_temp.acts_as(acct); set local role authenticated;
  select count(*) into n from public.finance_categories;
  if n = 0 then raise exception 'FAIL 1c the Accountant sees no categories'; end if;
  reset role;

  -- Oversight, and it is explicit rather than incidental.
  perform pg_temp.acts_as(admin_id); set local role authenticated;
  select count(*) into n from public.finance_categories;
  if n = 0 then raise exception 'FAIL 1d the Administrator cannot read Finance'; end if;
  reset role;
  raise notice 'PASS  1a-d the three finance roles read master data, and so does the Administrator';

  -- HR and POS hold no finance access whatsoever.
  perform pg_temp.acts_as(hr); set local role authenticated;
  select count(*) into n from public.finance_categories;
  if n <> 0 then raise exception 'FAIL 1e HR read % finance categories', n; end if;
  select count(*) into n from public.vendors;
  if n <> 0 then raise exception 'FAIL 1e HR read the vendor list'; end if;
  select count(*) into n from public.budgets;
  if n <> 0 then raise exception 'FAIL 1e HR read the budgets'; end if;
  reset role;

  perform pg_temp.acts_as(cashier); set local role authenticated;
  select count(*) into n from public.finance_accounts;
  if n <> 0 then raise exception 'FAIL 1f a cashier read the chart of accounts'; end if;
  reset role;
  raise notice 'PASS  1e-f HR and POS staff read no Finance master data at all';

  -- anon is refused by the grant, before any policy is consulted.
  begin
    set local role anon;
    perform 1 from public.vendors limit 1;
    raise exception 'FAIL 1g anon reached the vendor list';
  exception when insufficient_privilege then
    reset role;
    raise notice 'PASS  1g anon is refused by the table grant, not merely by a policy';
  end;
  reset role;

  -- ======================================================================
  -- 2. finance_categories — Staff curate, the Manager archives
  -- ======================================================================
  perform pg_temp.acts_as(staff); set local role authenticated;
  insert into public.finance_categories (name, kind, description)
  values ('ZZ Packaging ' || tag, 'expense', 'test') returning id into cat_id;
  update public.finance_categories set description = 'edited' where id = cat_id;
  raise notice 'PASS  2a Finance Staff create and edit categories';

  begin
    update public.finance_categories set is_active = false where id = cat_id;
    raise exception 'FAIL 2b Finance Staff archived a category';
  exception when insufficient_privilege then
    raise notice 'PASS  2b Finance Staff cannot archive a category';
  end;
  reset role;

  perform pg_temp.acts_as(acct); set local role authenticated;
  begin
    insert into public.finance_categories (name, kind) values ('ZZ Nope ' || tag, 'expense');
    raise exception 'FAIL 2c the Accountant created a category';
  exception when insufficient_privilege then
    raise notice 'PASS  2c the Accountant reads the taxonomy but does not shape it';
  end;
  reset role;

  perform pg_temp.acts_as(admin_id); set local role authenticated;
  begin
    insert into public.finance_categories (name, kind) values ('ZZ Admin ' || tag, 'expense');
    raise exception 'FAIL 2d the Administrator created a finance category';
  exception when insufficient_privilege then
    raise notice 'PASS  2d the Administrator has oversight, not authorship';
  end;
  reset role;

  perform pg_temp.acts_as(manager); set local role authenticated;
  update public.finance_categories set is_active = false where id = cat_id;
  get diagnostics n = row_count;
  if n <> 1 then raise exception 'FAIL 2e the Finance Manager could not archive'; end if;
  update public.finance_categories set is_active = true where id = cat_id;
  raise notice 'PASS  2e the Finance Manager archives a category';
  reset role;

  -- ======================================================================
  -- 3. vendors, and what each one supplies
  -- ======================================================================
  perform pg_temp.acts_as(staff); set local role authenticated;
  insert into public.vendors (name, contact_person, tin)
  values ('ZZ Supplier ' || tag, 'Test Contact', '000000000000') returning id into vendor_id;
  insert into public.vendor_categories (vendor_id, finance_category_id) values (vendor_id, cat_id);
  raise notice 'PASS  3a Finance Staff keep the vendor list and what each vendor supplies';

  begin
    update public.vendors set is_active = false where id = vendor_id;
    raise exception 'FAIL 3b Finance Staff retired a vendor';
  exception when insufficient_privilege then
    raise notice 'PASS  3b retiring a vendor the company has dealt with is the Manager''s';
  end;
  reset role;

  perform pg_temp.acts_as(acct); set local role authenticated;
  begin
    insert into public.vendors (name) values ('ZZ Acct Vendor ' || tag);
    raise exception 'FAIL 3c the Accountant created a vendor';
  exception when insufficient_privilege then
    raise notice 'PASS  3c the Accountant does not curate suppliers';
  end;
  reset role;

  -- ======================================================================
  -- 4. finance_accounts — the chart of accounts has one owner
  -- ======================================================================
  perform pg_temp.acts_as(acct); set local role authenticated;
  insert into public.finance_accounts (name, account_type, account_subtype, account_code)
  values ('ZZ Cash on Hand ' || tag, 'asset', 'cash', 'ZZ-' || tag);
  -- The two rows later phases need, expressible today.
  insert into public.finance_accounts (name, account_type, account_subtype)
  values ('ZZ PayMongo Receivable ' || tag, 'asset', 'receivable');
  insert into public.finance_accounts (name, account_type, account_subtype)
  values ('ZZ Payroll Payable ' || tag, 'liability', 'payable');
  raise notice 'PASS  4a the Accountant owns the chart, and it can express a receivable and a payable';

  begin
    insert into public.finance_accounts (name, account_type, account_subtype)
    values ('ZZ Wrong ' || tag, 'asset', 'payable');
    raise exception 'FAIL 4b an asset was filed as a payable';
  exception when check_violation then
    raise notice 'PASS  4b the statement side and the instrument must agree';
  end;

  begin
    insert into public.finance_accounts (name, account_type, account_subtype, opening_balance)
    values ('ZZ Undated ' || tag, 'asset', 'bank', 50000);
    raise exception 'FAIL 4c an opening balance was accepted with no date';
  exception when check_violation then
    raise notice 'PASS  4c an opening balance without a date is refused';
  end;
  reset role;

  perform pg_temp.acts_as(manager); set local role authenticated;
  begin
    insert into public.finance_accounts (name, account_type, account_subtype)
    values ('ZZ Mgr Account ' || tag, 'asset', 'bank');
    raise exception 'FAIL 4d the Finance Manager opened a ledger account';
  exception when insufficient_privilege then
    raise notice 'PASS  4d the Finance Manager cannot gain the Accountant''s authority';
  end;
  reset role;

  perform pg_temp.acts_as(staff); set local role authenticated;
  begin
    insert into public.finance_accounts (name, account_type, account_subtype)
    values ('ZZ Staff Account ' || tag, 'asset', 'bank');
    raise exception 'FAIL 4e Finance Staff opened a ledger account';
  exception when insufficient_privilege then
    raise notice 'PASS  4e Finance Staff cannot open a ledger account';
  end;
  reset role;

  perform pg_temp.acts_as(admin_id); set local role authenticated;
  begin
    insert into public.finance_accounts (name, account_type, account_subtype)
    values ('ZZ Admin Account ' || tag, 'asset', 'bank');
    raise exception 'FAIL 4f the Administrator opened a ledger account';
  exception when insufficient_privilege then
    raise notice 'PASS  4f the Administrator cannot open a ledger account';
  end;
  reset role;

  -- ======================================================================
  -- 5. budgets — the ceiling belongs to the Finance Manager
  -- ======================================================================
  perform pg_temp.acts_as(manager); set local role authenticated;
  insert into public.budgets (name, finance_category_id, amount, status, fiscal_year)
  values ('ZZ Ops Budget ' || tag, cat_id, 100000, 'active', 2026) returning id into budget_id;
  raise notice 'PASS  5a the Finance Manager sets a ceiling';
  reset role;

  perform pg_temp.acts_as(staff); set local role authenticated;
  begin
    insert into public.budgets (name, amount, status) values ('ZZ Staff Budget ' || tag, 5000, 'active');
    raise exception 'FAIL 5b Finance Staff set a ceiling';
  exception when insufficient_privilege then
    raise notice 'PASS  5b Finance Staff cannot perform a Manager-only mutation';
  end;
  begin
    update public.budgets set amount = 999999 where id = budget_id;
    get diagnostics n = row_count;
    if n <> 0 then raise exception 'FAIL 5c Finance Staff raised a ceiling'; end if;
    raise notice 'PASS  5c Finance Staff cannot raise a ceiling';
  end;
  reset role;

  perform pg_temp.acts_as(acct); set local role authenticated;
  begin
    insert into public.budgets (name, amount, status) values ('ZZ Acct Budget ' || tag, 5000, 'active');
    raise exception 'FAIL 5d the Accountant set a ceiling';
  exception when insufficient_privilege then
    raise notice 'PASS  5d the Accountant cannot gain Manager authority';
  end;
  reset role;

  perform pg_temp.acts_as(admin_id); set local role authenticated;
  begin
    insert into public.budgets (name, amount, status) values ('ZZ Admin Budget ' || tag, 5000, 'active');
    raise exception 'FAIL 5e the Administrator set a ceiling';
  exception when insufficient_privilege then
    raise notice 'PASS  5e no routine amount-setting by the Administrator';
  end;
  reset role;

  -- ======================================================================
  -- 6. budget_allocations — drawn by Staff, released by the Manager
  -- ======================================================================
  perform pg_temp.acts_as(staff); set local role authenticated;
  insert into public.budget_allocations (budget_id, amount, allocated_to)
  values (budget_id, 30000, 'ZZ Branch A refit') returning id into alloc_id;
  update public.budget_allocations set note = 'corrected' where id = alloc_id;
  get diagnostics n = row_count;
  if n <> 1 then raise exception 'FAIL 6a Finance Staff could not correct their own draw'; end if;
  raise notice 'PASS  6a Finance Staff draw against a ceiling and correct their own draw';

  begin
    insert into public.budget_allocations (budget_id, amount, allocated_to)
    values (budget_id, 80000, 'ZZ Over the top');
    raise exception 'FAIL 6b an allocation exceeded the approved ceiling';
  exception when check_violation then
    raise notice 'PASS  6b the ceiling is a ceiling -- over-allocation is refused';
  end;

  begin
    update public.budget_allocations
       set status = 'released', released_at = now() where id = alloc_id;
    raise exception 'FAIL 6c Finance Staff released an allocation';
  exception when insufficient_privilege then
    raise notice 'PASS  6c releasing returns money to the ceiling, so it is the Manager''s';
  end;
  reset role;

  -- A draw belonging to somebody else is not theirs to correct.
  perform pg_temp.acts_as(manager); set local role authenticated;
  insert into public.budget_allocations (budget_id, amount, allocated_to)
  values (budget_id, 10000, 'ZZ Manager draw') returning id into other_id;
  reset role;

  perform pg_temp.acts_as(staff); set local role authenticated;
  update public.budget_allocations set note = 'not mine' where id = other_id;
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'FAIL 6d Finance Staff edited another person''s allocation'; end if;
  raise notice 'PASS  6d Finance Staff cannot edit an allocation that is not theirs';
  reset role;

  perform pg_temp.acts_as(acct); set local role authenticated;
  begin
    insert into public.budget_allocations (budget_id, amount, allocated_to)
    values (budget_id, 100, 'ZZ Accountant draw');
    raise exception 'FAIL 6e the Accountant drew against a budget';
  exception when insufficient_privilege then
    raise notice 'PASS  6e the Accountant does not draw against budgets';
  end;
  reset role;

  -- ======================================================================
  -- 7. The four numbers, and the two that have no source yet
  -- ======================================================================
  perform pg_temp.acts_as(manager); set local role authenticated;
  select allocated into num from public.budget_status where id = budget_id;
  if num <> 40000 then raise exception 'FAIL 7a allocated reads %, expected 40000', num; end if;

  select reserved into num from public.budget_status where id = budget_id;
  if num <> 0 then raise exception 'FAIL 7b reserved invented a number'; end if;
  select spent into num from public.budget_status where id = budget_id;
  if num <> 0 then raise exception 'FAIL 7b spent invented a number'; end if;
  select unallocated into num from public.budget_status where id = budget_id;
  if num <> 60000 then raise exception 'FAIL 7c unallocated reads %, expected 60000', num; end if;
  raise notice 'PASS  7a-c allocated is derived, unallocated follows, reserved and spent claim nothing';

  -- Releasing returns the money to the ceiling.
  update public.budget_allocations
     set status = 'released', released_at = now(), released_by = manager where id = other_id;
  select allocated into num from public.budget_status where id = budget_id;
  if num <> 30000 then raise exception 'FAIL 7d a released allocation still counts'; end if;
  raise notice 'PASS  7d a released allocation returns to the ceiling';

  -- A closed ceiling is closed.
  update public.budgets set status = 'closed' where id = budget_id;
  begin
    update public.budgets set amount = 500000 where id = budget_id;
    raise exception 'FAIL 7e a closed budget''s amount was changed';
  exception when check_violation then
    raise notice 'PASS  7e a closed budget''s approved amount cannot be changed';
  end;

  begin
    insert into public.budget_allocations (budget_id, amount, allocated_to)
    values (budget_id, 100, 'ZZ After close');
    raise exception 'FAIL 7f something was drawn against a closed budget';
  exception when check_violation then
    raise notice 'PASS  7f nothing can be drawn against a budget that is not active';
  end;
  reset role;

  -- ======================================================================
  -- 8. The actor is the session, not the payload
  -- ======================================================================
  perform pg_temp.acts_as(staff); set local role authenticated;
  insert into public.vendors (name, created_by) values ('ZZ Forged ' || tag, admin_id)
  returning id into other_id;
  select created_by into other_id from public.vendors where id = other_id;
  if other_id <> staff then
    raise exception 'FAIL 8a created_by was taken from the payload';
  end if;
  raise notice 'PASS  8a created_by is stamped from the session, not accepted from the caller';
  reset role;

  -- ======================================================================
  -- 9. Revoking finance privilege removes Finance master data with it
  -- ======================================================================
  perform pg_temp.acts_as(admin_id);
  perform public.close_finance_privilege(staff, 'contract test revoke');

  perform pg_temp.acts_as(staff); set local role authenticated;
  select count(*) into n from public.finance_categories;
  if n <> 0 then raise exception 'FAIL 9a a revoked account still reads finance master data'; end if;
  begin
    insert into public.vendors (name) values ('ZZ Revoked ' || tag);
    raise exception 'FAIL 9b a revoked account still writes finance master data';
  exception when insufficient_privilege then
    raise notice 'PASS  9a-b a manual revoke removes Finance access, read and write';
  end;
  reset role;
end $$;

rollback;
