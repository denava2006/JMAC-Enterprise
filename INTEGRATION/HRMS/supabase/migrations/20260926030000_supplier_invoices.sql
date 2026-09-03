-- F5 -- supplier invoices and accounts payable
--
-- What happens after the goods arrive. Procurement is finished when the branch
-- has the stock; the supplier then sends a bill, and somebody has to check that
-- the bill matches what was ordered and what turned up before the company
-- agrees to owe it.
--
-- The control this phase exists for is the three-way match:
--
--   the purchase order   what the company agreed to buy
--   the receipts         what the branch physically took in
--   the invoice          what the supplier is charging for
--
-- All three have to agree. This file makes disagreement visible and makes
-- approval impossible while it lasts.
--
-- What F5 does NOT do, and must not appear to: it moves no money. An approved
-- invoice is a debt the company acknowledges, not a payment. Budget figures,
-- POS inventory and every procurement quantity are untouched by everything
-- here -- nothing in this migration writes to budgets, purchase_orders,
-- purchase_order_items, procurement_receipts or any POS table, and tests
-- assert that rather than trusting the reading.

-- ============================================================ the invoice

create table if not exists public.supplier_invoices (
  id uuid primary key default gen_random_uuid(),

  -- Ours, for referring to it internally. Assigned like a PO number.
  invoice_no text unique,

  -- The supplier's own document number, exactly as printed on their invoice.
  -- Stored as given: this is a reference to somebody else's paperwork, and
  -- quietly reformatting it makes it stop matching the document in the folder.
  supplier_invoice_number text not null,

  -- Taken from the purchase order rather than chosen. An invoice for a PO is
  -- an invoice from that PO's supplier; letting somebody pick a different one
  -- would let a bill from anybody be matched against anybody's goods.
  vendor_id uuid not null references public.vendors(id) on delete restrict,
  purchase_order_id uuid not null references public.purchase_orders(id) on delete restrict,

  invoice_date date not null,
  due_date date,
  currency text not null default 'PHP',

  -- Amounts the lines cannot derive. The subtotal and the total are NOT stored:
  -- they are the sum of the lines plus these, and a stored copy is a number
  -- that eventually disagrees with the lines it came from. See
  -- supplier_invoice_status.
  tax_amount numeric(14,2) not null default 0 check (tax_amount >= 0),
  other_charges numeric(14,2) not null default 0 check (other_charges >= 0),
  -- An unexplained lump sum on a supplier bill is the thing an approver cannot
  -- check, so a charge has to say what it is for.
  other_charges_note text,

  status text not null default 'draft' check (status in (
    'draft', 'for_review', 'approved', 'returned', 'rejected', 'voided')),

  notes text,

  created_by uuid references public.profiles(id) on delete set null,
  submitted_at timestamptz,
  approved_by uuid references public.profiles(id) on delete set null,
  approved_at timestamptz,
  -- Why it was sent back, refused or voided. Never cleared: the reason a thing
  -- was returned stays true even after it is fixed and resubmitted.
  decision_reason text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint supplier_invoices_due_after_invoice
    check (due_date is null or due_date >= invoice_date),
  constraint supplier_invoices_charges_explained
    check (other_charges = 0 or nullif(btrim(coalesce(other_charges_note, '')), '') is not null)
);

-- One bill, once. A supplier's numbering is their own, so the same number from
-- two different suppliers is fine; the same number twice from one supplier is
-- a duplicate, and paying it twice is the mistake this prevents.
--
-- Compared case-insensitively and trimmed, because "inv-1001" and "INV-1001 "
-- are the same document -- but the column keeps what was typed, so the record
-- still matches the paper.
create unique index if not exists supplier_invoices_vendor_number_unique
  on public.supplier_invoices (vendor_id, lower(btrim(supplier_invoice_number)))
  where status <> 'voided';

create index if not exists supplier_invoices_po_idx on public.supplier_invoices (purchase_order_id);
create index if not exists supplier_invoices_status_idx on public.supplier_invoices (status);
create index if not exists supplier_invoices_due_idx on public.supplier_invoices (due_date)
  where status = 'approved';

-- ------------------------------------------------------------- the lines
--
-- Each line points at the purchase order line it is charging for. That link is
-- what makes a three-way match possible at all: without it, matching would be
-- guesswork over descriptions.
create table if not exists public.supplier_invoice_lines (
  id uuid primary key default gen_random_uuid(),
  supplier_invoice_id uuid not null
    references public.supplier_invoices(id) on delete cascade,
  purchase_order_item_id uuid not null
    references public.purchase_order_items(id) on delete restrict,

  description text not null,
  quantity integer not null check (quantity > 0),
  unit_cost numeric(12,2) not null check (unit_cost >= 0),
  line_total numeric(14,2) generated always as (quantity * unit_cost) stored,

  created_at timestamptz not null default now(),

  -- One line per purchase order line per invoice. Two lines charging the same
  -- order line would make "how much of this has been invoiced" ambiguous.
  constraint supplier_invoice_lines_one_per_po_line unique (supplier_invoice_id, purchase_order_item_id)
);

create index if not exists supplier_invoice_lines_po_item_idx
  on public.supplier_invoice_lines (purchase_order_item_id);

-- ----------------------------------------------------------- the history
--
-- Deliberately the same shape as finance_request_approvals. Every transition
-- appends; nothing here is ever updated or deleted, so the trail of who did
-- what survives the record being corrected afterwards.
create table if not exists public.supplier_invoice_history (
  id uuid primary key default gen_random_uuid(),
  supplier_invoice_id uuid not null
    references public.supplier_invoices(id) on delete cascade,
  actor_id uuid references public.profiles(id) on delete set null,
  role_at_action text,
  action text not null,
  from_status text,
  to_status text,
  remarks text,
  created_at timestamptz not null default now()
);

create index if not exists supplier_invoice_history_invoice_idx
  on public.supplier_invoice_history (supplier_invoice_id, created_at);

-- ------------------------------------------------------- the internal number
create or replace function public.next_supplier_invoice_no()
returns trigger
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  _year text := to_char(now(), 'YYYY');
  _seq  integer;
begin
  if new.invoice_no is not null then return new; end if;

  select coalesce(max(substring(invoice_no from 'SI-\d{4}-(\d+)')::integer), 0) + 1
    into _seq
    from public.supplier_invoices
   where invoice_no like 'SI-' || _year || '-%';

  new.invoice_no := 'SI-' || _year || '-' || lpad(_seq::text, 4, '0');
  return new;
end;
$fn$;

revoke all on function public.next_supplier_invoice_no() from public, anon, authenticated;

drop trigger if exists trg_supplier_invoice_no on public.supplier_invoices;
create trigger trg_supplier_invoice_no
  before insert on public.supplier_invoices
  for each row execute function public.next_supplier_invoice_no();

drop trigger if exists trg_set_updated_at on public.supplier_invoices;
create trigger trg_set_updated_at before update on public.supplier_invoices
  for each row execute function public.set_updated_at();

-- ===================================================== what the three say
--
-- One row per purchase order line on the invoice, carrying all three numbers
-- side by side and a verdict. The UI renders this; the approval guard reads
-- the same function, so what an approver is shown and what the database
-- enforces cannot drift apart.
--
--   ordered    what the PO committed to, less anything stopped
--   received   what the branch actually took in
--   invoiced   what earlier invoices already charged for this line
--   billable   what is legitimately left to charge
--
-- Cancelled quantity is subtracted from ordered, never invoiced: stopping the
-- remainder of an order means the company is not buying those units, so no
-- supplier may bill for them.
create or replace function public.supplier_invoice_match(_supplier_invoice_id uuid)
returns table (
  line_id                uuid,
  purchase_order_item_id uuid,
  description            text,
  ordered_quantity       integer,
  cancelled_quantity     integer,
  effective_quantity     integer,
  received_quantity      integer,
  previously_invoiced    integer,
  billable_quantity      integer,
  invoice_quantity       integer,
  po_unit_cost           numeric,
  invoice_unit_cost      numeric,
  po_line_value          numeric,
  invoice_line_value     numeric,
  quantity_matched       boolean,
  price_matched          boolean,
  verdict                text
)
language sql
stable
security definer
set search_path = ''
as $fn$
  select
    l.id,
    i.id,
    l.description,
    i.quantity_ordered,
    i.quantity_cancelled,
    (i.quantity_ordered - i.quantity_cancelled)::integer,
    coalesce(r.received, 0)::integer,
    coalesce(prior.invoiced, 0)::integer,
    -- What may still be charged: never more than arrived, never more than the
    -- company is still buying, and less whatever earlier invoices took.
    greatest(
      least(coalesce(r.received, 0), i.quantity_ordered - i.quantity_cancelled)
        - coalesce(prior.invoiced, 0),
      0
    )::integer,
    l.quantity,
    i.unit_cost,
    l.unit_cost,
    ((i.quantity_ordered - i.quantity_cancelled) * i.unit_cost)::numeric(14,2),
    l.line_total,
    l.quantity <= greatest(
      least(coalesce(r.received, 0), i.quantity_ordered - i.quantity_cancelled)
        - coalesce(prior.invoiced, 0),
      0
    ),
    l.unit_cost = i.unit_cost,
    case
      when l.quantity > greatest(
             least(coalesce(r.received, 0), i.quantity_ordered - i.quantity_cancelled)
               - coalesce(prior.invoiced, 0), 0)
        then 'quantity_mismatch'
      when l.unit_cost <> i.unit_cost then 'price_mismatch'
      else 'matched'
    end
  from public.supplier_invoice_lines l
  join public.purchase_order_items i on i.id = l.purchase_order_item_id
  left join lateral (
    select sum(pr.quantity_received) as received
      from public.procurement_receipts pr
     where pr.purchase_order_item_id = i.id
  ) r on true
  -- Earlier invoices against the same order line. A returned or rejected
  -- invoice is not a charge, and a voided one has been withdrawn, so none of
  -- them consume the billable quantity.
  left join lateral (
    select sum(pl.quantity) as invoiced
      from public.supplier_invoice_lines pl
      join public.supplier_invoices pi on pi.id = pl.supplier_invoice_id
     where pl.purchase_order_item_id = i.id
       and pl.supplier_invoice_id <> _supplier_invoice_id
       and pi.status in ('for_review', 'approved')
  ) prior on true
  where l.supplier_invoice_id = _supplier_invoice_id
  order by l.created_at;
$fn$;

revoke all on function public.supplier_invoice_match(uuid) from public, anon;
grant execute on function public.supplier_invoice_match(uuid) to authenticated;

-- ================================================ the invoice, totalled up
--
-- Totals are derived here rather than stored on the header, for the same
-- reason purchase_order_status derives its subtotal: a stored total is a
-- number that survives its lines changing.
create or replace view public.supplier_invoice_status
with (security_invoker = on) as
  select
    si.id,
    si.invoice_no,
    si.supplier_invoice_number,
    si.vendor_id,
    v.name as vendor_name,
    si.purchase_order_id,
    po.po_number,
    po.status as purchase_order_status,
    si.invoice_date,
    si.due_date,
    si.currency,
    si.status,
    si.notes,
    si.tax_amount,
    si.other_charges,
    si.other_charges_note,
    coalesce(l.line_count, 0)::integer as line_count,
    coalesce(l.subtotal, 0)::numeric(14,2) as subtotal,
    (coalesce(l.subtotal, 0) + si.tax_amount + si.other_charges)::numeric(14,2) as total_amount,
    -- Nothing can pay an invoice yet, so what is owed is the whole of it.
    -- F6 subtracts payments here and nothing else on this view changes.
    (coalesce(l.subtotal, 0) + si.tax_amount + si.other_charges)::numeric(14,2) as balance_due,
    -- Derived, never stored: an invoice does not become a different record
    -- because a date passed.
    case
      when si.status <> 'approved' then null
      when si.due_date is null then null
      else (si.due_date - current_date)
    end as days_until_due,
    case
      when si.status <> 'approved' or si.due_date is null then null
      when si.due_date < current_date then 'overdue'
      when si.due_date <= current_date + 7 then 'due_soon'
      else 'scheduled'
    end as payment_state,
    si.created_by,
    si.created_at,
    si.submitted_at,
    si.approved_by,
    si.approved_at,
    si.decision_reason,
    si.updated_at
  from public.supplier_invoices si
  left join public.vendors v on v.id = si.vendor_id
  left join public.purchase_orders po on po.id = si.purchase_order_id
  left join lateral (
    select count(*) as line_count, sum(sl.line_total) as subtotal
      from public.supplier_invoice_lines sl
     where sl.supplier_invoice_id = si.id
  ) l on true;

comment on view public.supplier_invoice_status is
  'Supplier invoices with server-derived subtotal, total and balance. balance_due equals the total because no payment phase exists; F6 subtracts payments here.';

-- ==================================================== who may do what
alter table public.supplier_invoices enable row level security;
alter table public.supplier_invoice_lines enable row level security;
alter table public.supplier_invoice_history enable row level security;

revoke all on public.supplier_invoices from anon, public;
revoke all on public.supplier_invoice_lines from anon, public;
revoke all on public.supplier_invoice_history from anon, public;
revoke all on public.supplier_invoice_status from anon, public;
grant select on public.supplier_invoice_status to authenticated;

-- Reading is the finance read predicate, unchanged from every other finance
-- table: the three finance roles and the Administrator. A POS Manager, a
-- cashier and every HR role are outside it, which is what keeps supplier cost
-- away from the people who receive the goods.
drop policy if exists supplier_invoices_read on public.supplier_invoices;
create policy supplier_invoices_read on public.supplier_invoices
  for select to authenticated using (public.can_read_finance_master());

-- Authoring an accounting document is the Accountant's. Not Finance Staff --
-- they prepared the purchase order, and the person who bought the goods should
-- not also be the person who records what the supplier charged for them.
drop policy if exists supplier_invoices_author on public.supplier_invoices;
create policy supplier_invoices_author on public.supplier_invoices
  for insert to authenticated
  with check (
    status = 'draft'
    and public.has_finance_privilege(array['accountant'])
  );

-- Editable only while it is theirs to edit. Once submitted the document is in
-- front of a reviewer, and a maker who can still change it is a maker the
-- reviewer cannot trust the copy of.
drop policy if exists supplier_invoices_amend on public.supplier_invoices;
create policy supplier_invoices_amend on public.supplier_invoices
  for update to authenticated
  using (
    status in ('draft', 'returned')
    and public.has_finance_privilege(array['accountant'])
  )
  with check (
    status in ('draft', 'returned')
    and public.has_finance_privilege(array['accountant'])
  );

drop policy if exists supplier_invoice_lines_read on public.supplier_invoice_lines;
create policy supplier_invoice_lines_read on public.supplier_invoice_lines
  for select to authenticated using (public.can_read_finance_master());

drop policy if exists supplier_invoice_lines_write on public.supplier_invoice_lines;
create policy supplier_invoice_lines_write on public.supplier_invoice_lines
  for all to authenticated
  using (
    public.has_finance_privilege(array['accountant'])
    and exists (
      select 1 from public.supplier_invoices si
       where si.id = supplier_invoice_id and si.status in ('draft', 'returned')
    )
  )
  with check (
    public.has_finance_privilege(array['accountant'])
    and exists (
      select 1 from public.supplier_invoices si
       where si.id = supplier_invoice_id and si.status in ('draft', 'returned')
    )
  );

-- History is written by the transition function and read by everybody who can
-- read the invoice. Nobody writes it directly, so there is no insert policy.
drop policy if exists supplier_invoice_history_read on public.supplier_invoice_history;
create policy supplier_invoice_history_read on public.supplier_invoice_history
  for select to authenticated using (public.can_read_finance_master());

-- ============================================ the vendor is the PO's vendor
--
-- Enforced rather than trusted. The create function takes it from the order,
-- but a policy-level write could still set it, and an invoice matched against
-- another supplier's goods is the fraud this closes.
create or replace function public.guard_supplier_invoice_vendor()
returns trigger
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  _po_vendor uuid;
begin
  select vendor_id into _po_vendor
    from public.purchase_orders where id = new.purchase_order_id;

  if _po_vendor is null then
    raise exception 'That purchase order no longer exists.' using errcode = 'no_data_found';
  end if;
  if new.vendor_id is distinct from _po_vendor then
    raise exception 'A supplier invoice bills the vendor named on its purchase order.'
      using errcode = 'check_violation';
  end if;

  return new;
end;
$fn$;

revoke all on function public.guard_supplier_invoice_vendor() from public, anon, authenticated;

drop trigger if exists trg_supplier_invoice_vendor on public.supplier_invoices;
create trigger trg_supplier_invoice_vendor
  before insert or update on public.supplier_invoices
  for each row execute function public.guard_supplier_invoice_vendor();
