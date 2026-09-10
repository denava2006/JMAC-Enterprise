-- One sale, one reference, wherever it is looked at.
--
-- 20261002000000 gave every sale a persisted receipt_number and put it on the
-- till receipt, the reprint and the transaction register. Two Finance read
-- paths were left behind, and they are the ones that still derive a short
-- reference from the sale's uuid in the browser:
--
--   get_finance_sales_transactions  -> the FMS sales list, column "Receipt"
--   get_unsettled_collections       -> the settlement picker's row identity
--
-- Neither returns receipt_number, so no amount of frontend work can show it.
-- That is the whole reason this migration exists; it adds one column to each
-- and changes nothing else.
--
-- WHAT IS NOT HAPPENING HERE. payment_reference stays exactly where it is on
-- both functions. It is a different fact -- what the PROVIDER called the
-- payment -- and Finance still needs it to reconcile a PayMongo payout. The
-- two are now both available and each can sit under its own label, which is
-- the opposite of treating them as interchangeable.
--
-- No table, no data, no policy and no authorization changes. The bodies below
-- are the deployed ones with a single column added to the select list.

-- ===========================================================================
-- The FMS sales list
-- ===========================================================================
-- Dropped and recreated rather than replaced: adding a column to a RETURNS
-- TABLE changes the return type, which CREATE OR REPLACE refuses.
drop function if exists public.get_finance_sales_transactions(date, date, uuid, text, uuid, integer, integer);

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
  receipt_number text,
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
    s.receipt_number,
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

-- ===========================================================================
-- The settlement picker
-- ===========================================================================
drop function if exists public.get_unsettled_collections(text, uuid, text, date, date);

create or replace function public.get_unsettled_collections(
  _kind text,
  _branch_id uuid default null,
  _payment_method text default null,
  _from_date date default null,
  _to_date date default null
)
returns table (
  sale_id uuid,
  receipt_number text,
  sold_at timestamptz,
  branch_id uuid,
  branch_name text,
  cashier_name text,
  payment_method text,
  payment_reference text,
  amount numeric
)
language sql
stable
security definer
set search_path = ''
as $fn$
  with bounds as (
    select b.period_start, b.period_end
    from public.pos_report_bounds(_from_date, _to_date) b
    where _from_date is not null or _to_date is not null
  )
  select
    s.id, s.receipt_number, s.created_at, s.branch_id, s.branch_name, s.cashier_name,
    s.payment_method, s.payment_reference, s.total_amount
  from public.pos_sales s
  left join bounds on true
  where public.can_read_finance_master()
    -- Nothing until a branch is named. Not an error: the caller is a form that
    -- has not been filled in yet, and an empty list is the honest answer to
    -- "what is waiting at no branch in particular".
    and _branch_id is not null
    and s.branch_id = _branch_id
    and s.status = 'completed'
    and (bounds.period_start is null or s.created_at >= bounds.period_start)
    and (bounds.period_end is null or s.created_at < bounds.period_end)
    and case
          when _kind = 'branch_cash' then s.payment_method = 'cash'
          else
            s.payment_method <> 'cash'
            and (
              _payment_method is null
              or public.pos_provider_family(s.payment_method)
                 = public.pos_provider_family(_payment_method)
            )
        end
    and not exists (
      select 1
      from public.collection_settlement_items i
      join public.collection_settlements cs on cs.id = i.settlement_id
      where i.pos_sale_id = s.id
        and cs.status not in ('returned', 'rejected')
    )
  order by s.created_at, s.id;
$fn$;

-- Both were dropped, so their grants are stated again rather than assumed.
-- Reproduced from what they actually held: authenticated and service_role, no
-- anon and no PUBLIC.
revoke all on function public.get_finance_sales_transactions(date, date, uuid, text, uuid, integer, integer) from public, anon;
revoke all on function public.get_unsettled_collections(text, uuid, text, date, date) from public, anon;
grant execute on function public.get_finance_sales_transactions(date, date, uuid, text, uuid, integer, integer) to authenticated, service_role;
grant execute on function public.get_unsettled_collections(text, uuid, text, date, date) to authenticated, service_role;
