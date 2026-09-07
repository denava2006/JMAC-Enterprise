-- F7 QA: the last way a requester could still choose their own budget line.
--
-- F7 closed the draft-and-returned half of this: classification became writable
-- in exactly one state, pending_validation, so the person asking for the money
-- could no longer decide which budget it came out of while the claim was still
-- in their hands. What that left standing is the case where the person asking
-- for the money *is* Finance Staff.
--
-- The policy that opens classification reads:
--
--   using (status = 'pending_validation'
--          and has_finance_privilege(array['finance_staff']))
--
-- Who, and when. Not "somebody other than the claimant". So a Finance Staff
-- member raises a reimbursement of their own, submits it -- submitting is the
-- owner's act, and correctly so -- and then, with the claim sitting in the
-- validation queue, PATCHes budget_id, finance_category_id and vendor_id on it.
-- Reproduced against a local database: the UPDATE succeeded and the row came
-- back charged to the budget they picked.
--
-- Nothing else in this chain works that way. transition_finance_request gates
-- every reviewing move behind `not _is_owner`, on the stated ground that "a
-- finance officer who raises a request is a requester like anybody else: the
-- next step belongs to somebody who did not ask for the money." Deciding which
-- budget line a claim is charged to is the validation step. It is the same
-- rule, and it was missing from the one surface that is a policy rather than a
-- function.
--
-- Two places, as everywhere else here: the policy says who may attempt it, and
-- the trigger refuses it independently, so a future policy widening cannot
-- reopen the hole on its own.

-- ------------------------------------------------------------- the boundary
-- Unchanged from F7 except in one place, marked. Reproduced whole because
-- create or replace takes the whole body.
create or replace function public.protect_finance_request()
returns trigger
language plpgsql
security definer
set search_path = ''
as $fn$
begin
  if current_setting('jmac.finance_transition', true) = 'on' then
    return new;
  end if;

  if new.status is distinct from old.status then
    raise exception 'A request status is changed by submitting, validating, approving, returning, rejecting or paying it -- not by editing it.'
      using errcode = 'insufficient_privilege';
  end if;

  -- Identity, not content. The reference number is what the approval trail,
  -- the payments and every conversation about this claim refer to; the claimant
  -- is who gets paid; the type decides which sequence the reference came from,
  -- so changing it would leave an RB- number on a purchase. None of the three is
  -- ever a correction to what was asked for.
  if new.request_no is distinct from old.request_no
     or new.requester_id is distinct from old.requester_id
     or new.type is distinct from old.type then
    raise exception 'The reference, the claimant and the type of request % are fixed when it is raised.',
      old.request_no using errcode = 'insufficient_privilege';
  end if;

  -- The requester's ask. Frozen the moment it leaves their hands.
  if old.status not in ('draft', 'returned') then
    if new.amount is distinct from old.amount then
      raise exception 'Request % has already been submitted; its amount can no longer be changed.',
        old.request_no using errcode = 'insufficient_privilege';
    end if;
  end if;

  -- The classification. Writable in exactly one state -- and, NEW, by exactly
  -- one kind of person: somebody who did not raise the claim. The state rule
  -- and both of its messages are unchanged; the restructure is only so the
  -- ownership rule has somewhere to sit.
  if new.vendor_id is distinct from old.vendor_id
     or new.finance_category_id is distinct from old.finance_category_id
     or new.budget_id is distinct from old.budget_id
  then
    if old.status is distinct from 'pending_validation' then
      if old.status in ('draft', 'returned') then
        raise exception 'The budget, category and vendor of request % are set by Finance during validation, not by the person asking.',
          old.request_no using errcode = 'insufficient_privilege';
      else
        raise exception 'Request % has already been validated; its budget, category and vendor are fixed.',
          old.request_no using errcode = 'insufficient_privilege';
      end if;
    -- NEW. Holding finance_staff does not make your own claim somebody else's
    -- to check. auth.uid() is null for the service role and for the migration
    -- itself, which is distinct from any requester, so neither is caught here.
    elsif old.requester_id = (select auth.uid()) then
      raise exception 'You raised request %, so another Finance user decides which budget it is charged to.',
        old.request_no using errcode = 'insufficient_privilege';
    end if;
  end if;

  if new.paid_from_account_id is distinct from old.paid_from_account_id
     or new.payment_reference is distinct from old.payment_reference
     or new.paid_at is distinct from old.paid_at then
    raise exception 'Payment details are recorded when a request is settled, which is not part of this phase.'
      using errcode = 'insufficient_privilege';
  end if;

  return new;
end;
$fn$;

revoke all on function public.protect_finance_request() from public, anon, authenticated;

-- --------------------------------------------------------------- the policy
-- Finance Staff may write the classification while the request is theirs to
-- validate, on a request that is not their own. The trigger above refuses the
-- amount, the type, the status, the payment fields and now self-classification
-- independently, so this policy cannot reach past classification even if it is
-- read too generously.
drop policy if exists finance_requests_classify on public.finance_requests;
create policy finance_requests_classify on public.finance_requests
  for update to authenticated
  using (
    status = 'pending_validation'
    and requester_id is distinct from (select auth.uid())
    and public.has_finance_privilege(array['finance_staff'])
  )
  with check (
    status = 'pending_validation'
    and requester_id is distinct from (select auth.uid())
    and public.has_finance_privilege(array['finance_staff'])
  );
