-- A public answer to "where are you?", and nothing else
--
-- The landing page needs to list branches. The branches table is not the thing
-- to hand it: every SELECT policy on that table targets `authenticated`, and
-- the honest way to publish a subset is to publish the subset -- not to widen
-- the table's policies and hope the client only asks for the safe columns.
--
-- So this view is the public surface, and it is narrow by construction. What
-- reaches the open web is what a visitor could read off a shopfront: the name,
-- the street address, and where it is on a map.
--
-- Deliberately NOT exposed:
--   phone            -- an operational contact, printed on receipts
--   is_active        -- an internal state; the filter below is the answer
--   created_at,
--   updated_at       -- administrative metadata, of no use to a visitor
-- and nothing at all from branch_pos_settings, pos_branch_assignments,
-- inventory, finance or any other table. The view names its columns one by one
-- rather than selecting *, so a column added to branches later is not
-- published by accident.

create or replace view public.public_branch_locations
with (security_invoker = off) as
  select
    b.id,
    b.name,
    b.address,
    b.latitude,
    b.longitude
  from public.branches b
  -- Only trading locations. An archived branch stops being somewhere the
  -- public can visit the moment it is archived, with no second switch to
  -- forget: this is the same is_active the back office already maintains.
  where b.is_active;

comment on view public.public_branch_locations is
  'Public-safe branch list for the landing page: name, address and coordinates of active branches only. security_invoker is off on purpose -- the view is the authorization boundary, so the underlying table keeps its authenticated-only policies.';

-- The view runs as its owner, which is what lets an anonymous visitor read
-- active branches without branches itself being readable. That is the whole
-- point, and it is why the column list above is explicit.
--
-- The revoke names anon and authenticated, not just PUBLIC, and that matters.
-- Supabase ships default privileges granting ALL on new tables and views in
-- this schema to both roles, so a fresh view arrives already writable by
-- anonymous visitors -- and because security_invoker is off, a write through
-- it would reach the branches table as the view's owner and bypass RLS
-- altogether. A single-table view like this one is auto-updatable, so that is
-- not theoretical: it would have let anybody on the internet create a branch.
-- Revoking from PUBLIC alone does not touch a grant held by anon directly.
revoke all on public.public_branch_locations from public, anon, authenticated;
grant select on public.public_branch_locations to anon, authenticated;
