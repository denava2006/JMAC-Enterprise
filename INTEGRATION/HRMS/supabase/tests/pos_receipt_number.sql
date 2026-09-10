-- POS receipt numbering — database contract test.
--
-- What the till and the register call "Receipt" used to be the first eight
-- characters of the sale's uuid, computed in the browser. This suite is about
-- the thing that replaced it: one persisted number per sale, assigned by the
-- database inside the transaction that creates the sale, unique, and never
-- reissued.
--
-- Run:
--   docker exec -i supabase_db_harmony-suite psql -U postgres -d postgres \
--     -v ON_ERROR_STOP=1 -f - < supabase/tests/pos_receipt_number.sql
--
-- One transaction, rolled back at the end. Nothing is written.
-- Concurrency across SESSIONS cannot be shown inside one transaction; what is
-- shown here is the property that makes it safe -- the number comes from a
-- sequence, which never returns a value twice.

begin;

do $$
declare
  _branch uuid;
  _cashier uuid;
  _sale uuid;
  _other uuid;
  _n text;
  _n2 text;
  _before bigint;
  _count integer;
begin
  select id into _branch from public.branches limit 1;
  select id into _cashier from public.profiles limit 1;
  if _branch is null or _cashier is null then
    raise exception 'fixture: need a branch and a profile';
  end if;

  -- =======================================================================
  -- 1. A completed sale is given a number, by the database
  -- =======================================================================
  insert into public.pos_sales
    (branch_id, cashier_id, status, subtotal, fees_total, total_amount, fees,
     payment_method, amount_tendered, change_given, total_cogs,
     branch_name, cashier_name, checkout_key, request_fingerprint)
  values (_branch, _cashier, 'completed', 100, 0, 100, '[]'::jsonb,
          'cash', 200, 100, 0, 'ZZ Branch', 'ZZ Cashier', gen_random_uuid(), 'zz-rn-1')
  returning id, receipt_number into _sale, _n;

  if _n is null then raise exception 'FAIL 1 a sale was created with no receipt number'; end if;
  raise notice 'PASS  1 a completed sale is given a receipt number by the database';

  -- The format the business reads, and the year is the sale's own.
  if _n !~ '^OR-[0-9]{4}-[0-9]{4,}$' then
    raise exception 'FAIL 2 the receipt number does not read as one: %', _n;
  end if;
  if left(_n, 7) <> 'OR-' || to_char(now() at time zone public.pos_business_timezone(), 'YYYY') then
    raise exception 'FAIL 2 the receipt number carries the wrong year: %', _n;
  end if;
  raise notice 'PASS  2 it reads OR-YYYY-NNNN, on the POS business year';

  -- =======================================================================
  -- 3. It is not the primary key, and does not contain it
  -- =======================================================================
  -- The whole point: the customer-facing reference is its own value, not a
  -- slice of an internal identifier.
  if _n = _sale::text or position(left(_sale::text, 8) in lower(_n)) > 0 then
    raise exception 'FAIL 3 the receipt number is derived from the uuid: % / %', _n, _sale;
  end if;
  raise notice 'PASS  3 it is separate from the sale uuid, not a slice of it';

  -- =======================================================================
  -- 4. Two sales never share one
  -- =======================================================================
  insert into public.pos_sales
    (branch_id, cashier_id, status, subtotal, fees_total, total_amount, fees,
     payment_method, amount_tendered, change_given, total_cogs,
     branch_name, cashier_name, checkout_key, request_fingerprint)
  values (_branch, _cashier, 'completed', 50, 0, 50, '[]'::jsonb,
          'cash', 50, 0, 0, 'ZZ Branch', 'ZZ Cashier', gen_random_uuid(), 'zz-rn-2')
  returning id, receipt_number into _other, _n2;

  if _n2 = _n then raise exception 'FAIL 4 two sales share a receipt number'; end if;
  raise notice 'PASS  4 a second sale gets a different number';

  select count(*)::integer into _count
  from (select receipt_number from public.pos_sales group by receipt_number having count(*) > 1) d;
  if _count > 0 then raise exception 'FAIL 4 % receipt numbers are duplicated', _count; end if;
  raise notice 'PASS  4b no receipt number in the table is duplicated';

  -- The uniqueness is promised, not merely observed.
  begin
    update public.pos_sales set receipt_number = _n where id = _other;
    raise exception 'FAIL 5 a duplicate receipt number was accepted';
  exception
    when unique_violation then
      raise notice 'PASS  5 a duplicate is refused by the database';
    when insufficient_privilege then
      raise notice 'PASS  5 a duplicate cannot even be attempted -- the number is frozen';
  end;

  -- =======================================================================
  -- 6. Concurrency safety, at its root
  -- =======================================================================
  -- Two cashiers finishing together is a sequence question, and a sequence
  -- answers it: nextval never returns the same value twice, whoever asks and
  -- whenever. count(*) + 1 -- the other numbering form in this codebase --
  -- could not make that promise, because two transactions can read the same
  -- count before either has written.
  _before := (select last_value from public.seq_pos_receipt);
  if (select nextval('public.seq_pos_receipt')) <= _before then
    raise exception 'FAIL 6 the sequence handed back a value it had already given';
  end if;
  raise notice 'PASS  6 numbering comes from a sequence, which never repeats a value';

  -- =======================================================================
  -- 7. A number outlives nothing it should
  -- =======================================================================
  begin
    update public.pos_sales set receipt_number = 'OR-2099-0001' where id = _sale;
    raise exception 'FAIL 7 a receipt number was rewritten';
  exception when insufficient_privilege then
    raise notice 'PASS  7 a receipt number cannot be changed once the sale exists';
  end;

  -- An ordinary update to the sale must not trip that guard. Deliberately a
  -- no-op write rather than a real field change: a cash sale may not carry a
  -- payment_reference (pos_sales_cash_has_tender), and the point here is only
  -- that the freeze trigger fires and lets an untouched number through.
  update public.pos_sales set cashier_name = cashier_name where id = _sale;
  if (select receipt_number from public.pos_sales where id = _sale) <> _n then
    raise exception 'FAIL 7 an unrelated update changed the receipt number';
  end if;
  raise notice 'PASS  7b an unrelated update to the sale leaves it alone';

  -- =======================================================================
  -- 8. The receipt both screens read carries it
  -- =======================================================================
  if (public.pos_sale_receipt(_sale) ->> 'receipt_number') is distinct from _n then
    raise exception 'FAIL 8 the shared receipt builder does not carry the number';
  end if;
  raise notice 'PASS  8 pos_sale_receipt carries it, so the till and a reprint agree';

  -- And the snapshots it has always carried are still there.
  if (public.pos_sale_receipt(_sale) ->> 'branch_name') is null
     or (public.pos_sale_receipt(_sale) ->> 'total_amount') is null
     or (public.pos_sale_receipt(_sale) ->> 'cashier_name') is null then
    raise exception 'FAIL 9 the receipt lost a snapshot field';
  end if;
  raise notice 'PASS  9 the sale snapshots on the receipt are unchanged';

  -- =======================================================================
  -- 10. Every sale that already existed has one
  -- =======================================================================
  select count(*)::integer into _count from public.pos_sales where receipt_number is null;
  if _count > 0 then raise exception 'FAIL 10 % sales have no receipt number', _count; end if;
  raise notice 'PASS  10 no sale anywhere is without a receipt number';

  raise notice '--------------------------------------------------';
  raise notice 'pos_receipt_number: all checks passed';
end $$;

rollback;
