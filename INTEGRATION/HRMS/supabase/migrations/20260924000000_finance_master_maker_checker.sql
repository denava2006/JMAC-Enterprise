-- FMS F4.2 -- Finance master data gets a maker and a checker
--
-- Until now a single Finance role could create a vendor and use it in an
-- authoritative document in the same minute. Segregation of duties says the
-- person who proposes a supplier is not the person who admits it to the
-- approved list, and that rule is only real if the database holds it.
--
-- Grandfathering is deliberate. The approval column defaults to 'approved', so
-- every row that already exists -- the fourteen seeded categories, the active
-- F3 Smoke Test Budget, the vendor behind PO-2026-0001 -- stays exactly as
-- valid as it was this morning. Nothing is retroactively suspended. The new
-- lifecycle applies to what is created from here.

-- --------------------------------------------------------------- the columns

alter table public.vendors
  add column if not exists approval_status text not null default 'approved',
  add column if not exists proposed_by uuid references public.profiles(id) on delete set null,
  add column if not exists reviewed_by uuid references public.profiles(id) on delete set null,
  add column if not exists reviewed_at timestamptz,
  add column if not exists review_note text;

alter table public.vendors drop constraint if exists vendors_approval_status_valid;
alter table public.vendors add constraint vendors_approval_status_valid check (
  approval_status in ('pending_approval', 'approved', 'rejected')
);

alter table public.finance_categories
  add column if not exists approval_status text not null default 'approved',
  add column if not exists proposed_by uuid references public.profiles(id) on delete set null,
  add column if not exists reviewed_by uuid references public.profiles(id) on delete set null,
  add column if not exists reviewed_at timestamptz,
  add column if not exists review_note text;

alter table public.finance_categories drop constraint if exists finance_categories_approval_status_valid;
alter table public.finance_categories add constraint finance_categories_approval_status_valid check (
  approval_status in ('pending_approval', 'approved', 'rejected')
);

-- A budget already carries approved_by/approved_at and a draft/active/closed
-- status, so it needs no new lifecycle -- only somewhere to record why a
-- Manager sent a draft back.
alter table public.budgets
  add column if not exists review_note text;

create index if not exists vendors_pending_idx
  on public.vendors (approval_status) where approval_status = 'pending_approval';
create index if not exists finance_categories_pending_idx
  on public.finance_categories (approval_status) where approval_status = 'pending_approval';

-- ------------------------------------------------------------- the maker gate
--
-- Two things are enforced here rather than in a policy, because a policy can
-- say who may write a row but not what the row is allowed to become.
--
--   1. Anything newly proposed starts as a proposal. The column default of
--      'approved' exists only to grandfather what came before; an INSERT never
--      gets to use it.
--   2. Approval fields move through the review function and nowhere else. The
--      function announces itself with a transaction-local setting, so an
--      ordinary UPDATE cannot stamp its own approval.
--
-- A material edit to an already-approved record returns it for approval. This
-- is the part that makes the control more than decoration: without it a maker
-- could get a harmless vendor approved and then change its TIN and bank
-- details unilaterally, which is the exact fraud the separation is for.
-- Housekeeping fields -- notes, description, is_active -- are not material and
-- do not reopen anything.
create or replace function public.guard_finance_master_approval()
returns trigger
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  -- _material reopens approval; _detail is everything that is not simply
  -- archiving or restoring. They differ by the harmless descriptive fields: a
  -- corrected note is the maker's to write but does not invalidate a verdict.
  _material boolean := false;
  _detail   boolean := false;
begin
  if tg_op = 'INSERT' then
    new.approval_status := 'pending_approval';
    new.proposed_by     := (select auth.uid());
    new.reviewed_by     := null;
    new.reviewed_at     := null;
    new.review_note     := null;
    return new;
  end if;

  -- The review function is speaking; it has already checked the authority and
  -- the self-approval rule.
  if coalesce(current_setting('jmac.finance_master_review', true), '') = 'on' then
    return new;
  end if;

  if new.approval_status is distinct from old.approval_status
     or new.reviewed_by is distinct from old.reviewed_by
     or new.reviewed_at is distinct from old.reviewed_at then
    raise exception 'Approval is recorded by a review, not by editing the record.'
      using errcode = 'insufficient_privilege';
  end if;

  if tg_table_name = 'vendors' then
    _material := new.name           is distinct from old.name
              or new.tin            is distinct from old.tin
              or new.email          is distinct from old.email
              or new.phone          is distinct from old.phone
              or new.address        is distinct from old.address
              or new.contact_person is distinct from old.contact_person;
    _detail   := _material or new.notes is distinct from old.notes;
  elsif tg_table_name = 'finance_categories' then
    _material := new.name is distinct from old.name
              or new.kind is distinct from old.kind;
    _detail   := _material or new.description is distinct from old.description;
  end if;

  -- The checker governs this list without authoring it. F2 gave the Manager
  -- the UPDATE policy so they could archive a vendor or a category, and that
  -- stays; what it must not become is a way to edit the details of the record
  -- they will later be asked to approve. Archiving, notes and descriptions are
  -- theirs; names, TINs and contact details are the maker's.
  if public.has_finance_privilege(array['finance_manager']) and _detail then
    raise exception 'A Finance Manager approves and archives master data; Finance Staff maintain its details.'
      using errcode = 'insufficient_privilege';
  end if;

  if _material and old.approval_status = 'approved' then
    new.approval_status := 'pending_approval';
    new.reviewed_by     := null;
    new.reviewed_at     := null;
    new.review_note     := null;
  end if;

  return new;
end;
$fn$;

revoke all on function public.guard_finance_master_approval() from public, anon, authenticated;

drop trigger if exists trg_guard_approval on public.vendors;
create trigger trg_guard_approval
  before insert or update on public.vendors
  for each row execute function public.guard_finance_master_approval();

drop trigger if exists trg_guard_approval on public.finance_categories;
create trigger trg_guard_approval
  before insert or update on public.finance_categories
  for each row execute function public.guard_finance_master_approval();

-- ------------------------------------------------------------- the checker

-- Shared by all three reviews: the caller must be a Finance Manager, and must
-- not be the person who proposed the thing. Roles alone very nearly guarantee
-- the second part, but not quite -- a Finance Staff member who proposes a
-- vendor and is later promoted would otherwise be able to approve their own
-- earlier work. The identity check is what actually holds.
create or replace function public.assert_may_review_finance_master(_proposed_by uuid, _what text)
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $fn$
declare
  _uid uuid := (select auth.uid());
begin
  if not public.has_finance_privilege(array['finance_manager']) then
    raise exception 'Only a Finance Manager may approve %.', _what
      using errcode = 'insufficient_privilege';
  end if;
  if _proposed_by is not distinct from _uid then
    raise exception 'You proposed this %, so somebody else has to approve it.', _what
      using errcode = 'insufficient_privilege';
  end if;
  return _uid;
end;
$fn$;

revoke all on function public.assert_may_review_finance_master(uuid, text) from public, anon, authenticated;

create or replace function public.review_vendor(
  _vendor_id uuid,
  _approve boolean,
  _note text default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  _uid uuid;
  _v   record;
begin
  select * into _v from public.vendors where id = _vendor_id for update;
  if _v.id is null then
    raise exception 'That vendor no longer exists.' using errcode = 'no_data_found';
  end if;
  if _v.approval_status <> 'pending_approval' then
    raise exception 'Vendor % is already %.', _v.name, replace(_v.approval_status, '_', ' ')
      using errcode = 'check_violation';
  end if;

  _uid := public.assert_may_review_finance_master(_v.proposed_by, 'a vendor');

  perform set_config('jmac.finance_master_review', 'on', true);
  update public.vendors
     set approval_status = case when _approve then 'approved' else 'rejected' end,
         reviewed_by = _uid,
         reviewed_at = now(),
         review_note = _note,
         updated_at  = now()
   where id = _vendor_id;
  perform set_config('jmac.finance_master_review', 'off', true);

  insert into public.audit_logs (actor_id, action, table_name, record_id, new_data)
  values (_uid, case when _approve then 'Vendor Approved' else 'Vendor Rejected' end,
          'vendors', _vendor_id,
          jsonb_build_object('name', _v.name, 'note', _note));
end;
$fn$;

revoke all on function public.review_vendor(uuid, boolean, text) from public, anon;
grant execute on function public.review_vendor(uuid, boolean, text) to authenticated;

create or replace function public.review_finance_category(
  _category_id uuid,
  _approve boolean,
  _note text default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  _uid uuid;
  _c   record;
begin
  select * into _c from public.finance_categories where id = _category_id for update;
  if _c.id is null then
    raise exception 'That category no longer exists.' using errcode = 'no_data_found';
  end if;
  if _c.approval_status <> 'pending_approval' then
    raise exception 'Category % is already %.', _c.name, replace(_c.approval_status, '_', ' ')
      using errcode = 'check_violation';
  end if;

  _uid := public.assert_may_review_finance_master(_c.proposed_by, 'a category');

  perform set_config('jmac.finance_master_review', 'on', true);
  update public.finance_categories
     set approval_status = case when _approve then 'approved' else 'rejected' end,
         reviewed_by = _uid,
         reviewed_at = now(),
         review_note = _note,
         updated_at  = now()
   where id = _category_id;
  perform set_config('jmac.finance_master_review', 'off', true);

  insert into public.audit_logs (actor_id, action, table_name, record_id, new_data)
  values (_uid, case when _approve then 'Category Approved' else 'Category Rejected' end,
          'finance_categories', _category_id,
          jsonb_build_object('name', _c.name, 'kind', _c.kind, 'note', _note));
end;
$fn$;

revoke all on function public.review_finance_category(uuid, boolean, text) from public, anon;
grant execute on function public.review_finance_category(uuid, boolean, text) to authenticated;

-- A budget's checker step is activation. Staff drafts the ceiling; the Manager
-- is the one who says the company will spend to it. Declining leaves the
-- budget a draft with a note rather than inventing a rejected state -- the
-- draft is meant to be revised and resubmitted, and F3 only ever reserves
-- against an active budget, so a draft reserves nothing either way.
create or replace function public.review_budget(
  _budget_id uuid,
  _approve boolean,
  _note text default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  _uid uuid;
  _b   record;
begin
  select * into _b from public.budgets where id = _budget_id for update;
  if _b.id is null then
    raise exception 'That budget no longer exists.' using errcode = 'no_data_found';
  end if;
  if _b.status <> 'draft' then
    raise exception 'Budget % is %, so there is nothing to approve.', _b.name, _b.status
      using errcode = 'check_violation';
  end if;

  _uid := public.assert_may_review_finance_master(_b.created_by, 'a budget');

  perform set_config('jmac.finance_master_review', 'on', true);
  update public.budgets
     set status      = case when _approve then 'active' else 'draft' end,
         approved_by = case when _approve then _uid else null end,
         approved_at = case when _approve then now() else null end,
         review_note = _note,
         updated_at  = now()
   where id = _budget_id;
  perform set_config('jmac.finance_master_review', 'off', true);

  insert into public.audit_logs (actor_id, action, table_name, record_id, new_data)
  values (_uid, case when _approve then 'Budget Approved' else 'Budget Returned' end,
          'budgets', _budget_id,
          jsonb_build_object('name', _b.name, 'amount', _b.amount, 'note', _note));
end;
$fn$;

revoke all on function public.review_budget(uuid, boolean, text) from public, anon;
grant execute on function public.review_budget(uuid, boolean, text) to authenticated;

-- A budget must not activate itself. Same reasoning as the master-data guard:
-- the policy says who may edit the row, this says what the row may become.
create or replace function public.guard_budget_activation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $fn$
begin
  if tg_op = 'INSERT' then
    new.status      := 'draft';
    new.approved_by := null;
    new.approved_at := null;
    return new;
  end if;

  if coalesce(current_setting('jmac.finance_master_review', true), '') = 'on' then
    return new;
  end if;

  -- Closing a budget stays an ordinary edit for the Manager; it takes nothing
  -- into effect. Activation is the decision that needs a second person.
  if new.status is distinct from old.status and new.status = 'active' then
    raise exception 'A budget becomes active through approval, not by editing it.'
      using errcode = 'insufficient_privilege';
  end if;
  if new.approved_by is distinct from old.approved_by
     or new.approved_at is distinct from old.approved_at then
    raise exception 'Budget approval is recorded by a review, not by editing the record.'
      using errcode = 'insufficient_privilege';
  end if;

  return new;
end;
$fn$;

revoke all on function public.guard_budget_activation() from public, anon, authenticated;

drop trigger if exists trg_guard_budget_activation on public.budgets;
create trigger trg_guard_budget_activation
  before insert or update on public.budgets
  for each row execute function public.guard_budget_activation();

-- ----------------------------------------------------- who writes what, now
--
-- The maker writes; the checker reviews. A Finance Manager who can still edit
-- the vendor list is a Finance Manager approving their own edits by another
-- name, so the write side becomes Finance Staff only. The Manager's authority
-- over these tables is exercised through the review functions above, which are
-- SECURITY DEFINER and therefore unaffected by these policies.

-- Authorship becomes Staff's alone. Archiving stays the Manager's, exactly as
-- F2 decided -- withdrawing a category changes how every past classification
-- reads, which is governance rather than authorship and belongs to the
-- checker. So the UPDATE policy is left as F2 wrote it, and the trigger above
-- is what keeps a Manager from using that same policy to rewrite a TIN.
drop policy if exists finance_categories_curate on public.finance_categories;
create policy finance_categories_curate on public.finance_categories
  for insert to authenticated
  with check (public.has_finance_privilege(array['finance_staff']));

drop policy if exists vendors_curate on public.vendors;
create policy vendors_curate on public.vendors
  for insert to authenticated
  with check (public.has_finance_privilege(array['finance_staff']));

-- What a vendor supplies is part of describing the vendor, so it follows the
-- vendor's own rule rather than staying open to the checker. Kept as two
-- policies, as F2 wrote them: a link row exists or it does not.
drop policy if exists vendor_categories_link on public.vendor_categories;
create policy vendor_categories_link on public.vendor_categories
  for insert to authenticated
  with check (public.has_finance_privilege(array['finance_staff']));

drop policy if exists vendor_categories_unlink on public.vendor_categories;
create policy vendor_categories_unlink on public.vendor_categories
  for delete to authenticated
  using (public.has_finance_privilege(array['finance_staff']));

-- Budgets change hands the other way. They were Manager-only, which made the
-- Manager both author and approver of the company's spending ceilings. Staff
-- drafts them now; the Manager approves.
drop policy if exists budgets_write on public.budgets;
create policy budgets_write on public.budgets
  for insert to authenticated
  with check (public.has_finance_privilege(array['finance_staff']));

drop policy if exists budgets_edit on public.budgets;
create policy budgets_edit on public.budgets
  for update to authenticated
  using (public.has_finance_privilege(array['finance_staff', 'finance_manager']))
  with check (public.has_finance_privilege(array['finance_staff', 'finance_manager']));

-- ------------------------------------------------------ the vendor's phone
--
-- A Philippine mobile number, exactly: 09 followed by nine digits. The leading
-- zero is part of the number, which is why this is text with a pattern and not
-- anything numeric -- a numeric type would helpfully drop it.
alter table public.vendors drop constraint if exists vendors_phone_format;
alter table public.vendors add constraint vendors_phone_format check (
  phone is null or phone ~ '^09[0-9]{9}$'
);

comment on column public.vendors.approval_status is
  'Maker/checker state. Defaults to approved so pre-F4.2 rows stay valid; the insert trigger forces new rows to pending_approval.';
comment on function public.review_vendor(uuid, boolean, text) is
  'Finance Manager admits or refuses a proposed vendor. Refuses self-approval.';
comment on function public.review_budget(uuid, boolean, text) is
  'Finance Manager activates a drafted budget. Refuses self-approval. Declining returns it to draft with a note.';
