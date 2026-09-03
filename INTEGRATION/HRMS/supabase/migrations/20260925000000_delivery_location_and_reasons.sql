-- F4 consolidation -- where a purchase is delivered, and why anything stopped
--
-- Two unrelated-looking gaps that are really the same kind of gap: the system
-- was not recording facts that only the person acting at the time could supply.
--
--   Where does this go?  Finance was left to work out where a requester works,
--                        at purchase-order time, from nothing.
--   Why did this stop?   Cancellations, returns and rejections were all
--                        recordable with no reason at all.
--
-- Both are answerable only in the moment, and worthless reconstructed later.

-- ------------------------------------------------------- 1. a reason, meant
--
-- One helper so the rule reads the same everywhere it is applied: a business
-- transition that stops, returns or refuses something takes a reason, and
-- whitespace is not a reason.
--
-- Deliberately NOT applied to closing a dialog or abandoning an unsaved form.
-- Those transition nothing, and demanding a justification for them is how
-- people learn to type "x" into reason boxes.
create or replace function public.require_business_reason(_reason text, _what text)
returns text
language plpgsql
immutable
set search_path = ''
as $fn$
declare
  _clean text := nullif(btrim(coalesce(_reason, '')), '');
begin
  if _clean is null then
    raise exception 'Give a reason for %.', _what using errcode = 'check_violation';
  end if;
  return _clean;
end;
$fn$;

revoke all on function public.require_business_reason(text, text) from public, anon, authenticated;

-- ------------------------------------------ 2. where a purchase is delivered
--
-- A delivery location is not a POS inventory destination, and conflating them
-- is how a box of bond paper would end up incrementing the till's stock. They
-- are recorded at different levels for exactly that reason:
--
--   purchase_orders.delivery_branch_id       where the supplier delivers
--   purchase_order_items.destination_branch_id   which POS stock this becomes
--
-- A general office-materials order has the first and not the second. Only the
-- second can ever move inventory, and the receiving bridge already keys on it.
alter table public.purchase_orders
  add column if not exists delivery_branch_id uuid references public.branches(id) on delete restrict;

comment on column public.purchase_orders.delivery_branch_id is
  'Where the supplier physically delivers. NOT a POS inventory destination -- that is per line, and only a line with pos_product_id can move stock.';

-- The branch a request belongs to, captured when it is raised.
alter table public.finance_requests
  add column if not exists delivery_branch_id uuid references public.branches(id) on delete restrict;

comment on column public.finance_requests.delivery_branch_id is
  'Snapshot of where the requester was deployed when they raised this. Historical on purpose: a later transfer does not redirect an existing request.';

-- Deployment is the authoritative record of where somebody works -- it is the
-- step where a person actually decided -- and the POS onboarding code already
-- treats it that way. The same chain is used here rather than a second answer.
--
-- Snapshotted on INSERT, so it is the branch as at the moment of raising. If
-- the requester transfers next week the order still goes where the request was
-- raised, which is the whole point of a snapshot; and if the branch cannot be
-- resolved the column stays null rather than being guessed, because a guessed
-- delivery address is worse than an absent one.
create or replace function public.stamp_request_delivery_branch()
returns trigger
language plpgsql
security definer
set search_path = ''
as $fn$
begin
  if new.delivery_branch_id is not null then
    return new;
  end if;

  select d.branch_id into new.delivery_branch_id
    from public.profiles pr
    join public.employees e on e.id = pr.employee_id
    join public.deployment_records d on d.application_id = e.application_id
   where pr.id = new.requester_id
     and d.branch_id is not null
   limit 1;

  return new;
end;
$fn$;

revoke all on function public.stamp_request_delivery_branch() from public, anon, authenticated;

drop trigger if exists trg_stamp_delivery_branch on public.finance_requests;
create trigger trg_stamp_delivery_branch
  before insert on public.finance_requests
  for each row execute function public.stamp_request_delivery_branch();

-- ------------------------------------------- 3. what was ordered and dropped
--
-- Ordered 20, received 6, and Finance stops the rest. The 6 arrived and are on
-- the shelf; the 14 were never delivered and never will be. Recording that as
-- a cancellation of the whole order would claim the 6 never happened.
alter table public.purchase_order_items
  add column if not exists quantity_cancelled integer not null default 0;

alter table public.purchase_order_items drop constraint if exists purchase_order_items_cancelled_sane;
alter table public.purchase_order_items add constraint purchase_order_items_cancelled_sane check (
  quantity_cancelled >= 0 and quantity_cancelled <= quantity_ordered
);

comment on column public.purchase_order_items.quantity_cancelled is
  'Ordered quantity the company stopped waiting for. Never reduces what was received.';

-- ------------------------------------------------ 4. the reason, everywhere
--
-- Each of these already accepted a remark and ignored whether one was given.
-- The transitions that now insist are the ones that stop, return or refuse
-- something; approving and submitting are unchanged, because "why did you
-- approve this" is answered by the approval itself.

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

  if not _approve then
    _note := public.require_business_reason(_note, 'refusing this vendor');
  end if;

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

  if not _approve then
    _note := public.require_business_reason(_note, 'refusing this category');
  end if;

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

  if not _approve then
    _note := public.require_business_reason(_note, 'returning this budget');
  end if;

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

-- A branch withdrawing its own demand is a business transition too: somebody
-- downstream may already be sourcing it.
drop function if exists public.cancel_pos_request(uuid);

-- Reproduced from the original rather than patched, because the details that
-- matter here are easy to lose: the row lock and re-check so a withdrawal
-- racing a decision loses cleanly, and the deliberately uniform "not
-- available" wording, which does not tell a stranger whether a request exists.
create or replace function public.cancel_pos_request(_request_id uuid, _reason text)
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

  _reason := public.require_business_reason(_reason, 'withdrawing this request');

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

  -- The reason goes to the audit trail, which is where history is read from.
  -- review_note is deliberately left alone: it belongs to a reviewer, and the
  -- requester withdrawing their own request is not one.
  perform public.pos_request_audit(_row, 'stock_request_cancelled',
    _reason, 'pending', 'cancelled');
end;
$fn$;

revoke all on function public.cancel_pos_request(uuid, text) from public, anon;
grant execute on function public.cancel_pos_request(uuid, text) to authenticated;

comment on function public.cancel_pos_request(uuid, text) is
  'Withdraw a branch request. Takes a reason: somebody downstream may already be sourcing it.';
