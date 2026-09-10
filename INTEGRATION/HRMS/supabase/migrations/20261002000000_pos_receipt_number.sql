-- A receipt number that is actually a receipt number.
--
-- WHAT THE AUDIT FOUND. public.pos_sales has no business reference at all: id,
-- branch, cashier, money, snapshots, checkout_key, created_at, and nothing
-- else. What both the till and the register have been calling "Receipt" is
-- `sale_id.slice(0, 8).toUpperCase()` computed in React -- the first eight hex
-- characters of the primary key. That is a presentation-derived identifier, not
-- a persisted one: it is a fragment of an internal uuid, it is only unique
-- because the uuid is, and nothing in the database has ever agreed to keep it
-- stable or to refuse a collision.
--
-- So one is introduced here. It is the smallest thing that works: one column,
-- one sequence, one BEFORE INSERT trigger.
--
-- WHY A TRIGGER RATHER THAN A CHANGE TO CHECKOUT. Two paths create a sale --
-- `checkout_pos_sale` for cash, and the PayMongo webhook's finalisation for
-- everything else -- and both INSERT into pos_sales. A trigger covers both
-- without either being edited, and it runs inside their transaction, so the
-- number is assigned in the same commit as the sale, its items and the stock
-- movement. A sale cannot exist without a number and a number cannot survive a
-- sale that rolled back.

-- ===========================================================================
-- 1. The counter
-- ===========================================================================
-- A sequence, following seq_purchase_order rather than the count(*) + 1 form
-- used by a few later numbering triggers. count(*) + 1 reads the table it is
-- about to write, so two cashiers finishing at the same instant can read the
-- same count and mint the same number; a sequence is transaction-safe by
-- construction and never hands the same value out twice.
--
-- The cost is that a rolled-back checkout leaves a gap in the numbering. That
-- is the correct trade for a receipt: a missing OR-2026-0007 is an auditable
-- non-event, two sales both calling themselves OR-2026-0007 is not.
create sequence if not exists public.seq_pos_receipt;

-- ===========================================================================
-- 2. The column
-- ===========================================================================
-- Nullable to begin with, because 11 sales already exist and a NOT NULL column
-- with no default cannot be added to a populated table.
alter table public.pos_sales add column if not exists receipt_number text;

comment on column public.pos_sales.receipt_number is
  'The customer-facing receipt reference, e.g. OR-2026-0001. Assigned by '
  'trigger inside the transaction that creates the sale, unique, and never '
  'reissued. Separate from id, which stays the internal key and is never '
  'shown.';

-- ===========================================================================
-- 3. The sales that already happened
-- ===========================================================================
-- Numbered oldest first, so the sequence of receipts matches the sequence of
-- trading. Deterministic: ordered by (created_at, id), which is total -- the
-- id breaks any tie between two sales sharing a microsecond.
--
-- The year comes from each sale's OWN business date, not from today, so a sale
-- rung up in 2026 reads as a 2026 receipt whenever this migration happens to
-- run. Manila, because that is the day the POS trades on.
--
-- Nothing else is touched. No amount, timestamp, payment method, branch,
-- cashier or item is read or written here -- only the column that did not
-- exist a moment ago.
do $$
declare
  _sale record;
begin
  for _sale in
    select id, created_at from public.pos_sales
     where receipt_number is null
     order by created_at, id
  loop
    update public.pos_sales
       set receipt_number =
             'OR-' || to_char(_sale.created_at at time zone public.pos_business_timezone(), 'YYYY')
             || '-' || lpad(nextval('public.seq_pos_receipt')::text, 4, '0')
     where id = _sale.id;
  end loop;
end $$;

-- ===========================================================================
-- 4. The promises
-- ===========================================================================
-- Unique first, then NOT NULL: both are validated against the rows backfilled
-- above, so if the backfill were ever wrong this migration fails here rather
-- than shipping a broken guarantee.
create unique index if not exists pos_sales_receipt_number_key
  on public.pos_sales (receipt_number);

alter table public.pos_sales alter column receipt_number set not null;

-- A receipt number is what the customer was handed. It never changes, and it
-- is never reused -- reissuing one would make two different sales answer to
-- the same reference in an audit.
create or replace function public.freeze_pos_receipt_number()
returns trigger
language plpgsql
security definer
set search_path = ''
as $fn$
begin
  if new.receipt_number is distinct from old.receipt_number then
    raise exception 'A receipt number cannot be changed once the sale is recorded.'
      using errcode = 'insufficient_privilege';
  end if;
  return new;
end;
$fn$;

revoke all on function public.freeze_pos_receipt_number() from public, anon, authenticated;

drop trigger if exists trg_freeze_pos_receipt_number on public.pos_sales;
create trigger trg_freeze_pos_receipt_number
  before update on public.pos_sales
  for each row execute function public.freeze_pos_receipt_number();

-- ===========================================================================
-- 5. Every sale from here on
-- ===========================================================================
-- BEFORE INSERT, so the number is part of the row rather than something added
-- to it afterwards. created_at already carries its default by the time a
-- BEFORE ROW trigger runs; the coalesce covers an explicit null.
create or replace function public.set_pos_receipt_number()
returns trigger
language plpgsql
security definer
set search_path = ''
as $fn$
begin
  if new.receipt_number is null then
    new.receipt_number :=
      'OR-' || to_char(
                 coalesce(new.created_at, now()) at time zone public.pos_business_timezone(),
                 'YYYY')
      || '-' || lpad(nextval('public.seq_pos_receipt')::text, 4, '0');
  end if;
  return new;
end;
$fn$;

revoke all on function public.set_pos_receipt_number() from public, anon, authenticated;

drop trigger if exists trg_set_pos_receipt_number on public.pos_sales;
create trigger trg_set_pos_receipt_number
  before insert on public.pos_sales
  for each row execute function public.set_pos_receipt_number();

-- ===========================================================================
-- 6. Reading it back
-- ===========================================================================
-- The receipt builder both entry points share. Adding the field here is what
-- puts the same number on the till's receipt and on a reprint months later,
-- because `checkout_pos_sale` and `get_sale_detail` both return this.
create or replace function public.pos_sale_receipt(_sale_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $fn$
  select jsonb_build_object(
    'sale_id', s.id,
    'receipt_number', s.receipt_number,
    'created_at', s.created_at,
    'status', s.status,
    'company_name', s.company_name,
    'branch_name', s.branch_name,
    'branch_address', s.branch_address,
    'branch_phone', s.branch_phone,
    'cashier_name', s.cashier_name,
    'items', coalesce((
      select jsonb_agg(jsonb_build_object(
        'product_name', i.product_name,
        'category_name', i.category_name,
        'quantity', i.quantity,
        'unit_price', i.unit_price,
        'line_total', i.line_total
      ) order by i.product_name)
      from public.pos_sale_items i where i.sale_id = s.id
    ), '[]'::jsonb),
    'subtotal', s.subtotal,
    'fees', s.fees,
    'fees_total', s.fees_total,
    'total_amount', s.total_amount,
    'payment_method', s.payment_method,
    'payment_reference', s.payment_reference,
    'amount_tendered', s.amount_tendered,
    'change_given', s.change_given
  )
  from public.pos_sales s
  where s.id = _sale_id;
$fn$;

-- ---------------------------------------------------------------------------
-- The register
-- ---------------------------------------------------------------------------
-- Dropped and recreated rather than replaced: adding a column to a RETURNS
-- TABLE changes the return type, which CREATE OR REPLACE refuses. Bodies and
-- authorization are otherwise identical -- the same three WHERE clauses decide
-- who sees what, and none of them moved.
drop function if exists public.get_my_transactions(timestamptz, timestamptz, integer, integer);
drop function if exists public.get_branch_transactions(uuid, timestamptz, timestamptz, integer, integer);
drop function if exists public.get_admin_transactions(uuid, timestamptz, timestamptz, integer, integer);

create or replace function public.get_my_transactions(
  _from timestamptz default null,
  _to timestamptz default null,
  _limit integer default 25,
  _offset integer default 0
)
returns table (
  sale_id uuid,
  receipt_number text,
  created_at timestamptz,
  status public.pos_sale_status,
  branch_id uuid,
  branch_name text,
  cashier_name text,
  item_count integer,
  subtotal numeric,
  fees_total numeric,
  total_amount numeric,
  payment_method text,
  payment_reference text,
  amount_tendered numeric,
  change_given numeric,
  total_count bigint
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    s.id, s.receipt_number, s.created_at, s.status, s.branch_id, s.branch_name, s.cashier_name,
    (select coalesce(sum(i.quantity), 0)::integer
       from public.pos_sale_items i where i.sale_id = s.id),
    s.subtotal, s.fees_total, s.total_amount,
    s.payment_method, s.payment_reference, s.amount_tendered, s.change_given,
    count(*) over ()
  from public.pos_sales s
  -- The whole rule, and it is not a filter the caller supplies.
  where s.cashier_id = (select auth.uid())
    and (_from is null or s.created_at >= _from)
    and (_to is null or s.created_at <= _to)
  order by s.created_at desc
  limit public.pos_page_size(_limit)
  offset greatest(0, coalesce(_offset, 0));
$$;

create or replace function public.get_branch_transactions(
  _branch_id uuid,
  _from timestamptz default null,
  _to timestamptz default null,
  _limit integer default 25,
  _offset integer default 0
)
returns table (
  sale_id uuid,
  receipt_number text,
  created_at timestamptz,
  status public.pos_sale_status,
  branch_id uuid,
  branch_name text,
  cashier_name text,
  item_count integer,
  subtotal numeric,
  fees_total numeric,
  total_amount numeric,
  payment_method text,
  payment_reference text,
  amount_tendered numeric,
  change_given numeric,
  total_count bigint
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    s.id, s.receipt_number, s.created_at, s.status, s.branch_id, s.branch_name, s.cashier_name,
    (select coalesce(sum(i.quantity), 0)::integer
       from public.pos_sale_items i where i.sale_id = s.id),
    s.subtotal, s.fees_total, s.total_amount,
    s.payment_method, s.payment_reference, s.amount_tendered, s.change_given,
    count(*) over ()
  from public.pos_sales s
  where s.branch_id = _branch_id
    -- Manager at THIS branch. A manager assignment elsewhere grants nothing
    -- here, which is what keeps "Manager at A, Cashier at B" honest.
    and public.has_pos_role(_branch_id, array['manager']::public.pos_role[])
    and (_from is null or s.created_at >= _from)
    and (_to is null or s.created_at <= _to)
  order by s.created_at desc
  limit public.pos_page_size(_limit)
  offset greatest(0, coalesce(_offset, 0));
$$;

create or replace function public.get_admin_transactions(
  _branch_id uuid default null,
  _from timestamptz default null,
  _to timestamptz default null,
  _limit integer default 25,
  _offset integer default 0
)
returns table (
  sale_id uuid,
  receipt_number text,
  created_at timestamptz,
  status public.pos_sale_status,
  branch_id uuid,
  branch_name text,
  cashier_name text,
  item_count integer,
  subtotal numeric,
  fees_total numeric,
  total_amount numeric,
  payment_method text,
  payment_reference text,
  amount_tendered numeric,
  change_given numeric,
  total_count bigint
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    s.id, s.receipt_number, s.created_at, s.status, s.branch_id, s.branch_name, s.cashier_name,
    (select coalesce(sum(i.quantity), 0)::integer
       from public.pos_sale_items i where i.sale_id = s.id),
    s.subtotal, s.fees_total, s.total_amount,
    s.payment_method, s.payment_reference, s.amount_tendered, s.change_given,
    count(*) over ()
  from public.pos_sales s
  where public.is_admin()
    and (_branch_id is null or s.branch_id = _branch_id)
    and (_from is null or s.created_at >= _from)
    and (_to is null or s.created_at <= _to)
  order by s.created_at desc
  limit public.pos_page_size(_limit)
  offset greatest(0, coalesce(_offset, 0));
$$;

-- This database has an ALTER DEFAULT PRIVILEGES rule granting every new routine
-- in public to anon and authenticated, and PostgreSQL grants PUBLIC EXECUTE
-- besides. These were dropped and recreated, so the grants are stated again
-- rather than assumed -- exactly as the migration that last touched them did.
revoke all on function public.get_my_transactions(timestamptz, timestamptz, integer, integer) from public, anon;
revoke all on function public.get_branch_transactions(uuid, timestamptz, timestamptz, integer, integer) from public, anon;
revoke all on function public.get_admin_transactions(uuid, timestamptz, timestamptz, integer, integer) from public, anon;
grant execute on function public.get_my_transactions(timestamptz, timestamptz, integer, integer) to authenticated;
grant execute on function public.get_branch_transactions(uuid, timestamptz, timestamptz, integer, integer) to authenticated;
grant execute on function public.get_admin_transactions(uuid, timestamptz, timestamptz, integer, integer) to authenticated;
