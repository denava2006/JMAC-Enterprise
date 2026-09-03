-- Branch locations on a map
--
-- Purely additive. Two nullable columns and nothing else: no policy changes, no
-- function changes, and nothing in procurement, receiving or approvals is aware
-- these exist. A branch with no coordinates is a branch that is not pinned yet,
-- which is a display state and never an operational one.
--
-- Ordinary numerics rather than PostGIS. What this answers is "where is the
-- Cavite branch, roughly" -- pinning a marker and opening a maps link. Nothing
-- here computes distance, area or containment, and installing a spatial
-- extension for two decimal numbers would be a lot of machinery to maintain in
-- exchange for nothing anybody asked for.

alter table public.branches
  add column if not exists latitude  numeric(9,6),
  add column if not exists longitude numeric(9,6);

-- Real coordinates or none. A half-set pair puts a pin in the sea off west
-- Africa, which is where every (0, 0) ends up.
alter table public.branches drop constraint if exists branches_coordinates_paired;
alter table public.branches add constraint branches_coordinates_paired check (
  (latitude is null) = (longitude is null)
);

alter table public.branches drop constraint if exists branches_coordinates_on_earth;
alter table public.branches add constraint branches_coordinates_on_earth check (
  latitude is null
  or (latitude between -90 and 90 and longitude between -180 and 180)
);

comment on column public.branches.latitude is
  'Decimal degrees, paired with longitude. Null means "not located yet" -- the branch still lists, it simply is not pinned.';
comment on column public.branches.longitude is
  'Decimal degrees, paired with latitude.';
