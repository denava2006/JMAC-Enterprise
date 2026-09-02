-- FMS F4 (1/2) — procurement documents.
--
-- Approved demand becomes a purchase order. That is all this migration does:
-- it creates the paperwork and the authority to move it, and it touches no
-- inventory whatsoever. The bridge to physical stock is the next migration, and
-- it is deliberately separate so that the line between them is readable.
--
-- The rule this phase exists to hold:
--
--   request approval    != stock received
--   purchase order      != stock received
--   supplier invoice    != stock received
--   payment             != stock received
--
-- Only a POS Manager confirming a physical delivery changes POS inventory, and
-- POS remains the only place a stock quantity lives. Nothing here keeps a
-- second one.
--
-- Names checked against the live schema first: purchase_orders,
-- purchase_order_items, supplier_invoices, accounts_payable, deliveries and
-- goods_receipts were all free.

create sequence if not exists public.seq_purchase_order;

-- =========================================================================
-- purchase_orders
-- =========================================================================
create table if not exists public.purchase_orders (
  id            uuid primary key default gen_random_uuid(),
  po_number     text unique,
  vendor_id     uuid not null references public.vendors(id) on delete restrict,

  status        text not null default 'draft' check (status in (
                  'draft', 'pending_approval', 'approved',
                  'returned', 'rejected', 'cancelled', 'closed')),

  order_date             date,
  expected_delivery_date date,
  notes                  text,
  currency               text not null default 'PHP',

  created_by    uuid references public.profiles(id) on delete set null,
  submitted_at  timestamptz,
  approved_by   uuid references public.profiles(id) on delete set null,
  approved_at   timestamptz,
  closed_at     timestamptz,
  closed_reason text,

  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  constraint purchase_orders_delivery_after_order check (
    expected_delivery_date is null or order_date is null
    or expected_delivery_date >= order_date
  ),
  -- An approved PO records who approved it and when, or it is not approved.
  constraint purchase_orders_approval_is_stamped check (
    (status in ('approved', 'closed') and approved_by is not null and approved_at is not null)
    or status not in ('approved', 'closed')
  )
);

create index if not exists purchase_orders_status_idx on public.purchase_orders (status);
create index if not exists purchase_orders_vendor_idx on public.purchase_orders (vendor_id);

create or replace function public.set_purchase_order_number()
returns trigger
language plpgsql
security definer
set search_path = ''
as $fn$
begin
  if new.po_number is null then
    new.po_number := 'PO-' || to_char(current_date, 'YYYY') || '-'
      || lpad(nextval('public.seq_purchase_order')::text, 4, '0');
  end if;
  return new;
end;
$fn$;

revoke all on function public.set_purchase_order_number() from public, anon, authenticated;

drop trigger if exists trg_purchase_order_number on public.purchase_orders;
create trigger trg_purchase_order_number before insert on public.purchase_orders
  for each row execute function public.set_purchase_order_number();

drop trigger if exists trg_set_updated_at on public.purchase_orders;
create trigger trg_set_updated_at before update on public.purchase_orders
  for each row execute function public.set_updated_at();

-- =========================================================================
-- purchase_order_items
-- =========================================================================
-- line_total is generated, not supplied. A client-sent total is a number the
-- server would be trusting somebody else to compute.
create table if not exists public.purchase_order_items (
  id                uuid primary key default gen_random_uuid(),
  purchase_order_id uuid not null references public.purchase_orders(id) on delete cascade,

  description       text not null,
  quantity_ordered  integer not null check (quantity_ordered > 0),
  unit_of_measure   text not null default 'unit',
  unit_cost         numeric(12,2) not null check (unit_cost >= 0),
  line_total        numeric(14,2) generated always as (quantity_ordered * unit_cost) stored,

  -- Set when this line replenishes POS stock. Both or neither: a product with
  -- no destination cannot be received anywhere, and a destination with no
  -- product cannot be received as anything.
  pos_product_id        uuid references public.pos_products(id) on delete restrict,
  destination_branch_id uuid references public.branches(id) on delete restrict,

  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),

  constraint purchase_order_items_pos_link_is_complete check (
    (pos_product_id is null and destination_branch_id is null)
    or (pos_product_id is not null and destination_branch_id is not null)
  )
);

create index if not exists purchase_order_items_po_idx
  on public.purchase_order_items (purchase_order_id);
create index if not exists purchase_order_items_receiving_idx
  on public.purchase_order_items (destination_branch_id, pos_product_id)
  where pos_product_id is not null;

drop trigger if exists trg_set_updated_at on public.purchase_order_items;
create trigger trg_set_updated_at before update on public.purchase_order_items
  for each row execute function public.set_updated_at();

-- =========================================================================
-- purchase_order_sources — what created this PO
-- =========================================================================
-- A link, not a copy. The approved finance request and the POS stock request
-- stay where they are and keep their own lifecycles; this records that a PO was
-- raised to satisfy them.
--
-- A table rather than a column on purchase_orders, so that one PO satisfying
-- several requests stays possible later without a migration that rewrites
-- history. Nothing in this phase builds aggregation UI for it -- it just is not
-- designed shut.
create table if not exists public.purchase_order_sources (
  id                uuid primary key default gen_random_uuid(),
  purchase_order_id uuid not null references public.purchase_orders(id) on delete cascade,

  finance_request_id      uuid references public.finance_requests(id) on delete restrict,
  pos_inventory_request_id uuid references public.pos_inventory_requests(id) on delete restrict,

  created_by  uuid references public.profiles(id) on delete set null,
  created_at  timestamptz not null default now(),

  -- Exactly one source per row. A link that points at two things answers
  -- "what created this" with a shrug.
  constraint purchase_order_sources_one_source check (
    (finance_request_id is not null and pos_inventory_request_id is null)
    or (finance_request_id is null and pos_inventory_request_id is not null)
  )
);

create unique index if not exists purchase_order_sources_finance_unique
  on public.purchase_order_sources (purchase_order_id, finance_request_id)
  where finance_request_id is not null;
create unique index if not exists purchase_order_sources_pos_unique
  on public.purchase_order_sources (purchase_order_id, pos_inventory_request_id)
  where pos_inventory_request_id is not null;

-- =========================================================================
-- The PO workflow
-- =========================================================================
-- Finance Staff prepare and submit; the Finance Manager decides. The Accountant
-- reads procurement and approves none of it -- being the ledger's owner is not
-- authority over what the company commits to buy. The Administrator appears in
-- no branch, exactly as in the request chain.
create or replace function public.transition_purchase_order(
  _purchase_order_id uuid,
  _to_status text,
  _remarks text default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  _po      record;
  _uid     uuid := (select auth.uid());
  _role    text;
  _allowed boolean := false;
  _lines   integer;
begin
  select * into _po from public.purchase_orders where id = _purchase_order_id for update;
  if _po.id is null then
    raise exception 'That purchase order no longer exists.' using errcode = 'no_data_found';
  end if;

  select role::text into _role from public.profiles where id = _uid and status = 'active';
  if _role is null or not public.has_finance_privilege(array[_role]) then
    raise exception 'Only Finance can move a purchase order.' using errcode = 'insufficient_privilege';
  end if;

  if _role = 'finance_staff' and _po.status = 'draft' and _to_status = 'pending_approval' then
    _allowed := true;
  elsif _role = 'finance_staff' and _po.status = 'returned' and _to_status = 'pending_approval' then
    _allowed := true;
  elsif _role = 'finance_staff' and _po.status in ('draft', 'returned') and _to_status = 'cancelled' then
    _allowed := true;
  elsif _role = 'finance_manager' and _po.status = 'pending_approval'
        and _to_status in ('approved', 'returned', 'rejected') then
    _allowed := true;
  elsif _role = 'finance_manager' and _po.status = 'approved' and _to_status = 'cancelled' then
    -- Withdrawing an order before anything was delivered. The receiving bridge
    -- refuses a PO that is not approved, so this stops further receipts.
    _allowed := true;
  elsif _role = 'finance_manager' and _po.status = 'approved' and _to_status = 'closed' then
    _allowed := true;
  end if;

  if not _allowed then
    raise exception 'A % cannot move purchase order % from % to %.',
      _role, _po.po_number, _po.status, _to_status
      using errcode = 'insufficient_privilege';
  end if;

  -- An order with no lines orders nothing.
  if _to_status = 'pending_approval' then
    select count(*) into _lines from public.purchase_order_items where purchase_order_id = _po.id;
    if _lines = 0 then
      raise exception 'Add at least one line before submitting purchase order %.', _po.po_number
        using errcode = 'check_violation';
    end if;
  end if;

  -- Cancelling an order that has already taken delivery would leave received
  -- stock attached to a cancelled document.
  if _to_status = 'cancelled' and exists (
    select 1 from public.procurement_receipts pr
    join public.purchase_order_items i on i.id = pr.purchase_order_item_id
    where i.purchase_order_id = _po.id
  ) then
    raise exception 'Purchase order % has already taken delivery and cannot be cancelled.',
      _po.po_number using errcode = 'check_violation';
  end if;

  update public.purchase_orders
     set status = _to_status,
         submitted_at = case when _to_status = 'pending_approval' then now() else submitted_at end,
         approved_by  = case when _to_status = 'approved' then _uid else approved_by end,
         approved_at  = case when _to_status = 'approved' then now() else approved_at end,
         closed_at    = case when _to_status in ('closed', 'cancelled', 'rejected') then now() else closed_at end,
         closed_reason = case when _to_status in ('closed', 'cancelled', 'rejected')
                              then coalesce(_remarks, _to_status) else closed_reason end,
         updated_at = now()
   where id = _purchase_order_id;

  insert into public.audit_logs (actor_id, action, table_name, record_id, new_data)
  values (_uid, 'Purchase Order ' || initcap(_to_status), 'purchase_orders', _purchase_order_id,
          jsonb_build_object('po_number', _po.po_number, 'from', _po.status,
                             'to', _to_status, 'remarks', _remarks));
end;
$fn$;

-- Deliberately created after procurement_receipts exists in the next migration;
-- the function body references it, and PL/pgSQL resolves that at run time.
revoke all on function public.transition_purchase_order(uuid, text, text) from public, anon;
grant execute on function public.transition_purchase_order(uuid, text, text) to authenticated;

-- =========================================================================
-- Row level security
-- =========================================================================
alter table public.purchase_orders        enable row level security;
alter table public.purchase_order_items   enable row level security;
alter table public.purchase_order_sources enable row level security;

-- Everyone in Finance reads procurement; the Administrator reads it for
-- oversight. Editing is Finance Staff's, and only while the order is theirs.
drop policy if exists purchase_orders_read on public.purchase_orders;
create policy purchase_orders_read on public.purchase_orders
  for select to authenticated using (public.can_read_finance_master());

drop policy if exists purchase_orders_prepare on public.purchase_orders;
create policy purchase_orders_prepare on public.purchase_orders
  for insert to authenticated
  with check (
    status = 'draft'
    and public.has_finance_privilege(array['finance_staff', 'finance_manager'])
  );

drop policy if exists purchase_orders_amend on public.purchase_orders;
create policy purchase_orders_amend on public.purchase_orders
  for update to authenticated
  using (
    status in ('draft', 'returned')
    and public.has_finance_privilege(array['finance_staff', 'finance_manager'])
  )
  with check (
    status in ('draft', 'returned')
    and public.has_finance_privilege(array['finance_staff', 'finance_manager'])
  );

drop policy if exists purchase_order_items_read on public.purchase_order_items;
create policy purchase_order_items_read on public.purchase_order_items
  for select to authenticated using (public.can_read_finance_master());

drop policy if exists purchase_order_items_write on public.purchase_order_items;
create policy purchase_order_items_write on public.purchase_order_items
  for all to authenticated
  using (
    public.has_finance_privilege(array['finance_staff', 'finance_manager'])
    and exists (
      select 1 from public.purchase_orders po
      where po.id = purchase_order_id and po.status in ('draft', 'returned')
    )
  )
  with check (
    public.has_finance_privilege(array['finance_staff', 'finance_manager'])
    and exists (
      select 1 from public.purchase_orders po
      where po.id = purchase_order_id and po.status in ('draft', 'returned')
    )
  );

drop policy if exists purchase_order_sources_read on public.purchase_order_sources;
create policy purchase_order_sources_read on public.purchase_order_sources
  for select to authenticated using (public.can_read_finance_master());

drop policy if exists purchase_order_sources_link on public.purchase_order_sources;
create policy purchase_order_sources_link on public.purchase_order_sources
  for all to authenticated
  using (
    public.has_finance_privilege(array['finance_staff', 'finance_manager'])
    and exists (
      select 1 from public.purchase_orders po
      where po.id = purchase_order_id and po.status in ('draft', 'returned')
    )
  )
  with check (
    public.has_finance_privilege(array['finance_staff', 'finance_manager'])
    and exists (
      select 1 from public.purchase_orders po
      where po.id = purchase_order_id and po.status in ('draft', 'returned')
    )
  );

-- ---------------------------------------------------------- server actor
drop trigger if exists trg_stamp_actor on public.purchase_orders;
create trigger trg_stamp_actor before insert on public.purchase_orders
  for each row execute function public.stamp_finance_actor();

drop trigger if exists trg_stamp_actor on public.purchase_order_sources;
create trigger trg_stamp_actor before insert on public.purchase_order_sources
  for each row execute function public.stamp_finance_actor();

-- =========================================================================
-- Table privileges
-- =========================================================================
revoke all on public.purchase_orders        from anon, public;
revoke all on public.purchase_order_items   from anon, public;
revoke all on public.purchase_order_sources from anon, public;

revoke all on public.purchase_orders        from authenticated;
revoke all on public.purchase_order_items   from authenticated;
revoke all on public.purchase_order_sources from authenticated;

grant select, insert, update         on public.purchase_orders        to authenticated;
grant select, insert, update, delete on public.purchase_order_items   to authenticated;
grant select, insert, delete         on public.purchase_order_sources to authenticated;

grant all on public.purchase_orders        to service_role;
grant all on public.purchase_order_items   to service_role;
grant all on public.purchase_order_sources to service_role;

-- =========================================================================
-- Budget semantics are unchanged
-- =========================================================================
-- F3.1 settled this and F4 does not reopen it. Approving a purchase order is
-- authorization to buy: it is not proof the goods arrived and not proof an
-- invoice was incurred, so it moves neither `reserved` nor `spent`. The
-- reservation created by the approved request stays exactly where it is.
--
-- `spent` therefore remains zero, correctly, because F4 introduces no supplier
-- invoice, no accounts payable and no payment -- the first authoritative
-- realization event still does not exist. The phase that introduces one decides
-- what it is; nothing here quietly decides it for them.
comment on table public.purchase_orders is
  'Procurement authorization. Approving one commits nothing financially and '
  'receives no stock: only a POS Manager confirming physical delivery changes '
  'inventory, and only a later accounting phase can move spent.';
