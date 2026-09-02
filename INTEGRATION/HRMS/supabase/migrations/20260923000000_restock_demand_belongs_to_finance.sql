-- FMS F4.1 — restock demand belongs to Finance, and a vendor's details are checked.
--
-- Two corrections the hosted walkthrough exposed.

-- =========================================================================
-- B/C/D. Why a POS restock request never reached Finance
-- =========================================================================
-- It was waiting for an Administrator, and the code said so out loud:
--
--   -- INTERIM. Restock is a procurement decision and belongs to FMS. The
--   -- Administrator stands in only because FMS is not integrated yet.
--   when 'restock' then public.is_admin()
--
-- That was written before there was an FMS to hand it to. F4 is the
-- integration it was waiting for, so the stand-in ends here: a branch asking
-- for more stock is asking Finance to buy something, and Finance is now who
-- decides.
--
-- The other two request types are NOT procurement and keep their authority.
-- Creating an enterprise product is enterprise administration whichever branch
-- asked, and adding an existing product to a branch is a catalogue decision
-- with no money in it. Conflating either with purchasing is exactly what this
-- phase is supposed to avoid.
create or replace function public.can_review_pos_request(_request_type public.pos_request_type)
returns boolean
language sql
stable
security definer
set search_path = ''
as $fn$
  select case _request_type
    -- Restock is procurement. Finance Staff prepare it and the Finance Manager
    -- commits to it later on the purchase order; an Administrator is not an
    -- operational step in that chain and is deliberately not one here.
    when 'restock' then public.has_finance_privilege(array['finance_staff', 'finance_manager'])
    -- PERMANENT. A catalogue and branch-carrying decision, with no money in it.
    when 'carry_existing_product' then public.is_admin()
    -- PERMANENT. Creating an enterprise product is enterprise administration,
    -- whichever branch asked for it.
    when 'new_product' then public.is_admin()
    else false
  end;
$fn$;

-- ------------------------------------------------------------ the queue
-- The queue gated on "may this caller review ANYTHING" and then returned every
-- row regardless of type. That was harmless while one role reviewed all three;
-- with Finance reviewing restock it would have handed them the catalogue queue
-- as well. The predicate now applies per row, so each reviewer sees the
-- requests they can actually act on and no others.
create or replace function public.get_pos_request_queue(
  _branch_id uuid default null,
  _status public.pos_request_status default null,
  _limit integer default 25,
  _offset integer default 0
)
returns table (
  request_id uuid,
  branch_id uuid,
  branch_name text,
  product_id uuid,
  product_name text,
  request_type public.pos_request_type,
  requested_quantity integer,
  reason text,
  status public.pos_request_status,
  requested_by uuid,
  requester_name text,
  requester_enterprise_role public.user_role,
  requested_at timestamptz,
  reviewer_name text,
  reviewed_at timestamptz,
  review_note text,
  can_review boolean,
  total_count bigint
)
language sql
stable
security definer
set search_path = ''
as $fn$
  select
    r.id, r.branch_id, r.branch_name_snapshot, r.product_id, r.product_name_snapshot,
    r.request_type, r.requested_quantity, r.reason, r.status,
    r.requested_by, r.requester_name_snapshot, p.role, r.requested_at,
    r.reviewer_name_snapshot, r.reviewed_at, r.review_note,
    -- What this caller may actually act on, decided by the same predicate the
    -- write path uses, so the UI cannot offer a button the RPC would refuse.
    public.can_review_pos_request(r.request_type)
      and r.status = 'pending'
      and r.requested_by <> (select auth.uid()),
    count(*) over ()
  from public.pos_inventory_requests r
  left join public.profiles p on p.id = r.requested_by
  where public.can_review_pos_request(r.request_type)
    and (_branch_id is null or r.branch_id = _branch_id)
    and (_status is null or r.status = _status)
  order by r.requested_at desc, r.id desc
  limit public.pos_page_size(_limit)
  offset greatest(0, coalesce(_offset, 0));
$fn$;

revoke all on function public.get_pos_request_queue(uuid, public.pos_request_status, integer, integer)
  from public, anon;
grant execute on function public.get_pos_request_queue(uuid, public.pos_request_status, integer, integer)
  to authenticated;

-- =========================================================================
-- E/F. What Finance is waiting to procure
-- =========================================================================
-- One narrow answer instead of a broad grant. Finance never gains SELECT on
-- pos_inventory_requests: this returns the fields procurement needs and
-- nothing else -- no review notes from other request types, no proposed
-- selling prices, no catalogue proposals.
--
-- Both demand sources in one shape, so the page does not have to know how many
-- kinds of demand exist:
--
--   finance_request  an approved purchase request awaiting procurement
--   pos_restock      a branch asking for more of something it already carries
--
-- A restock appears the moment it is submitted. That is the whole point of the
-- correction: Finance sees it without anybody else acting first.
create or replace function public.get_procurement_demand()
returns table (
  source_kind        text,
  source_id          uuid,
  reference          text,
  title              text,
  branch_id          uuid,
  branch_name        text,
  product_id         uuid,
  requested_quantity integer,
  amount             numeric,
  reason             text,
  requested_by_name  text,
  requested_at       timestamptz,
  demand_state       text,
  purchase_order_id  uuid,
  purchase_order_no  text,
  purchase_order_status text
)
language sql
stable
security definer
set search_path = ''
as $fn$
  with allowed as (
    select public.can_read_finance_master() as ok
  )
  -- Approved purchase requests awaiting procurement.
  select
    'finance_request'::text,
    r.id,
    r.request_no,
    r.title,
    null::uuid,
    null::text,
    null::uuid,
    null::integer,
    r.amount,
    r.justification,
    coalesce(pr.full_name, 'Unknown'),
    r.created_at,
    case when po.id is null then 'awaiting_procurement' else 'ordered' end,
    po.id,
    po.po_number,
    po.status
  from public.finance_requests r
  cross join allowed a
  left join public.profiles pr on pr.id = r.requester_id
  left join lateral (
    select p.id, p.po_number, p.status
    from public.purchase_order_sources s
    join public.purchase_orders p on p.id = s.purchase_order_id
    where s.finance_request_id = r.id
      and p.status not in ('cancelled', 'rejected')
    order by p.created_at desc limit 1
  ) po on true
  where a.ok and r.status = 'approved' and r.type = 'purchase'

  union all

  -- Branch restock demand, visible from the moment it is submitted.
  select
    'pos_restock'::text,
    q.id,
    'Stock request',
    coalesce(q.product_name_snapshot, 'Branch stock'),
    q.branch_id,
    q.branch_name_snapshot,
    q.product_id,
    q.requested_quantity,
    null::numeric,
    q.reason,
    coalesce(q.requester_name_snapshot, 'Unknown'),
    q.requested_at,
    case
      when q.status = 'pending' then 'awaiting_finance_review'
      when po.id is not null then 'ordered'
      else 'accepted_for_procurement'
    end,
    po.id,
    po.po_number,
    po.status
  from public.pos_inventory_requests q
  cross join allowed a
  left join lateral (
    select p.id, p.po_number, p.status
    from public.purchase_order_sources s
    join public.purchase_orders p on p.id = s.purchase_order_id
    where s.pos_inventory_request_id = q.id
      and p.status not in ('cancelled', 'rejected')
    order by p.created_at desc limit 1
  ) po on true
  where a.ok
    and q.request_type = 'restock'
    and q.status in ('pending', 'approved')

  order by 12 desc;
$fn$;

revoke all on function public.get_procurement_demand() from public, anon;
grant execute on function public.get_procurement_demand() to authenticated;

comment on function public.get_procurement_demand() is
  'Everything Finance is waiting to procure: approved purchase requests and '
  'branch restock demand, the latter visible from submission with no '
  'Administrator step. Returns procurement fields only -- Finance is never '
  'granted SELECT on pos_inventory_requests.';

-- =========================================================================
-- A. A vendor''s details are checked by the database too
-- =========================================================================
-- The form will check these as well, but a form is a convenience and this is
-- the rule. Anything reaching the table through the API, a script or a future
-- import meets the same standard.
--
-- Normalisation runs first so the constraints judge one canonical shape rather
-- than whatever spacing somebody typed: two vendors cannot end up with the same
-- TIN written differently.
create or replace function public.normalise_vendor()
returns trigger
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  _digits text;
begin
  new.name := nullif(btrim(regexp_replace(new.name, '\s+', ' ', 'g')), '');

  new.contact_person := nullif(btrim(regexp_replace(coalesce(new.contact_person, ''), '\s+', ' ', 'g')), '');
  new.email := nullif(lower(btrim(coalesce(new.email, ''))), '');
  new.phone := nullif(btrim(coalesce(new.phone, '')), '');
  new.address := nullif(btrim(coalesce(new.address, '')), '');

  -- TIN is stored in one shape: 000-000-000-00000. Whatever separators arrive,
  -- the digits are what matter and the canonical form is what is kept.
  if nullif(btrim(coalesce(new.tin, '')), '') is null then
    new.tin := null;
  else
    _digits := regexp_replace(new.tin, '[^0-9]', '', 'g');
    -- Only reformat a genuine 14-digit TIN. Anything else is left as supplied
    -- so the constraint below rejects it and says so, rather than being
    -- silently reshaped into something that looks valid.
    if length(_digits) = 14 and new.tin ~ '^[0-9\-\s]+$' then
      new.tin := substr(_digits, 1, 3) || '-' || substr(_digits, 4, 3) || '-'
              || substr(_digits, 7, 3) || '-' || substr(_digits, 10, 5);
    end if;
  end if;

  return new;
end;
$fn$;

revoke all on function public.normalise_vendor() from public, anon, authenticated;

drop trigger if exists trg_normalise_vendor on public.vendors;
create trigger trg_normalise_vendor
  before insert or update on public.vendors
  for each row execute function public.normalise_vendor();

alter table public.vendors drop constraint if exists vendors_tin_format;
alter table public.vendors add constraint vendors_tin_format check (
  tin is null or tin ~ '^[0-9]{3}-[0-9]{3}-[0-9]{3}-[0-9]{5}$'
);

alter table public.vendors drop constraint if exists vendors_email_format;
alter table public.vendors add constraint vendors_email_format check (
  email is null or email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[A-Za-z]{2,}$'
);

-- Digits only. A leading + or any separator is refused rather than stripped:
-- silently changing what somebody typed is how a wrong number gets stored
-- confidently.
alter table public.vendors drop constraint if exists vendors_phone_format;
alter table public.vendors add constraint vendors_phone_format check (
  phone is null or phone ~ '^[0-9]{7,15}$'
);

-- Letters and spaces. [[:alpha:]] is locale-aware, so accented and non-Latin
-- names pass; digits and punctuation do not.
alter table public.vendors drop constraint if exists vendors_contact_person_format;
alter table public.vendors add constraint vendors_contact_person_format check (
  contact_person is null or contact_person ~ '^[[:alpha:]]+( [[:alpha:]]+)*$'
);

-- A TIN identifies one business. Two vendors sharing one is a data error, and
-- because storage is canonical this cannot be defeated by spacing.
create unique index if not exists vendors_tin_unique
  on public.vendors (tin) where tin is not null;
