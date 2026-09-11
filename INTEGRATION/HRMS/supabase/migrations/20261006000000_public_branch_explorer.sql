-- Publishing a branch to the public landing page.
--
-- THE AUDIT, first, because most of what this needed already existed.
-- `branches` already carries name, address, latitude, longitude and is_active,
-- and `public_branch_locations` is already the anonymous read path -- a view
-- over active branches exposing five columns and granted SELECT to anon. The
-- landing page already reads it, and the Leaflet map already pins from it.
-- None of that is rebuilt here.
--
-- Three things were genuinely missing, and only three:
--
--   show_on_landing   being ACTIVE is an operational fact. A warehouse, a
--                     future site, an internal office and a test branch are all
--                     legitimately active and none of them belongs on a public
--                     page. Publication is a separate decision from operation,
--                     so it gets its own field rather than borrowing is_active's
--                     meaning.
--
--   image_path        a storefront photograph. A path, not the bytes: the row is
--                     read on every landing-page load by anonymous visitors.
--
--   display_order     so the order a visitor sees is a decision somebody took,
--                     not whichever row Postgres happened to return first.
--
-- WHAT HAPPENS TO THE TWO BRANCHES THAT ARE ALREADY THERE. Cavite Branch and
-- Main Office are on the landing page today, and a deployment that silently
-- removed them would be a regression dressed as a feature. So the column
-- DEFAULTS to false -- a branch created tomorrow is private until somebody says
-- otherwise, which is the safe direction for a new record -- and the backfill
-- below publishes exactly the branches that are active right now, which is the
-- set the page is already showing. Nothing appears that was not already public,
-- and nothing that was public disappears.

alter table public.branches
  add column if not exists show_on_landing boolean not null default false,
  add column if not exists image_path text,
  add column if not exists display_order integer not null default 0;

comment on column public.branches.show_on_landing is
  'Whether this location appears on the public landing page. Separate from is_active: a warehouse or an unopened site can be operationally active and still not public.';
comment on column public.branches.image_path is
  'Object path in the branch-images bucket. A path, never the bytes -- this row is read anonymously on every landing-page load.';
comment on column public.branches.display_order is
  'Public ordering, lowest first, name breaking ties. Deterministic on purpose: insertion order is not a design decision.';

-- Only where it is worth constraining. A path has a shape; an order does not.
alter table public.branches
  drop constraint if exists branches_image_path_shape;
alter table public.branches
  add constraint branches_image_path_shape check (
    image_path is null
    or (char_length(image_path) between 1 and 300 and image_path !~ '\.\.')
  );

-- The set the landing page renders today: every active branch. Written as a
-- one-time backfill rather than a column default so that only the rows existing
-- at this moment are published -- a branch created next week starts private.
update public.branches set show_on_landing = true where is_active;

-- ------------------------------------------------------------- the read path
--
-- The same view, widened by exactly the columns the explorer needs. It stays the
-- authorization boundary: the branches table itself is never granted to anon, so
-- there is no column list a public page could ask for that would reach an
-- operational field. `phone` is deliberately still absent -- a branch phone
-- number in this system is an internal contact, and publishing one is a decision
-- nobody has taken.
--
-- The rule is now both facts: operationally live AND published. Either alone is
-- not enough, and saying so here means no caller can get it wrong.
-- NOT security_invoker, and deliberately so -- this is the one place in the
-- system where that is the right answer. Elsewhere a view over protected data
-- gets security_invoker precisely so RLS still applies to the caller; here the
-- caller is anonymous and has no policy on `branches` at all, so an invoker view
-- would return them nothing and the landing page would go blank. The boundary is
-- not RLS, it is this definition: seven named columns and a WHERE clause that
-- nobody can widen from the outside. The table itself is never granted to anon.
create or replace view public.public_branch_locations as
  select
    b.id,
    b.name,
    b.address,
    b.latitude,
    b.longitude,
    b.image_path,
    b.display_order
  from public.branches b
  where b.is_active
    and b.show_on_landing;

comment on view public.public_branch_locations is
  'The branches an anonymous visitor may know about: active AND published. Name, address, coordinates, image path and ordering -- nothing operational.';

grant select on public.public_branch_locations to anon, authenticated;

-- ------------------------------------------------------------------- storage
--
-- A PUBLIC bucket, and the only one in this system. Every other bucket here is
-- private because its contents are somebody's -- contracts, government IDs,
-- resumes, the product catalogue -- and is read through a signed URL minted for
-- a caller who was already authorised.
--
-- A photograph of a shopfront is the opposite case. It is published on purpose,
-- to people who are not logged in and cannot be, and a signed URL would mean
-- either an anonymous signing endpoint or a link that expires while somebody is
-- reading the page. Public read is the honest posture for content whose whole
-- job is to be public.
--
-- Write is not public. The policies below admit only an Administrator, and the
-- bucket's own limits refuse anything that is not a reasonably sized image, so
-- "public bucket" never means "anyone may put things in it".
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'branch-images',
  'branch-images',
  true,
  5242880,
  array['image/png', 'image/jpeg', 'image/webp']
)
on conflict (id) do update
  set public = true,
      file_size_limit = 5242880,
      allowed_mime_types = array['image/png', 'image/jpeg', 'image/webp'];

drop policy if exists "branch images are readable by anyone" on storage.objects;
create policy "branch images are readable by anyone"
  on storage.objects for select
  using (bucket_id = 'branch-images');

drop policy if exists "administrators write branch images" on storage.objects;
create policy "administrators write branch images"
  on storage.objects for insert to authenticated
  with check (bucket_id = 'branch-images' and public.is_admin());

drop policy if exists "administrators replace branch images" on storage.objects;
create policy "administrators replace branch images"
  on storage.objects for update to authenticated
  using (bucket_id = 'branch-images' and public.is_admin())
  with check (bucket_id = 'branch-images' and public.is_admin());

drop policy if exists "administrators remove branch images" on storage.objects;
create policy "administrators remove branch images"
  on storage.objects for delete to authenticated
  using (bucket_id = 'branch-images' and public.is_admin());
