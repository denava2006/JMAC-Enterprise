-- A POS Manager can stock their own branch.
--
-- Hosted testing found a manager unable to do the ordinary thing: put a product
-- on their own shelves. Adding a product the company already sells, creating one
-- it does not, naming a category to file it under -- every one of those needed
-- an Administrator, so a new branch could not open without someone else driving.
--
-- The authority granted here is deliberately shaped around one question: what
-- does THIS branch sell, and for how much. It stops firmly short of cost.
-- default_unit_cost is never read, written or returned by anything below, and a
-- manager-created product simply leaves it at its default of 0 for whoever owns
-- procurement to fill in.
--
-- Everything reuses what already works: has_pos_role for branch authorization,
-- the unique normalized_name indexes for duplicate protection, and the existing
-- pos_audit_product / pos_audit_category / pos_audit_branch_product triggers, so
-- every mutation below is audited without any new audit code.

-- --------------------------------------------- add an existing product here
create or replace function public.add_pos_product_to_branch(
  _branch_id uuid,
  _product_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  _id uuid;
begin
  -- Branch authorization first, and from the caller's actual assignments --
  -- never from a branch id the request supplied on its own authority.
  if not (public.is_admin() or public.has_pos_role(_branch_id, array['manager']::public.pos_role[])) then
    raise exception 'POS_BRANCH_FORBIDDEN';
  end if;

  if not exists (select 1 from public.pos_products where id = _product_id and status <> 'archived') then
    raise exception 'POS_PRODUCT_NOT_FOUND';
  end if;

  -- Carrying a product is not stocking it. is_available starts false and no
  -- inventory row is created here: a branch that has agreed to sell something
  -- still has none of it until receiving says otherwise.
  insert into public.pos_branch_products (branch_id, product_id, is_available)
  values (_branch_id, _product_id, false)
  on conflict (branch_id, product_id) do nothing
  returning product_id into _id;

  if _id is null then
    raise exception 'POS_PRODUCT_ALREADY_CARRIED';
  end if;

  return _id;
end;
$fn$;

-- ------------------------------------------------------- create a product
create or replace function public.create_pos_product_for_branch(
  _branch_id uuid,
  _name text,
  _category_id uuid,
  _selling_price numeric
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  _product_id uuid;
  _existing   uuid;
  _clean      text := btrim(coalesce(_name, ''));
begin
  if not (public.is_admin() or public.has_pos_role(_branch_id, array['manager']::public.pos_role[])) then
    raise exception 'POS_BRANCH_FORBIDDEN';
  end if;

  if _clean = '' then
    raise exception 'POS_PRODUCT_NAME_REQUIRED';
  end if;

  if _selling_price is null or _selling_price < 0 then
    raise exception 'POS_PRICE_INVALID';
  end if;

  if not exists (select 1 from public.pos_product_categories where id = _category_id and is_active) then
    raise exception 'POS_CATEGORY_NOT_FOUND';
  end if;

  -- The catalogue is company-wide, so two branches inventing "Coke 1.5L"
  -- separately would be two products, two price lists and two sets of numbers
  -- that never add up. Reported as a distinct error so the screen can offer the
  -- product that already exists rather than repeating the refusal.
  select id into _existing from public.pos_products
   where normalized_name = lower(regexp_replace(_clean, '\s+', ' ', 'g'));

  if _existing is not null then
    raise exception 'POS_PRODUCT_EXISTS:%', _existing;
  end if;

  -- default_unit_cost is deliberately absent: it defaults to 0 and belongs to
  -- whoever buys the stock. Status is active because is_available is what gates
  -- selling, and it starts false -- leaving the product in 'draft' would mean a
  -- manager still needed an Administrator to finish, which is the problem.
  insert into public.pos_products (name, category_id, default_selling_price, status)
  values (_clean, _category_id, _selling_price, 'active')
  returning id into _product_id;

  insert into public.pos_branch_products (branch_id, product_id, is_available)
  values (_branch_id, _product_id, false);

  return _product_id;
end;
$fn$;

-- --------------------------------------------------- price, for this branch
create or replace function public.set_pos_branch_selling_price(
  _branch_id uuid,
  _product_id uuid,
  _price numeric
)
returns void
language plpgsql
security definer
set search_path = ''
as $fn$
begin
  if not (public.is_admin() or public.has_pos_role(_branch_id, array['manager']::public.pos_role[])) then
    raise exception 'POS_BRANCH_FORBIDDEN';
  end if;

  if _price is not null and _price < 0 then
    raise exception 'POS_PRICE_INVALID';
  end if;

  -- The OVERRIDE, never the default. A manager sets what their branch charges;
  -- the company-wide price stays an Administrator's, and the cost stays
  -- invisible to both this function and the manager reading the screen.
  -- Passing null clears the override and returns the branch to the base price.
  update public.pos_branch_products
     set selling_price_override = _price, updated_at = now()
   where branch_id = _branch_id and product_id = _product_id;

  if not found then
    raise exception 'POS_PRODUCT_NOT_CARRIED';
  end if;
end;
$fn$;

-- ------------------------------- pricing is the branch's, isolation is not
-- enforce_branch_product_boundaries did two jobs: it stopped a catalogue entry
-- being moved to another branch or product, and it reserved the selling price
-- for an Administrator. The first is branch isolation and stays absolute. The
-- second is what made a manager ask permission to price their own shelf.
create or replace function public.enforce_branch_product_boundaries()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  if public.is_admin() then
    return new;
  end if;

  -- Absolute. Rewriting branch_id is how a manager would otherwise reach a
  -- branch they do not manage, whatever the request claimed.
  if new.branch_id is distinct from old.branch_id
     or new.product_id is distinct from old.product_id then
    raise exception 'A branch catalogue entry cannot be moved to another branch or product';
  end if;

  -- Checked against OLD.branch_id: the row's real branch, not one the update
  -- might be trying to set.
  if new.selling_price_override is distinct from old.selling_price_override
     and not public.has_pos_role(old.branch_id, array['manager']::public.pos_role[]) then
    raise exception 'Only an Administrator or this branch''s manager can set its selling price';
  end if;

  return new;
end;
$function$;

-- ------------------------------------------------------------- categories
-- Categories are company-wide, so authorization is "manages some branch"
-- rather than a particular one. A manager needs to be able to name a shelf
-- without asking; nobody needs to delete one, so no delete is offered.
create or replace function public.create_pos_category(_name text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  _id uuid;
  _clean text := btrim(coalesce(_name, ''));
begin
  if not (public.is_admin() or public.has_pos_role(null, array['manager']::public.pos_role[])) then
    raise exception 'POS_CATEGORY_FORBIDDEN';
  end if;

  if _clean = '' then
    raise exception 'POS_CATEGORY_NAME_REQUIRED';
  end if;

  -- Case and spacing do not make a different shelf. The unique index on
  -- normalized_name is what actually enforces this; the check here exists to
  -- give the reason rather than a constraint name.
  if exists (
    select 1 from public.pos_product_categories
     where normalized_name = lower(regexp_replace(_clean, '\s+', ' ', 'g'))
  ) then
    raise exception 'POS_CATEGORY_EXISTS';
  end if;

  insert into public.pos_product_categories (name, is_active)
  values (_clean, true)
  returning id into _id;

  return _id;
end;
$fn$;

create or replace function public.rename_pos_category(_category_id uuid, _name text)
returns void
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  _clean text := btrim(coalesce(_name, ''));
begin
  if not (public.is_admin() or public.has_pos_role(null, array['manager']::public.pos_role[])) then
    raise exception 'POS_CATEGORY_FORBIDDEN';
  end if;

  if _clean = '' then
    raise exception 'POS_CATEGORY_NAME_REQUIRED';
  end if;

  if exists (
    select 1 from public.pos_product_categories
     where normalized_name = lower(regexp_replace(_clean, '\s+', ' ', 'g'))
       and id <> _category_id
  ) then
    raise exception 'POS_CATEGORY_EXISTS';
  end if;

  update public.pos_product_categories
     set name = _clean, updated_at = now()
   where id = _category_id;

  if not found then
    raise exception 'POS_CATEGORY_NOT_FOUND';
  end if;
end;
$fn$;

-- ------------------------------------------------------------------ access
-- Callable by signed-in staff; each one decides for itself what the caller may
-- do, from their assignments rather than from the request.
revoke all on function public.add_pos_product_to_branch(uuid, uuid) from public, anon;
revoke all on function public.create_pos_product_for_branch(uuid, text, uuid, numeric) from public, anon;
revoke all on function public.set_pos_branch_selling_price(uuid, uuid, numeric) from public, anon;
revoke all on function public.create_pos_category(text) from public, anon;
revoke all on function public.rename_pos_category(uuid, text) from public, anon;

grant execute on function public.add_pos_product_to_branch(uuid, uuid) to authenticated;
grant execute on function public.create_pos_product_for_branch(uuid, text, uuid, numeric) to authenticated;
grant execute on function public.set_pos_branch_selling_price(uuid, uuid, numeric) to authenticated;
grant execute on function public.create_pos_category(text) to authenticated;
grant execute on function public.rename_pos_category(uuid, text) to authenticated;

comment on function public.create_pos_product_for_branch(uuid, text, uuid, numeric) is
  'Creates a catalogue product and carries it at the caller''s branch. Never '
  'touches default_unit_cost, and creates no inventory: a product exists before '
  'a single unit of it does.';
