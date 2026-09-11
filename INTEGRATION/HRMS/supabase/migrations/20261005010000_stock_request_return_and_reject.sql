-- Stock request: Return for changes, and Reject after approval.
--
-- THE GAP. Finance Staff could accept a stock request or decline it, and only
-- while it was still `pending`. Once accepted it became procurement demand and
-- there was no way back: if the purchase order raised against it was declined
-- by the Finance Manager -- PO-2026-0006, bought at 35.00 against a 30.00
-- selling price -- the demand sat approved forever with nothing to be done
-- about it. Finance Staff could raise another order, and nothing else.
--
-- TWO OBJECTS, TWO DECISIONS, and the whole point of this change. A purchase
-- order is Finance's commitment to buy; a stock request is the branch's demand.
-- Declining the order says "not at that price, from that supplier". It does not
-- say "the branch does not need this". Those are different sentences and only
-- the branch's own workflow may say the second one, which is why declining a PO
-- does not touch the request -- it simply stops claiming its quantity, through
-- the outstanding calculation that already existed.
--
-- WHAT IS NOT NEW: reject. `declined` already meant "Finance will not procure
-- this", already required a note, and already had an audit event. It gains one
-- thing here -- it may now be reached from `approved`, not only from `pending`
-- -- because that is exactly the state the PO-2026-0006 demand is stuck in.
-- Adding a second terminal status beside it would have been a second workflow.

-- ----------------------------------------------------- the states, restated
--
-- `returned` is a reviewed state: Finance Staff looked at it and sent it back,
-- so it carries a reviewer and a timestamp like the other reviewed states. And
-- it carries a reason, for the same reason `declined` does -- a request handed
-- back with no explanation is a request the branch has to guess about.
alter table public.pos_inventory_requests
  drop constraint if exists pos_request_reviewed_states_have_a_reviewer;

alter table public.pos_inventory_requests
  add constraint pos_request_reviewed_states_have_a_reviewer check (
    (status in ('pending', 'cancelled') and reviewed_by is null and reviewed_at is null)
    or (status in ('approved', 'declined', 'returned')
        and reviewed_by is not null and reviewed_at is not null)
  );

alter table public.pos_inventory_requests
  drop constraint if exists pos_request_decline_needs_a_note;

alter table public.pos_inventory_requests
  add constraint pos_request_refusal_needs_a_note check (
    status not in ('declined', 'returned')
    or nullif(btrim(coalesce(review_note, '')), '') is not null
  );

-- --------------------------------------------------------------- live orders
--
-- What stops Finance Staff resolving a request: an order that still represents
-- procurement against it. Taken from the deployed status model rather than
-- guessed --
--
--   draft             claims quantity through pos_request_ordered_quantity
--   pending_approval  waiting on the Finance Manager
--   approved          committed, awaiting or taking delivery
--   returned          the Manager sent it back to Staff; still being worked
--
--   cancelled / rejected  terminal, and already release the demand
--   closed                finished; what arrived, arrived
--
-- The failure this prevents is a request marked rejected while an order against
-- it goes on to be approved and received.
create or replace function public.pos_request_live_purchase_orders(_request_id uuid)
returns integer
language sql
stable
security definer
set search_path = ''
as $fn$
  select count(*)::integer
    from public.purchase_order_sources s
    join public.purchase_orders po on po.id = s.purchase_order_id
   where s.pos_inventory_request_id = _request_id
     and po.status in ('draft', 'pending_approval', 'approved', 'returned');
$fn$;

comment on function public.pos_request_live_purchase_orders(uuid) is
  'How many purchase orders still represent live procurement against a stock request. Zero means Finance Staff may return or reject it without contradicting an order.';

revoke all on function public.pos_request_live_purchase_orders(uuid) from public, anon;
grant execute on function public.pos_request_live_purchase_orders(uuid) to authenticated, service_role;

-- ------------------------------------------------------- return for changes
--
-- Not a rejection. The demand may well be legitimate; something about it has to
-- be looked at by the person who raised it before Finance goes further. The
-- request keeps its identity -- same row, same id, same branch, same product --
-- so the history reads as one conversation rather than as a pile of duplicate
-- requests, which is what raising a fresh one each time would produce.
create or replace function public.return_pos_request(_request_id uuid, _reason text)
returns void
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  _row      public.pos_inventory_requests;
  _actor    uuid := (select auth.uid());
  _reviewer text;
  _live     integer;
  _from     text;
begin
  if _actor is null then
    raise exception 'Sign in to review a request';
  end if;
  if nullif(btrim(coalesce(_reason, '')), '') is null then
    raise exception 'A reason is required when returning a request for changes';
  end if;

  -- FOR UPDATE, and the live-order count read inside the same lock. This is the
  -- race: Staff A opening a return while Staff B raises an order against the
  -- same request. Whoever takes the row first is answered first, and the second
  -- sees the other's work.
  select * into _row from public.pos_inventory_requests
   where id = _request_id for update;
  if not found then
    raise exception 'That request is not available';
  end if;

  if not public.can_review_pos_request(_row.request_type) then
    raise exception 'You may not review that request';
  end if;

  -- From pending (never accepted) or from approved (accepted, and procurement
  -- has since come to nothing). Not from a terminal state: a declined or
  -- cancelled request is finished, and returning it would reopen a decision
  -- somebody already took.
  if _row.status not in ('pending', 'approved') then
    raise exception 'A % request cannot be returned for changes.', _row.status;
  end if;

  if _row.requested_by = _actor then
    raise exception 'You cannot review a request you submitted yourself';
  end if;

  _live := public.pos_request_live_purchase_orders(_request_id);
  if _live > 0 then
    raise exception
      'This request has an active purchase order. Resolve that order before returning or rejecting the request.'
      using errcode = 'check_violation';
  end if;

  select coalesce(nullif(btrim(pr.full_name), ''), 'Unknown') into _reviewer
    from public.profiles pr where pr.id = _actor;

  _from := _row.status::text;

  update public.pos_inventory_requests
     set status = 'returned',
         reviewed_by = _actor,
         reviewed_at = now(),
         review_note = btrim(_reason),
         reviewer_name_snapshot = _reviewer
   where id = _request_id
  returning * into _row;

  perform public.pos_request_audit(_row, 'stock_request_returned',
    'Request returned for changes', _from, 'returned');
end;
$fn$;

comment on function public.return_pos_request(uuid, text) is
  'Finance Staff sends a stock request back to the branch to correct, from pending or approved. Requires a reason, refuses while any live purchase order claims the request, and keeps the request''s identity so it can be resubmitted rather than duplicated.';

revoke all on function public.return_pos_request(uuid, text) from public, anon;
grant execute on function public.return_pos_request(uuid, text) to authenticated;

-- -------------------------------------------------------------- resubmission
--
-- The branch's half. Same row, so "submitted, returned, resubmitted" is one
-- history and not three requests.
--
-- Identity is immutable by construction rather than by validation: branch,
-- product and request type are not parameters here, so there is no payload that
-- could change what the demand IS. A branch that needs a different product
-- raises a different request, which is the honest way to say so.
--
-- Quantity may be corrected, which is usually the point of the return. It may
-- not drop below what has already been ordered against the request -- orders
-- that were placed are facts, and a request cannot retroactively un-ask for
-- stock that is on its way or already arrived.
create or replace function public.resubmit_pos_request(
  _request_id uuid,
  _quantity integer default null,
  _reason text default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  _row     public.pos_inventory_requests;
  _actor   uuid := (select auth.uid());
  _ordered integer;
  _qty     integer;
begin
  if _actor is null then
    raise exception 'Sign in to resubmit a request';
  end if;

  select * into _row from public.pos_inventory_requests
   where id = _request_id for update;
  if not found then
    raise exception 'That request is not available';
  end if;

  if _row.status <> 'returned' then
    raise exception 'Only a request that was returned for changes can be resubmitted.';
  end if;

  -- The branch's own manager, at the branch the request belongs to. Not the
  -- cashier who cannot raise one in the first place, and not another branch's
  -- manager.
  if not public.has_pos_role(_row.branch_id, array['manager']::public.pos_role[]) then
    raise exception 'Only the branch''s POS Manager may resubmit its stock request.'
      using errcode = 'insufficient_privilege';
  end if;

  _qty := coalesce(_quantity, _row.requested_quantity);

  if _row.request_type = 'restock' then
    if _qty is null or _qty < 1 or _qty > 100000 then
      raise exception 'Enter a quantity between 1 and 100000.' using errcode = 'check_violation';
    end if;

    _ordered := public.pos_request_ordered_quantity(_request_id);
    if _qty < _ordered then
      raise exception
        'This request already has % unit(s) ordered against it, so it cannot be reduced to %.',
        _ordered, _qty
        using errcode = 'check_violation';
    end if;
  elsif _quantity is not null then
    raise exception 'Only a restock request carries a quantity.' using errcode = 'check_violation';
  end if;

  update public.pos_inventory_requests
     set requested_quantity = case when _row.request_type = 'restock' then _qty else requested_quantity end,
         reason = coalesce(nullif(btrim(coalesce(_reason, '')), ''), reason),
         status = 'pending',
         -- Back to unreviewed: the reviewed-state constraint requires it, and
         -- it is true -- nobody has looked at the corrected request yet. The
         -- reason Finance gave is not lost, it is in the audit trail, which is
         -- where a history belongs rather than in a column the next decision
         -- overwrites.
         reviewed_by = null,
         reviewed_at = null,
         review_note = null,
         reviewer_name_snapshot = null
   where id = _request_id
  returning * into _row;

  perform public.pos_request_audit(_row, 'stock_request_resubmitted',
    'Request corrected and resubmitted', 'returned', 'pending');
end;
$fn$;

comment on function public.resubmit_pos_request(uuid, integer, text) is
  'The branch''s POS Manager corrects a returned stock request and sends it back to Finance. Same request id -- branch, product and type are not parameters, so the demand cannot become a different one. Quantity may not fall below what is already ordered.';

revoke all on function public.resubmit_pos_request(uuid, integer, text) from public, anon;
grant execute on function public.resubmit_pos_request(uuid, integer, text) to authenticated;

-- -------------------------------------------------- reject, after approval too
--
-- The same function, two changes: it may be reached from `approved`, and it
-- refuses while an order is live. Everything else -- the mandatory note, the
-- audit event, the self-review rule -- is untouched, because it was already
-- right.
create or replace function public.decline_pos_request(_request_id uuid, _note text)
returns void
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  _row      public.pos_inventory_requests;
  _actor    uuid := (select auth.uid());
  _reviewer text;
  _live     integer;
  _from     text;
begin
  if _actor is null then
    raise exception 'Sign in to review a request';
  end if;
  if nullif(btrim(coalesce(_note, '')), '') is null then
    raise exception 'A reason is required when declining a request';
  end if;

  select * into _row from public.pos_inventory_requests
   where id = _request_id for update;
  if not found then
    raise exception 'That request is not available';
  end if;
  if not public.can_review_pos_request(_row.request_type) then
    raise exception 'You may not review that request';
  end if;

  -- Widened from pending alone. A request accepted months ago whose every
  -- purchase order came to nothing is exactly the one Finance needs to be able
  -- to close, and before this there was no way to say so.
  if _row.status not in ('pending', 'approved', 'returned') then
    raise exception 'That request has already been reviewed';
  end if;
  if _row.requested_by = _actor then
    raise exception 'You cannot review a request you submitted yourself';
  end if;

  _live := public.pos_request_live_purchase_orders(_request_id);
  if _live > 0 then
    raise exception
      'This request has an active purchase order. Resolve that order before returning or rejecting the request.'
      using errcode = 'check_violation';
  end if;

  select coalesce(nullif(btrim(pr.full_name), ''), 'Unknown') into _reviewer
    from public.profiles pr where pr.id = _actor;

  _from := _row.status::text;

  update public.pos_inventory_requests
     set status = 'declined',
         reviewed_by = _actor,
         reviewed_at = now(),
         review_note = btrim(_note),
         reviewer_name_snapshot = _reviewer
   where id = _request_id
  returning * into _row;

  perform public.pos_request_audit(_row, 'stock_request_declined',
    'Request declined', _from, 'declined');
end;
$fn$;

revoke all on function public.decline_pos_request(uuid, text) from public, anon;
grant execute on function public.decline_pos_request(uuid, text) to authenticated;
