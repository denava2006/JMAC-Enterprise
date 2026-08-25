-- What a branch could start carrying.
--
-- A carry request needs a product picker, and a POS Manager cannot read
-- pos_products: its RLS is is_admin(), because the product master carries
-- default_unit_cost. get_branch_catalogue_management() only returns what the
-- branch ALREADY carries, which is the opposite of what this picker needs.
--
-- So: a manager-gated lookup of active enterprise products the branch does not
-- stock yet. Identity and taxonomy only -- no price, no cost, nothing a manager
-- may not see. Without it, carry_existing_product would be a request type with
-- no way to compose one.

create or replace function public.get_pos_carryable_products(_branch_id uuid)
returns table (
  product_id uuid,
  product_name text,
  category_name text
)
language sql
stable
security definer
set search_path = ''
as $fn$
  select p.id, p.name, c.name
  from public.pos_products p
  join public.pos_product_categories c on c.id = p.category_id
  where public.has_pos_role(_branch_id, array['manager']::public.pos_role[])
    -- Only what the business actually sells. A draft or archived product is
    -- not something a branch can ask to carry.
    and p.status = 'active'
    and not exists (
      select 1 from public.pos_branch_products bp
       where bp.branch_id = _branch_id and bp.product_id = p.id
    )
  order by c.sort_order, c.name, p.name;
$fn$;

revoke all on function public.get_pos_carryable_products(uuid) from public, anon;
grant execute on function public.get_pos_carryable_products(uuid) to authenticated;
