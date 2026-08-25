-- Fix: operator precedence silently disabled the review queue's filters.
--
-- Caught in smoke testing before Phase 8 shipped. get_pos_request_queue had:
--
--     where public.can_review_pos_request('restock')
--        or public.can_review_pos_request('carry_existing_product')
--       and (_branch_id is null or r.branch_id = _branch_id)
--       and (_status   is null or r.status    = _status)
--
-- AND binds tighter than OR, so PostgreSQL read that as
--
--     can_review('restock')
--     OR (can_review('carry') AND branch_filter AND status_filter)
--
-- and a caller who could review restocks -- which is every reviewer today --
-- matched the first disjunct alone, ignoring both filters. Asking the queue for
-- one branch returned every branch.
--
-- Not a security hole: with neither predicate true the whole expression is
-- false and no row is returned, so an unauthorized caller was always refused.
-- But "show me Cavite's queue" returned Main Office's requests too, which is
-- wrong enough on a review screen to fix before anyone sees it.
--
-- Parenthesised, and the authorization moved into its own leading conjunct so
-- the shape cannot be misread again.

create or replace function public.get_pos_request_queue(
  _branch_id uuid default null,
  _status public.pos_request_status default null,
  _limit integer default 25,
  _offset integer default 0
)
returns table (
  request_id uuid,
  branch_id uuid,
  branch_name text,
  product_id uuid,
  product_name text,
  request_type public.pos_request_type,
  requested_quantity integer,
  reason text,
  status public.pos_request_status,
  requested_by uuid,
  requester_name text,
  requester_enterprise_role public.user_role,
  requested_at timestamptz,
  reviewer_name text,
  reviewed_at timestamptz,
  review_note text,
  can_review boolean,
  total_count bigint
)
language sql
stable
security definer
set search_path = ''
as $fn$
  select
    r.id, r.branch_id, r.branch_name_snapshot, r.product_id, r.product_name_snapshot,
    r.request_type, r.requested_quantity, r.reason, r.status,
    r.requested_by, r.requester_name_snapshot, p.role, r.requested_at,
    r.reviewer_name_snapshot, r.reviewed_at, r.review_note,
    -- What this caller may actually act on, decided by the same predicate the
    -- write path uses, so the UI cannot offer a button the RPC would refuse.
    public.can_review_pos_request(r.request_type)
      and r.status = 'pending'
      and r.requested_by <> (select auth.uid()),
    count(*) over ()
  from public.pos_inventory_requests r
  left join public.profiles p on p.id = r.requested_by
  where (
      -- May this caller review anything at all? Its own parenthesised clause.
      public.can_review_pos_request('restock')
      or public.can_review_pos_request('carry_existing_product')
    )
    and (_branch_id is null or r.branch_id = _branch_id)
    and (_status is null or r.status = _status)
  order by r.requested_at desc, r.id desc
  limit public.pos_page_size(_limit)
  offset greatest(0, coalesce(_offset, 0));
$fn$;

-- CREATE OR REPLACE keeps the ACL, but this database re-grants new routines by
-- default and has been caught six times. Re-issue.
revoke all on function public.get_pos_request_queue(
  uuid, public.pos_request_status, integer, integer) from public, anon;
grant execute on function public.get_pos_request_queue(
  uuid, public.pos_request_status, integer, integer) to authenticated;
