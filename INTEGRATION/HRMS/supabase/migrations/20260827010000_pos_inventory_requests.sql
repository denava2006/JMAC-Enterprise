-- Phase 8, part 2 of 2: POS inventory and product requests.
--
-- A POS Manager can say "this branch needs more of X" or "this branch should
-- carry X". They cannot buy anything, receive anything, or move a single unit
-- of stock, and neither can whoever reviews the request.
--
-- ---------------------------------------------------------------------------
-- WHAT AN APPROVAL MEANS, AND WHAT IT DOES NOT
--
--   approved  =  this branch demand is legitimate and may proceed to
--                procurement
--
--   approved  ≠  budget approved
--             ≠  vendor selected
--             ≠  purchase authorized
--             ≠  stock received
--
-- POS request review and FMS procurement approval are two different business
-- decisions made by two different authorities. This table records the first
-- one only.
--
-- ---------------------------------------------------------------------------
-- WHO REVIEWS, AND WHY THAT IS NOT WRITTEN DOWN HERE
--
--   restock                  the Administrator reviews this TODAY as a
--                            temporary stand-in. Restock is ultimately a
--                            procurement decision -- what to buy, from whom,
--                            against which budget -- and belongs to FMS.
--
--   carry_existing_product   the Administrator reviews this PERMANENTLY. It is
--                            an enterprise catalogue and branch-carrying
--                            decision, involves no money and no vendor, and
--                            lives where pos_products and pos_branch_products
--                            already live.
--
-- Both read is_admin() today and look identical in can_review_pos_request().
-- They are not the same thing: one is a placeholder with a shelf life, the
-- other is the intended end state. That function is the ONLY place either is
-- decided, so FMS integration changes one function body and leaves this table,
-- the RPCs, the queue, the UI and the tests untouched.
--
-- The row itself names no role. reviewed_by / reviewed_at / review_note are
-- generic: they record WHO decided and when, never "an Administrator did this".
--
-- ---------------------------------------------------------------------------
-- THE FMS BOUNDARY
--
-- INTEGRATION/FMS already owns a request system -- requests, request_approvals,
-- vendors, budgets, payments, journal_entries -- whose rows carry amount,
-- vendor_id, budget_id, category_id and payment_schedule, and whose lifecycle
-- is a finance approval chain. That answers "may we spend this money". This
-- table answers "is this branch genuinely short of stock". Different question,
-- different approver, different lifecycle.
--
-- They stay non-competing only while THIS TABLE HAS NO PROCUREMENT COLUMNS.
-- amount, vendor_id, supplier_id, budget_id, unit_cost, payment_schedule and
-- total_value are absent deliberately, and pos_requests_rls.sql asserts their
-- absence on every run. The day one of them appears, Phase 8 has become a
-- second purchasing system.
--
-- When FMS integrates, the link is an explicit bridge -- an FMS request
-- reference or a bridge table -- NOT an extra column overloading the reviewer
-- fields above.

-- ------------------------------------------------------------------- enums

create type public.pos_request_type as enum (
  -- More of a product this branch already carries.
  'restock',
  -- An existing enterprise product this branch does not carry yet.
  'carry_existing_product'
  -- 'new_product' is deliberately absent. A manager proposing a name, a
  -- category and a price is proposing enterprise taxonomy and pricing, which
  -- Phase 3 made Administrator-only. Approving it would either manufacture an
  -- incomplete pos_products row or mean "approved, now go build it by hand".
  -- Neither is worth weak semantics; it gets its own phase or none.
);

create type public.pos_request_status as enum (
  'pending',
  'approved',
  'declined',
  'cancelled'
  -- 'fulfilled' is deliberately absent. Fulfilment means stock arrived, which
  -- means receiving, which is FMS-adjacent. With no FMS and no link from
  -- receive_pos_stock, nothing could set it truthfully -- it would be a status
  -- a human ticks by hand. A state nobody can transition honestly is worse
  -- than no state.
);

-- ------------------------------------------------------------ authorization
--
-- The single swap point. When FMS takes over restock demand review, this
-- function changes and nothing else does.
create or replace function public.can_review_pos_request(
  _request_type public.pos_request_type
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select case _request_type
    -- INTERIM. Restock is a procurement decision and belongs to FMS. The
    -- Administrator stands in only because FMS is not integrated yet.
    when 'restock' then public.is_admin()
    -- PERMANENT. A catalogue and branch-carrying decision, with no money in it.
    when 'carry_existing_product' then public.is_admin()
  end;
$$;

-- ------------------------------------------------------------------- table

create table public.pos_inventory_requests (
  id uuid primary key default gen_random_uuid(),

  branch_id uuid not null references public.branches(id) on delete restrict,
  -- NOT NULL for both current types, which is what deferring 'new_product'
  -- buys: no nullable product, no conditional product constraint.
  product_id uuid not null references public.pos_products(id) on delete restrict,
  request_type public.pos_request_type not null,

  -- What the manager is asking for. A requested amount and nothing more: no
  -- price, no cost, no value.
  requested_quantity integer,
  reason text not null,

  status public.pos_request_status not null default 'pending',

  -- Actors, always derived from auth.uid() in the RPCs. A client cannot name
  -- either of these.
  requested_by uuid not null,
  requested_at timestamptz not null default now(),
  reviewed_by uuid,
  reviewed_at timestamptz,
  review_note text,

  -- History survives a product rename, a branch rename, a person's name
  -- change, and revocation of the requester's assignment.
  branch_name_snapshot text not null,
  product_name_snapshot text not null,
  requester_name_snapshot text not null,
  reviewer_name_snapshot text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint pos_request_quantity_only_for_restock check (
    (request_type = 'restock' and requested_quantity between 1 and 100000)
    or (request_type = 'carry_existing_product' and requested_quantity is null)
  ),
  -- A decline without a reason is not a decision anyone can act on.
  constraint pos_request_decline_needs_a_note check (
    status <> 'declined'
    or nullif(btrim(coalesce(review_note, '')), '') is not null
  ),
  -- Reviewed states carry a reviewer; pending and cancelled do not.
  constraint pos_request_reviewed_states_have_a_reviewer check (
    (status in ('pending', 'cancelled') and reviewed_by is null and reviewed_at is null)
    or (status in ('approved', 'declined') and reviewed_by is not null and reviewed_at is not null)
  ),
  constraint pos_request_bounded_text check (
    length(btrim(reason)) between 1 and 500
    and (review_note is null or length(review_note) <= 500)
    and length(branch_name_snapshot) between 1 and 200
    and length(product_name_snapshot) between 1 and 200
    and length(requester_name_snapshot) between 1 and 200
    and (reviewer_name_snapshot is null or length(reviewer_name_snapshot) <= 200)
  )
);

comment on table public.pos_inventory_requests is
  'POS branch demand signals. Approval means the demand is legitimate and may '
  'proceed to procurement -- never that budget, vendor, purchase or stock have '
  'been settled. Carries no procurement or accounting columns; those belong to '
  'FMS. No client may read or write it directly.';

-- Only a PENDING request blocks a duplicate. Approved must not block: there is
-- no 'fulfilled' state, so an approved request would otherwise lock that
-- branch/product pair forever. Accidental double-submits are what this
-- prevents; a deliberate second request after approval is legitimate, and the
-- manager's own list shows them what is already approved before they submit.
create unique index pos_inventory_requests_one_pending
  on public.pos_inventory_requests (branch_id, product_id, request_type)
  where status = 'pending';

create index pos_inventory_requests_branch_idx
  on public.pos_inventory_requests (branch_id, requested_at desc, id desc);
create index pos_inventory_requests_queue_idx
  on public.pos_inventory_requests (status, requested_at desc, id desc);
create index pos_inventory_requests_requester_idx
  on public.pos_inventory_requests (requested_by, requested_at desc, id desc);

create trigger trg_pos_inventory_requests_updated_at
  before update on public.pos_inventory_requests
  for each row execute function public.set_updated_at();

-- ------------------------------------------------------------ audit events
--
-- Extends the Phase 7C stream. All four are manager-visible: it is the
-- manager's own request at their own branch.
create or replace function public.pos_audit_is_manager_visible(
  _event_type public.pos_audit_event_type
)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select _event_type in (
    'fees_changed',
    'payment_qr_updated',
    'payment_qr_removed',
    'branch_product_added',
    'branch_product_removed',
    'branch_selling_price_changed',
    'product_offered',
    'product_stopped',
    'low_stock_threshold_changed',
    'stock_request_created',
    'stock_request_cancelled',
    'stock_request_approved',
    'stock_request_declined'
  );
$$;

revoke all on function public.pos_audit_is_manager_visible(public.pos_audit_event_type)
  from public, anon, authenticated, service_role;

-- ------------------------------------------------------------------ writer
--
-- One private helper so every lifecycle event is written the same way and the
-- audit call sites stay short. Not reachable from any API role.
create or replace function public.pos_request_audit(
  _request public.pos_inventory_requests,
  _event_type public.pos_audit_event_type,
  _admin_description text,
  _old text,
  _new text
)
returns void
language sql
security definer
set search_path = ''
as $fn$
  select public.pos_audit_write(
    _event_type, 'inventory_request', _request.id, _request.branch_id,
    _request.product_name_snapshot,
    _admin_description, _old, _new, _old, _new);
$fn$;

-- ----------------------------------------------------------- create: restock
--
-- "This branch needs more of a product it already carries."
create or replace function public.create_pos_stock_request(
  _branch_id uuid,
  _product_id uuid,
  _requested_quantity integer,
  _reason text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  _row public.pos_inventory_requests;
  _actor uuid := (select auth.uid());
  _requester text;
  _branch text;
  _product text;
begin
  if _actor is null then
    raise exception 'Sign in to submit a request';
  end if;
  -- Branch-specific. A manager at Cavite cannot raise demand for Main Office,
  -- whatever the client sent.
  if not public.has_pos_role(_branch_id, array['manager']::public.pos_role[]) then
    raise exception 'You do not manage that branch';
  end if;
  if _requested_quantity is null or _requested_quantity < 1 or _requested_quantity > 100000 then
    raise exception 'Requested quantity must be between 1 and 100000';
  end if;
  if nullif(btrim(coalesce(_reason, '')), '') is null then
    raise exception 'A reason is required';
  end if;

  select p.name into _product from public.pos_products p
   where p.id = _product_id and p.status = 'active';
  if _product is null then
    raise exception 'That product is not available';
  end if;
  -- Restock is for something the branch already carries. Asking for more of
  -- something it does not stock is a carry request, not a restock.
  if not exists (
    select 1 from public.pos_branch_products bp
     where bp.branch_id = _branch_id and bp.product_id = _product_id
  ) then
    raise exception 'This branch does not carry that product yet';
  end if;

  select b.name into _branch from public.branches b where b.id = _branch_id;
  select coalesce(nullif(btrim(pr.full_name), ''), 'Unknown') into _requester
    from public.profiles pr where pr.id = _actor;

  insert into public.pos_inventory_requests (
    branch_id, product_id, request_type, requested_quantity, reason,
    requested_by, branch_name_snapshot, product_name_snapshot, requester_name_snapshot)
  values (
    _branch_id, _product_id, 'restock', _requested_quantity, btrim(_reason),
    _actor, _branch, _product, _requester)
  returning * into _row;

  perform public.pos_request_audit(_row, 'stock_request_created',
    'Stock request submitted', null, _requested_quantity || ' requested');
  return _row.id;
exception
  when unique_violation then
    raise exception 'There is already an open request for this product at this branch';
end;
$fn$;

-- ------------------------------------------------- create: carry a product
--
-- "This branch should carry a product the business already sells elsewhere."
create or replace function public.create_pos_carry_request(
  _branch_id uuid,
  _product_id uuid,
  _reason text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  _row public.pos_inventory_requests;
  _actor uuid := (select auth.uid());
  _requester text;
  _branch text;
  _product text;
begin
  if _actor is null then
    raise exception 'Sign in to submit a request';
  end if;
  if not public.has_pos_role(_branch_id, array['manager']::public.pos_role[]) then
    raise exception 'You do not manage that branch';
  end if;
  if nullif(btrim(coalesce(_reason, '')), '') is null then
    raise exception 'A reason is required';
  end if;

  select p.name into _product from public.pos_products p
   where p.id = _product_id and p.status = 'active';
  if _product is null then
    raise exception 'That product is not available';
  end if;
  if exists (
    select 1 from public.pos_branch_products bp
     where bp.branch_id = _branch_id and bp.product_id = _product_id
  ) then
    raise exception 'This branch already carries that product';
  end if;

  select b.name into _branch from public.branches b where b.id = _branch_id;
  select coalesce(nullif(btrim(pr.full_name), ''), 'Unknown') into _requester
    from public.profiles pr where pr.id = _actor;

  insert into public.pos_inventory_requests (
    branch_id, product_id, request_type, reason,
    requested_by, branch_name_snapshot, product_name_snapshot, requester_name_snapshot)
  values (
    _branch_id, _product_id, 'carry_existing_product', btrim(_reason),
    _actor, _branch, _product, _requester)
  returning * into _row;

  perform public.pos_request_audit(_row, 'stock_request_created',
    'Carry request submitted', null, 'requested');
  return _row.id;
exception
  when unique_violation then
    raise exception 'There is already an open request for this product at this branch';
end;
$fn$;

-- ------------------------------------------------------------------ cancel
--
-- The requester's own withdrawal, and only while nobody has decided. After a
-- decision, withdrawing is a conversation rather than a button.
create or replace function public.cancel_pos_request(_request_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  _row public.pos_inventory_requests;
  _actor uuid := (select auth.uid());
begin
  if _actor is null then
    raise exception 'Sign in to cancel a request';
  end if;

  -- Row lock, then re-check: a cancel racing a decision must lose cleanly
  -- rather than overwrite it.
  select * into _row from public.pos_inventory_requests
   where id = _request_id for update;
  if not found then
    raise exception 'That request is not available';
  end if;
  if _row.requested_by <> _actor then
    raise exception 'That request is not available';
  end if;
  if _row.status <> 'pending' then
    raise exception 'That request has already been reviewed';
  end if;

  update public.pos_inventory_requests
     set status = 'cancelled'
   where id = _request_id and status = 'pending'
  returning * into _row;

  perform public.pos_request_audit(_row, 'stock_request_cancelled',
    'Request withdrawn by the requester', 'pending', 'cancelled');
end;
$fn$;

-- ------------------------------------------------------------------ review
--
-- Approve. For a restock this means only: the branch demand is legitimate and
-- may proceed to procurement. It is NOT budget approval, NOT vendor selection,
-- NOT a purchase authorization, and NOT a receipt of stock. No inventory row is
-- touched anywhere in this function.
create or replace function public.approve_pos_request(
  _request_id uuid,
  _note text default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  _row public.pos_inventory_requests;
  _actor uuid := (select auth.uid());
  _reviewer text;
begin
  if _actor is null then
    raise exception 'Sign in to review a request';
  end if;

  select * into _row from public.pos_inventory_requests
   where id = _request_id for update;
  if not found then
    raise exception 'That request is not available';
  end if;
  if not public.can_review_pos_request(_row.request_type) then
    raise exception 'You may not review that request';
  end if;
  if _row.status <> 'pending' then
    raise exception 'That request has already been reviewed';
  end if;
  -- Reviewing your own request defeats the review.
  if _row.requested_by = _actor then
    raise exception 'You cannot review a request you submitted yourself';
  end if;

  select coalesce(nullif(btrim(pr.full_name), ''), 'Unknown') into _reviewer
    from public.profiles pr where pr.id = _actor;

  update public.pos_inventory_requests
     set status = 'approved',
         reviewed_by = _actor,
         reviewed_at = now(),
         review_note = nullif(btrim(coalesce(_note, '')), ''),
         reviewer_name_snapshot = _reviewer
   -- The status predicate is the concurrency guard: of two reviewers pressing
   -- at once, exactly one UPDATE matches a pending row.
   where id = _request_id and status = 'pending'
  returning * into _row;
  if not found then
    raise exception 'That request has already been reviewed';
  end if;

  -- Approving a carry request creates the branch listing, switched OFF. The
  -- existing trg_create_branch_inventory makes the inventory row at ZERO, and
  -- the Phase 7C trigger emits branch_product_added, so this needs no audit of
  -- its own. The manager still consciously offers it from Inventory, which is
  -- their Phase 7A power and is itself audited.
  --
  -- A restock approval creates NOTHING. There is deliberately no branch of
  -- this `if` that touches quantity_on_hand.
  if _row.request_type = 'carry_existing_product'
     and not exists (
       select 1 from public.pos_branch_products bp
        where bp.branch_id = _row.branch_id and bp.product_id = _row.product_id
     ) then
    insert into public.pos_branch_products (branch_id, product_id, is_available)
    values (_row.branch_id, _row.product_id, false);
  end if;

  perform public.pos_request_audit(_row, 'stock_request_approved',
    case _row.request_type
      when 'restock' then 'Stock request approved -- may proceed to procurement'
      else 'Carry request approved -- branch listing created, not yet offered'
    end,
    'pending', 'approved');
end;
$fn$;

-- Decline. A note is required: a refusal nobody can act on is not a decision.
create or replace function public.decline_pos_request(
  _request_id uuid,
  _note text
)
returns void
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  _row public.pos_inventory_requests;
  _actor uuid := (select auth.uid());
  _reviewer text;
begin
  if _actor is null then
    raise exception 'Sign in to review a request';
  end if;
  if nullif(btrim(coalesce(_note, '')), '') is null then
    raise exception 'A reason is required when declining a request';
  end if;

  select * into _row from public.pos_inventory_requests
   where id = _request_id for update;
  if not found then
    raise exception 'That request is not available';
  end if;
  if not public.can_review_pos_request(_row.request_type) then
    raise exception 'You may not review that request';
  end if;
  if _row.status <> 'pending' then
    raise exception 'That request has already been reviewed';
  end if;
  if _row.requested_by = _actor then
    raise exception 'You cannot review a request you submitted yourself';
  end if;

  select coalesce(nullif(btrim(pr.full_name), ''), 'Unknown') into _reviewer
    from public.profiles pr where pr.id = _actor;

  update public.pos_inventory_requests
     set status = 'declined',
         reviewed_by = _actor,
         reviewed_at = now(),
         review_note = btrim(_note),
         reviewer_name_snapshot = _reviewer
   where id = _request_id and status = 'pending'
  returning * into _row;
  if not found then
    raise exception 'That request has already been reviewed';
  end if;

  perform public.pos_request_audit(_row, 'stock_request_declined',
    'Request declined', 'pending', 'declined');
end;
$fn$;

-- ------------------------------------------------------- the manager's list
--
-- Their own branch. The reviewer's name and note are included -- a decision
-- whose reason is withheld is not a decision -- but nothing about who holds the
-- authority, which is an FMS concept a branch manager does not need yet.
create or replace function public.get_pos_manager_requests(
  _branch_id uuid,
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
  requested_at timestamptz,
  reviewer_name text,
  reviewed_at timestamptz,
  review_note text,
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
    r.requested_by, r.requester_name_snapshot, r.requested_at,
    r.reviewer_name_snapshot, r.reviewed_at, r.review_note,
    count(*) over ()
  from public.pos_inventory_requests r
  where r.branch_id = _branch_id
    and public.has_pos_role(_branch_id, array['manager']::public.pos_role[])
    and (_status is null or r.status = _status)
  order by r.requested_at desc, r.id desc
  limit public.pos_page_size(_limit)
  offset greatest(0, coalesce(_offset, 0));
$fn$;

-- --------------------------------------------------------- the review queue
--
-- Named for the job, not the role. When FMS takes over restock review it calls
-- this same queue -- a function called get_admin_* would then be lying.
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
    public.can_review_pos_request(r.request_type) and r.status = 'pending'
      and r.requested_by <> (select auth.uid()),
    count(*) over ()
  from public.pos_inventory_requests r
  left join public.profiles p on p.id = r.requested_by
  where public.can_review_pos_request('restock')
     or public.can_review_pos_request('carry_existing_product')
  and (_branch_id is null or r.branch_id = _branch_id)
  and (_status is null or r.status = _status)
  order by r.requested_at desc, r.id desc
  limit public.pos_page_size(_limit)
  offset greatest(0, coalesce(_offset, 0));
$fn$;

-- ------------------------------------------------------------- RLS and ACL
--
-- Unreachable from every API role: no policies, so RLS denies by default, and
-- the grants are removed so PostgREST refuses before RLS is consulted. Reads
-- and writes are RPC-only.
--
-- TRUNCATE is revoked explicitly. 20260826030000 revoked it from anon and
-- authenticated generally and fixed the default privileges, but ACL incident
-- six is worth stating locally: RLS filters rows and TRUNCATE is not a row
-- operation, so no policy would ever be consulted.
alter table public.pos_inventory_requests enable row level security;

revoke all on table public.pos_inventory_requests
  from public, anon, authenticated, service_role;

revoke all on function public.pos_request_audit(
  public.pos_inventory_requests, public.pos_audit_event_type, text, text, text)
  from public, anon, authenticated, service_role;
revoke all on function public.can_review_pos_request(public.pos_request_type)
  from public, anon;

do $acl$
declare _fn text;
begin
  for _fn in select unnest(array[
    'public.create_pos_stock_request(uuid,uuid,integer,text)',
    'public.create_pos_carry_request(uuid,uuid,text)',
    'public.cancel_pos_request(uuid)',
    'public.approve_pos_request(uuid,text)',
    'public.decline_pos_request(uuid,text)',
    'public.get_pos_manager_requests(uuid,public.pos_request_status,integer,integer)',
    'public.get_pos_request_queue(uuid,public.pos_request_status,integer,integer)'
  ])
  loop
    execute format('revoke all on function %s from public, anon', _fn);
    execute format('grant execute on function %s to authenticated', _fn);
  end loop;
end
$acl$;

grant execute on function public.can_review_pos_request(public.pos_request_type)
  to authenticated;
