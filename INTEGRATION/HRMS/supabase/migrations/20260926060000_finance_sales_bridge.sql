-- ===========================================================================
-- F5.5  POS Sales  ->  Finance Sales & Collections
-- ===========================================================================
--
-- POS owns the sale. Finance reads its financial consequence. That sentence is
-- the whole design, and everything below exists to keep it true.
--
-- WHAT THE AUDIT FOUND, because it decided the shape of this file:
--
--   * pos_sale_status has exactly one value: 'completed'. A pos_sales row is
--     not a sale with a status to interpret -- the row IS the sale-complete
--     fact. Cash sales insert it through checkout_pos_sale(). Online sales
--     insert it only through finalize_pos_payment(), which is service_role-only
--     and runs from the HMAC-verified PayMongo webhook.
--
--   * finalize_pos_payment() sets pos_payment_attempts.sale_id on exactly one
--     branch: the one where status becomes 'paid'. Every paid_unfulfilled
--     branch -- amount_mismatch, repricing_failed, price_changed,
--     checkout_failed, no_sale_id -- returns without creating a sale.
--
--   So reading pos_sales already excludes abandoned checkouts, failed,
--   expired and cancelled attempts, and paid_unfulfilled. There is no second
--   'completed' flag to invent, and no status list for Finance to maintain in
--   parallel with POS. Finance asks POS one question: is there a sale row?
--
--   * pos_sales has no discount column, and no void or refund status. It has
--     subtotal, fees_total and total_amount, with a CHECK constraint holding
--     total_amount = subtotal + fees_total. Fees ADD to what the customer
--     pays; they are not a deduction. Discounts and refunds are therefore
--     reported as zero here because POS does not model them -- not because
--     they happened to be zero today. The UI says so in those words.
--
-- WHAT THIS FILE DELIBERATELY DOES NOT DO:
--
--   No table. Nothing here copies a sale into a Finance-owned row that could
--   drift from its origin, and there is no write path of any kind -- these are
--   three read functions over the POS tables. Budget, AP and inventory are
--   untouched because nothing here can touch them.
--
--   No journals, no ledger, no settlement. A successful PayMongo payment is
--   the customer paying JMAC; it is not PayMongo settling to JMAC's bank. This
--   phase reports collections by method and says plainly that settlement is
--   not integrated.
--
-- Finance never recomputes a different business definition from POS. Every
-- figure below is the same expression the POS reports already use, over the
-- same rows, inside the same Philippine business-day bounds:
--
--   POS get_pos_manager_report_summary   Finance
--   ----------------------------------   ---------------------------------
--   product_sales   sum(subtotal)        Gross Sales, and Net Sales
--   fees_collected  sum(fees_total)      Fees collected
--   sales_collected sum(total_amount)    Total Collected
--
--   Gross Sales - Discounts - Refunds = Net Sales, with both subtrahends
--   structurally zero, so Net Sales = sum(subtotal) = the POS product_sales
--   for the same branch and dates. That is the reconciliation, and it holds by
--   construction rather than by agreement.

-- ---------------------------------------------------------------------------
-- 1. The window Finance reports over
-- ---------------------------------------------------------------------------
--
-- Not a new date rule. pos_report_bounds() resolves a pair of local dates into
-- the half-open timestamptz range [day_start, day_end) using
-- pos_business_timezone(), and it is what every POS report already uses. A
-- second implementation here is how "Today" ends up meaning two different
-- things in two parts of one enterprise -- particularly in Manila, where UTC
-- midnight falls at 08:00 local and a naive ::date would move the whole
-- morning's takings into the previous business day.
--
-- It also carries the range guards (start <= end, at most 366 days), so a
-- Finance caller cannot ask for a scan POS would have refused.

-- ---------------------------------------------------------------------------
-- 2. Summary
-- ---------------------------------------------------------------------------
create or replace function public.get_finance_sales_summary(
  _from_date date default null,
  _to_date date default null,
  _branch_id uuid default null,
  _payment_method text default null,
  _cashier_id uuid default null
)
returns table (
  date_from date,
  date_to date,
  gross_sales numeric,
  discounts numeric,
  refunds numeric,
  net_sales numeric,
  fees_collected numeric,
  total_collected numeric,
  transaction_count integer,
  items_sold integer,
  average_sale numeric
)
language sql
stable
security definer
set search_path = ''
as $fn$
  select
    b.date_from,
    b.date_to,
    s.gross_sales,
    -- Zero because POS models neither, and Finance will not invent a number
    -- the source cannot produce. Both are named in the return so the shape is
    -- already right on the day POS grows a discount or a void.
    0::numeric as discounts,
    0::numeric as refunds,
    s.gross_sales as net_sales,
    s.fees_collected,
    s.total_collected,
    s.transaction_count,
    i.items_sold,
    round(s.total_collected / nullif(s.transaction_count, 0), 2)
  from public.pos_report_bounds(_from_date, _to_date) b
  left join lateral (
    select
      coalesce(sum(x.subtotal), 0)::numeric as gross_sales,
      coalesce(sum(x.fees_total), 0)::numeric as fees_collected,
      coalesce(sum(x.total_amount), 0)::numeric as total_collected,
      count(*)::integer as transaction_count
    from public.pos_sales x
    where public.can_read_finance_master()
      and x.status = 'completed'
      and x.created_at >= b.period_start
      and x.created_at < b.period_end
      -- null means enterprise-wide, which is Finance's remit. It does not
      -- widen anybody's POS access: this runs security definer over a gate
      -- no cashier passes.
      and (_branch_id is null or x.branch_id = _branch_id)
      and (_payment_method is null or x.payment_method = _payment_method)
      and (_cashier_id is null or x.cashier_id = _cashier_id)
  ) s on true
  left join lateral (
    select coalesce(sum(li.quantity), 0)::integer as items_sold
    from public.pos_sales sale
    join public.pos_sale_items li on li.sale_id = sale.id
    where public.can_read_finance_master()
      and sale.status = 'completed'
      and sale.created_at >= b.period_start
      and sale.created_at < b.period_end
      and (_branch_id is null or sale.branch_id = _branch_id)
      and (_payment_method is null or sale.payment_method = _payment_method)
      and (_cashier_id is null or sale.cashier_id = _cashier_id)
  ) i on true
  where public.can_read_finance_master();
$fn$;

comment on function public.get_finance_sales_summary(date, date, uuid, text, uuid) is
  'Finance read of authoritative completed POS sales. Net Sales = sum(subtotal), '
  'reconciling exactly with the POS report product_sales for the same branch and '
  'dates. Discounts and refunds are zero because POS models neither.';

-- ---------------------------------------------------------------------------
-- 3. Collections by payment method
-- ---------------------------------------------------------------------------
--
-- sum(total_amount) per method, grouped and ordered exactly as
-- get_pos_manager_report_payment_totals does, so the two reports agree line for
-- line and not merely in total.
--
-- The method returned is pos_sales.payment_method: the server-authoritative
-- column a CHECK constraint governs, written by checkout_pos_sale from the
-- payment that actually completed. Never a button label, and never the client's
-- idea of what it chose.
create or replace function public.get_finance_sales_collections(
  _from_date date default null,
  _to_date date default null,
  _branch_id uuid default null,
  _payment_method text default null,
  _cashier_id uuid default null
)
returns table (
  payment_method text,
  transaction_count integer,
  amount_collected numeric
)
language sql
stable
security definer
set search_path = ''
as $fn$
  select
    x.payment_method,
    count(*)::integer,
    coalesce(sum(x.total_amount), 0)::numeric
  from public.pos_report_bounds(_from_date, _to_date) b
  join public.pos_sales x
    on x.status = 'completed'
   and x.created_at >= b.period_start
   and x.created_at < b.period_end
   and (_branch_id is null or x.branch_id = _branch_id)
   and (_payment_method is null or x.payment_method = _payment_method)
   and (_cashier_id is null or x.cashier_id = _cashier_id)
  where public.can_read_finance_master()
  group by x.payment_method
  order by coalesce(sum(x.total_amount), 0) desc, x.payment_method;
$fn$;

comment on function public.get_finance_sales_collections(date, date, uuid, text, uuid) is
  'Collections by authoritative pos_sales.payment_method. A collection from the '
  'customer, not a settlement from the payment provider.';

-- ---------------------------------------------------------------------------
-- 4. Drill-down, for reconciling a figure back to its source
-- ---------------------------------------------------------------------------
--
-- Every field a Finance reconciliation needs (sale reference, when, branch,
-- cashier, method, gross, fees, net) and nothing operational. No COGS, no unit
-- cost, no margin: cost data is not needed to reconcile revenue, and this
-- function is reachable by roles that have no business seeing it.
--
-- sale_id is the traceability anchor. It is the POS primary key, so any figure
-- on the Finance page can be walked back to the POS sale, its receipt, its
-- branch and its cashier. There are no Finance revenue rows of independent
-- origin, because there are no Finance revenue rows at all.
create or replace function public.get_finance_sales_transactions(
  _from_date date default null,
  _to_date date default null,
  _branch_id uuid default null,
  _payment_method text default null,
  _cashier_id uuid default null,
  _limit integer default 50,
  _offset integer default 0
)
returns table (
  sale_id uuid,
  sold_at timestamptz,
  branch_id uuid,
  branch_name text,
  cashier_id uuid,
  cashier_name text,
  payment_method text,
  payment_reference text,
  item_count integer,
  gross_sales numeric,
  discounts numeric,
  refunds numeric,
  net_sales numeric,
  fees_total numeric,
  total_collected numeric,
  total_rows bigint
)
language sql
stable
security definer
set search_path = ''
as $fn$
  select
    s.id,
    s.created_at,
    s.branch_id,
    s.branch_name,
    s.cashier_id,
    s.cashier_name,
    s.payment_method,
    s.payment_reference,
    (select coalesce(sum(li.quantity), 0)::integer
       from public.pos_sale_items li where li.sale_id = s.id),
    s.subtotal,
    0::numeric,
    0::numeric,
    s.subtotal,
    s.fees_total,
    s.total_amount,
    count(*) over ()
  from public.pos_report_bounds(_from_date, _to_date) b
  join public.pos_sales s
    on s.status = 'completed'
   and s.created_at >= b.period_start
   and s.created_at < b.period_end
   and (_branch_id is null or s.branch_id = _branch_id)
   and (_payment_method is null or s.payment_method = _payment_method)
   and (_cashier_id is null or s.cashier_id = _cashier_id)
  where public.can_read_finance_master()
  order by s.created_at desc, s.id
  limit public.pos_page_size(_limit)
  offset greatest(0, coalesce(_offset, 0));
$fn$;

comment on function public.get_finance_sales_transactions(date, date, uuid, text, uuid, integer, integer) is
  'Read-only drill-down from a Finance figure to the POS sale behind it. Carries '
  'no cost or margin data, and offers no way to alter the source sale.';

-- ---------------------------------------------------------------------------
-- 5. The branches and cashiers a Finance filter may offer
-- ---------------------------------------------------------------------------
--
-- Only those that actually sold something in the window. A filter listing
-- every branch in the enterprise invites Finance to hunt through empty ones,
-- and listing every cashier would leak the POS roster to a surface that has no
-- reason to carry it.
create or replace function public.get_finance_sales_filters(
  _from_date date default null,
  _to_date date default null
)
returns table (
  kind text,
  id uuid,
  label text
)
language sql
stable
security definer
set search_path = ''
as $fn$
  select 'branch'::text, s.branch_id, min(s.branch_name)
  from public.pos_report_bounds(_from_date, _to_date) b
  join public.pos_sales s
    on s.status = 'completed'
   and s.created_at >= b.period_start
   and s.created_at < b.period_end
  where public.can_read_finance_master()
  group by s.branch_id
  union all
  select 'cashier'::text, s.cashier_id, min(s.cashier_name)
  from public.pos_report_bounds(_from_date, _to_date) b
  join public.pos_sales s
    on s.status = 'completed'
   and s.created_at >= b.period_start
   and s.created_at < b.period_end
  where public.can_read_finance_master()
  group by s.cashier_id
  order by 1, 3;
$fn$;

-- ---------------------------------------------------------------------------
-- 6. Execution rights
-- ---------------------------------------------------------------------------
--
-- Granted to authenticated because the gate is inside the function, where it
-- can see who is asking. Nothing here grants SELECT on pos_sales,
-- pos_sale_items or pos_payment_attempts to anybody -- those tables keep the
-- RLS they have, and a caller who does not pass can_read_finance_master()
-- receives an empty result rather than a row they should not have seen.
revoke all on function public.get_finance_sales_summary(date, date, uuid, text, uuid) from public, anon;
revoke all on function public.get_finance_sales_collections(date, date, uuid, text, uuid) from public, anon;
revoke all on function public.get_finance_sales_transactions(date, date, uuid, text, uuid, integer, integer) from public, anon;
revoke all on function public.get_finance_sales_filters(date, date) from public, anon;

grant execute on function public.get_finance_sales_summary(date, date, uuid, text, uuid) to authenticated;
grant execute on function public.get_finance_sales_collections(date, date, uuid, text, uuid) to authenticated;
grant execute on function public.get_finance_sales_transactions(date, date, uuid, text, uuid, integer, integer) to authenticated;
grant execute on function public.get_finance_sales_filters(date, date) to authenticated;
