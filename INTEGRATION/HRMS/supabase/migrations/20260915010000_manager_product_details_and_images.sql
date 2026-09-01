-- A manager can name a product and put a picture on it.
--
-- The image infrastructure already existed -- the pos-product-images bucket,
-- generated object paths, MIME and size validation, signed URL delivery -- and
-- was simply never reachable by anyone but an Administrator. So this grants
-- access to what is there rather than building a second image system.
--
-- Editing goes through narrow functions rather than a table policy on purpose.
-- A blanket UPDATE on pos_products would let a manager write default_unit_cost,
-- which is the one thing they must never touch; a function that accepts a name
-- and a category cannot be persuaded to write anything else.
--
-- These are GLOBAL fields. The catalogue is company-wide, so renaming a product
-- renames it for every branch carrying it, and the screen says so before the
-- manager confirms. Branch-scoped values -- the selling price override, whether
-- it is offered, the low-stock level -- stay where they were.

-- ------------------------------------------------------------ the image
-- Managers write, cashiers do not. Reading is unchanged: has_pos_access, so a
-- till can render what it sells.
drop policy if exists "pos_product_images_manager_insert" on storage.objects;
create policy "pos_product_images_manager_insert"
  on storage.objects for insert
  to authenticated
  with check (
    bucket_id = 'pos-product-images'
    and public.has_pos_role(null, array['manager']::public.pos_role[])
  );

drop policy if exists "pos_product_images_manager_update" on storage.objects;
create policy "pos_product_images_manager_update"
  on storage.objects for update
  to authenticated
  using (
    bucket_id = 'pos-product-images'
    and public.has_pos_role(null, array['manager']::public.pos_role[])
  )
  with check (
    bucket_id = 'pos-product-images'
    and public.has_pos_role(null, array['manager']::public.pos_role[])
  );

-- The row only records where the picture lives. Separated from the details
-- function because uploading and renaming are different actions with different
-- failure modes -- a failed upload should not roll back a rename.
create or replace function public.set_pos_product_image(
  _product_id uuid,
  _image_path text
)
returns void
language plpgsql
security definer
set search_path = ''
as $fn$
begin
  if not (public.is_admin() or public.has_pos_role(null, array['manager']::public.pos_role[])) then
    raise exception 'POS_PRODUCT_FORBIDDEN';
  end if;

  update public.pos_products
     set image_path = nullif(btrim(_image_path), ''), updated_at = now()
   where id = _product_id;

  if not found then
    raise exception 'POS_PRODUCT_NOT_FOUND';
  end if;
end;
$fn$;

-- ---------------------------------------------------------- name, category
create or replace function public.update_pos_product_details(
  _product_id uuid,
  _name text,
  _category_id uuid
)
returns void
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  _clean text := btrim(coalesce(_name, ''));
begin
  if not (public.is_admin() or public.has_pos_role(null, array['manager']::public.pos_role[])) then
    raise exception 'POS_PRODUCT_FORBIDDEN';
  end if;

  if _clean = '' then
    raise exception 'POS_PRODUCT_NAME_REQUIRED';
  end if;

  if not exists (select 1 from public.pos_product_categories where id = _category_id and is_active) then
    raise exception 'POS_CATEGORY_NOT_FOUND';
  end if;

  -- Renaming a product onto another product's name would merge two things that
  -- are not the same thing. The unique index refuses it; this names the reason.
  if exists (
    select 1 from public.pos_products
     where normalized_name = lower(regexp_replace(_clean, '\s+', ' ', 'g'))
       and id <> _product_id
  ) then
    raise exception 'POS_PRODUCT_EXISTS';
  end if;

  -- Cost, status and price are absent by construction. This function can write
  -- a name and a category and nothing else, whoever calls it.
  update public.pos_products
     set name = _clean, category_id = _category_id, updated_at = now()
   where id = _product_id;

  if not found then
    raise exception 'POS_PRODUCT_NOT_FOUND';
  end if;
end;
$fn$;

revoke all on function public.set_pos_product_image(uuid, text) from public, anon;
revoke all on function public.update_pos_product_details(uuid, text, uuid) from public, anon;
grant execute on function public.set_pos_product_image(uuid, text) to authenticated;
grant execute on function public.update_pos_product_details(uuid, text, uuid) to authenticated;

comment on function public.update_pos_product_details(uuid, text, uuid) is
  'Renames or recategorises a catalogue product. GLOBAL: the change applies to '
  'every branch carrying it. Writes name and category only -- cost, price and '
  'status are unreachable through this path.';
