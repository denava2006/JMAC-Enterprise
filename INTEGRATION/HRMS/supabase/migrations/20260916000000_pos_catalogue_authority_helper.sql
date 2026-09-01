-- One answer to "may this account change the catalogue?"
--
-- add_pos_product_to_branch, create_pos_product_for_branch,
-- set_pos_product_image and update_pos_product_details each ask the same
-- question inline. The image importer runs in an Edge Function and has to ask
-- it too, from outside the database -- and an authorization rule that is
-- written out four times is a rule that eventually says four different things.
--
-- Nothing about who may do what changes here. This is the existing condition,
-- named once so the Edge Function calls the same rule the RPCs enforce rather
-- than carrying its own copy of it.

create or replace function public.can_manage_pos_catalogue()
returns boolean
language sql
stable
security definer
set search_path = ''
as $fn$
  select public.is_admin()
      or public.has_pos_role(null, array['manager']::public.pos_role[]);
$fn$;

revoke all on function public.can_manage_pos_catalogue() from public, anon;
grant execute on function public.can_manage_pos_catalogue() to authenticated;

comment on function public.can_manage_pos_catalogue() is
  'True for an Administrator, or a manager at any branch. The catalogue is '
  'company-wide, so this is not branch-scoped -- anything that acts ON a branch '
  'still checks has_pos_role for that branch separately.';
