-- The rules for the new_product request type.
--
-- Separate from 20260906000000 because Postgres will not let a new enum value
-- be USED in the same transaction that adds it, and every constraint and
-- function below names it.

-- ------------------------------------------------------------- the shape
-- Which columns each request type may carry. A proposal has no product until
-- it is approved; a restock and a carry always have one.
alter table public.pos_inventory_requests
  drop constraint if exists pos_request_product_for_existing_types;
alter table public.pos_inventory_requests
  add constraint pos_request_product_for_existing_types check (
    (request_type in ('restock', 'carry_existing_product') and product_id is not null)
    or request_type = 'new_product'
  );

-- Quantity stays restock-only. A proposal deliberately does NOT collect an
-- opening quantity: approving it must not create stock, and a number in the
-- row would invite exactly that.
alter table public.pos_inventory_requests
  drop constraint if exists pos_request_quantity_only_for_restock;
alter table public.pos_inventory_requests
  add constraint pos_request_quantity_only_for_restock check (
    (request_type = 'restock' and requested_quantity between 1 and 100000)
    or (request_type in ('carry_existing_product', 'new_product') and requested_quantity is null)
  );

-- The proposal columns belong to proposals and nothing else.
alter table public.pos_inventory_requests
  drop constraint if exists pos_request_proposal_fields;
alter table public.pos_inventory_requests
  add constraint pos_request_proposal_fields check (
    request_type = 'new_product'
    or (proposed_category_id is null
        and proposed_description is null
        and proposed_selling_price is null)
  );

alter table public.pos_inventory_requests
  drop constraint if exists pos_request_proposal_is_complete;
alter table public.pos_inventory_requests
  add constraint pos_request_proposal_is_complete check (
    request_type <> 'new_product'
    or (proposed_category_id is not null
        and proposed_selling_price is not null
        and proposed_selling_price > 0
        and proposed_selling_price <= 1000000
        and (proposed_description is null or length(proposed_description) <= 500))
  );

-- ------------------------------------------------------- review authority
-- The CASE had no ELSE, so a request type it did not name returned NULL. In
-- plpgsql `if not null then raise` never fires, so an unnamed type would have
-- been reviewable by anyone signed in. Adding a branch for new_product is the
-- immediate need; the explicit `else false` is the part that matters, because
-- the next type added will not be able to make that mistake.
create or replace function public.can_review_pos_request(_request_type public.pos_request_type)
returns boolean
language sql
stable
security definer
set search_path = ''
as $fn$
  select case _request_type
    -- INTERIM. Restock is a procurement decision and belongs to FMS. The
    -- Administrator stands in only because FMS is not integrated yet.
    when 'restock' then public.is_admin()
    -- PERMANENT. A catalogue and branch-carrying decision, with no money in it.
    when 'carry_existing_product' then public.is_admin()
    -- PERMANENT. Creating an enterprise product is enterprise administration,
    -- whichever branch asked for it.
    when 'new_product' then public.is_admin()
    else false
  end;
$fn$;

revoke all on function public.can_review_pos_request(public.pos_request_type) from public, anon;
grant execute on function public.can_review_pos_request(public.pos_request_type) to authenticated, service_role;

-- ------------------------------------------------------ raising a proposal
create or replace function public.create_pos_new_product_request(
  _branch_id uuid,
  _name text,
  _category_id uuid,
  _selling_price numeric,
  _reason text,
  _description text default null
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
  _clean_name text := nullif(btrim(coalesce(_name, '')), '');
begin
  if _actor is null then
    raise exception 'Sign in to submit a request';
  end if;
  -- Branch-scoped exactly like the other two: a manager may propose for a
  -- branch they manage, and for no other.
  if not public.has_pos_role(_branch_id, array['manager']::public.pos_role[]) then
    raise exception 'You do not manage that branch';
  end if;
  if nullif(btrim(coalesce(_reason, '')), '') is null then
    raise exception 'A reason is required';
  end if;
  if _clean_name is null or length(_clean_name) > 200 then
    raise exception 'A product name of 1-200 characters is required';
  end if;
  if not exists (select 1 from public.pos_product_categories c
                  where c.id = _category_id and c.is_active) then
    raise exception 'Choose an active category';
  end if;
  if _selling_price is null or _selling_price <= 0 or _selling_price > 1000000 then
    raise exception 'Suggest a selling price between 0.01 and 1,000,000';
  end if;

  -- A name that already exists enterprise-wide is a carry request, not a new
  -- product. Saying so is more useful than creating a duplicate catalogue row.
  if exists (
    select 1 from public.pos_products p
     where lower(btrim(p.name)) = lower(_clean_name)
  ) then
    raise exception 'A product with that name already exists -- ask to carry it instead';
  end if;

  if exists (
    select 1 from public.pos_inventory_requests r
     where r.branch_id = _branch_id
       and r.request_type = 'new_product'
       and r.status = 'pending'
       and lower(btrim(r.product_name_snapshot)) = lower(_clean_name)
  ) then
    raise exception 'That product has already been proposed and is awaiting review';
  end if;

  select b.name into _branch from public.branches b where b.id = _branch_id;
  select coalesce(nullif(btrim(pr.full_name), ''), 'Unknown') into _requester
    from public.profiles pr where pr.id = _actor;

  insert into public.pos_inventory_requests (
    branch_id, product_id, request_type, reason, requested_by,
    branch_name_snapshot, product_name_snapshot, requester_name_snapshot,
    proposed_category_id, proposed_description, proposed_selling_price)
  values (
    _branch_id, null, 'new_product', btrim(_reason), _actor,
    _branch, _clean_name, _requester,
    _category_id, nullif(btrim(coalesce(_description, '')), ''), _selling_price)
  returning * into _row;

  perform public.pos_request_audit(_row, 'stock_request_created',
    'New product proposed -- awaiting review', null, 'pending');

  return _row.id;
end;
$fn$;

revoke all on function public.create_pos_new_product_request(uuid, text, uuid, numeric, text, text) from public, anon;
grant execute on function public.create_pos_new_product_request(uuid, text, uuid, numeric, text, text) to authenticated;

-- ------------------------------------------------------ approving a proposal
create or replace function public.approve_pos_request(_request_id uuid, _note text default null)
returns void
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  _row public.pos_inventory_requests;
  _actor uuid := (select auth.uid());
  _reviewer text;
  _new_product uuid;
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

  -- A proposal becomes a real product, carried by the branch that asked, and
  -- switched OFF with no stock. default_unit_cost is 0 because a manager is
  -- never asked for cost; the real cost enters the ledger through receiving,
  -- which is where checkout_pos_sale reads it from anyway
  -- (pos_branch_inventory.average_unit_cost, not this column).
  if _row.request_type = 'new_product' then
    insert into public.pos_products (name, category_id, default_selling_price,
                                     default_unit_cost, status, created_by)
    values (_row.product_name_snapshot, _row.proposed_category_id,
            _row.proposed_selling_price, 0, 'active', _actor)
    returning id into _new_product;

    -- Linking the proposal to what it produced, so the audit trail reads
    -- forwards as well as backwards.
    update public.pos_inventory_requests set product_id = _new_product
     where id = _row.id;
    _row.product_id := _new_product;
  end if;

  -- Approving a carry request creates the branch listing, switched OFF. The
  -- existing trg_create_branch_inventory makes the inventory row at ZERO, and
  -- the Phase 7C trigger emits branch_product_added, so this needs no audit of
  -- its own. A new product takes the same path for the same reason.
  --
  -- A restock approval creates NOTHING. There is deliberately no branch of
  -- this `if` that touches quantity_on_hand.
  if _row.request_type in ('carry_existing_product', 'new_product')
     and _row.product_id is not null
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
      when 'new_product' then 'New product approved -- created and listed at the branch, no stock yet'
      else 'Carry request approved -- branch listing created, not yet offered'
    end,
    'pending', 'approved');
end;
$fn$;

revoke all on function public.approve_pos_request(uuid, text) from public, anon;
grant execute on function public.approve_pos_request(uuid, text) to authenticated;
