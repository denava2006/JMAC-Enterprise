-- F3 final pass — what Finance may see, and whose name may be shown.
--
-- Two things the hosted walkthrough exposed, both of them contradictions
-- between what the app said and what the database did.

-- =========================================================================
-- B. "Nothing reaches Finance until you submit it"
-- =========================================================================
-- The New Request dialog says exactly that, and it was not true: the read
-- policy let anyone with finance privilege see every request including drafts
-- nobody had sent. A draft is a person thinking out loud. It is not Finance's
-- business until they decide it is.
--
-- "Has been submitted" is read from the approval trail rather than from the
-- current status, because status alone cannot answer it: a request cancelled
-- from draft and a request cancelled after submission both read 'cancelled',
-- and only one of them was ever Finance's to see. The trail is append-only and
-- written solely by transition_finance_request, so it is the honest source.
--
-- Historical visibility is preserved by construction: once a submitted row
-- exists it never goes away, so a returned, rejected or cancelled request that
-- was once submitted stays visible to Finance for ever.
create or replace function public.finance_request_was_submitted(_request_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $fn$
  select exists (
    select 1 from public.finance_request_approvals a
    where a.request_id = _request_id
      and a.action in ('submitted', 'resubmitted')
  );
$fn$;

revoke all on function public.finance_request_was_submitted(uuid) from public, anon;
grant execute on function public.finance_request_was_submitted(uuid) to authenticated;

drop policy if exists finance_requests_read on public.finance_requests;
create policy finance_requests_read on public.finance_requests
  for select to authenticated
  using (
    requester_id = (select auth.uid())
    or (public.can_read_finance_master() and public.finance_request_was_submitted(id))
  );

-- can_read_finance_request backs the approvals and attachments policies. It has
-- to agree with the rule above, or Finance could read the trail of a draft it
-- cannot read.
create or replace function public.can_read_finance_request(_request_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $fn$
  select exists (
    select 1 from public.finance_requests r
    where r.id = _request_id
      and (
        r.requester_id = (select auth.uid())
        or (public.can_read_finance_master() and public.finance_request_was_submitted(r.id))
      )
  );
$fn$;

revoke all on function public.can_read_finance_request(uuid) from public, anon;
grant execute on function public.can_read_finance_request(uuid) to authenticated;

-- =========================================================================
-- C. "Purchase · Unknown requester"
-- =========================================================================
-- The records were right all along -- requester_id and actor_id both pointed at
-- the correct people. What failed was reading their names: profiles is
-- selectable by yourself, by HR (is_active_staff) and by an Administrator, and
-- a finance role is none of those. So the embedded profiles(full_name) came
-- back null and the screen said Unknown about a person it knew perfectly well.
--
-- The fix is NOT to let Finance read profiles. It is to answer one narrow
-- question: what are the names of the people who appear on the requests this
-- caller is already allowed to see?
--
-- Two columns, nothing else. No email, no phone, no role, no employee id, no
-- authorization information -- adding a column here would widen what Finance
-- can learn about a person, and the whole point is that it does not.
create or replace function public.finance_request_participants()
returns table (profile_id uuid, display_name text)
language sql
stable
security definer
set search_path = ''
as $fn$
  with visible as (
    select r.id, r.requester_id
    from public.finance_requests r
    where r.requester_id = (select auth.uid())
       or (public.can_read_finance_master() and public.finance_request_was_submitted(r.id))
  ),
  participants as (
    select requester_id as id from visible
    union
    select a.actor_id
    from public.finance_request_approvals a
    join visible v on v.id = a.request_id
    where a.actor_id is not null
  )
  select pr.id, pr.full_name
  from public.profiles pr
  join participants p on p.id = pr.id;
$fn$;

revoke all on function public.finance_request_participants() from public, anon;
grant execute on function public.finance_request_participants() to authenticated;

comment on function public.finance_request_participants() is
  'profile_id and display_name for the people appearing on requests the caller '
  'may already read. Deliberately two columns: it exists so a name can be shown '
  'without granting Finance read access to profiles.';
