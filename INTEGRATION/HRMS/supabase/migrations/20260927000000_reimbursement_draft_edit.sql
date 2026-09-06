-- F7 acceptance fix: correcting a request before it is submitted.
--
-- Acceptance opened a Draft reimbursement and found Submit, Cancel request and
-- Close. Nothing else. A typo in the amount therefore had to be cancelled and
-- retyped, which turns one controlled test record into two records and a
-- cancelled one -- and in production it would do the same to real claims.
--
-- Editing a draft is the fix, and the entire risk is in what "editable" comes
-- to mean. F3 already left the door wider than it reads: the amend policy is
--
--   using  (requester_id = auth.uid() and status in ('draft', 'returned'))
--   with check (same)
--
-- which scopes WHO and WHEN but says nothing about WHICH COLUMNS. The trigger
-- covers status and the payment fields, and it freezes the amount and type once
-- a request is submitted -- but while a request is still a draft, budget_id,
-- finance_category_id and vendor_id are writable by the person asking for the
-- money. F4 noticed the requester "usually cannot" set them because they cannot
-- read the master data to find an id. Usually is not a control.
--
-- So this migration does two things, and the second is the one that matters:
--
--   1. one door for the edit itself -- authorization, status, validation and
--      staleness all decided in the database, so the button in the browser is
--      a convenience rather than the rule
--   2. the boundary tightened, so classification is writable only during
--      validation, by every path, including a direct PATCH that never goes
--      near the function

-- ------------------------------------------------------- the boundary first
-- Unchanged from F4 except in two places, both marked. Reproduced whole because
-- create or replace takes the whole body, and a rule this small is easier to
-- read as one function than as a diff.
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

  -- NEW. Identity, not content. The reference number is what the approval trail,
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

  -- CHANGED. Was: writable in draft, returned and pending_validation. The first
  -- two were the hole -- they let the person asking for the money choose the
  -- budget it comes out of. Classification is decided during validation, by
  -- Finance Staff, who are the only people who can see the budgets at all. So
  -- it is writable in exactly one state and read-only in every other.
  if old.status is distinct from 'pending_validation' then
    if new.vendor_id is distinct from old.vendor_id
       or new.finance_category_id is distinct from old.finance_category_id
       or new.budget_id is distinct from old.budget_id
    then
      if old.status in ('draft', 'returned') then
        raise exception 'The budget, category and vendor of request % are set by Finance during validation, not by the person asking.',
          old.request_no using errcode = 'insufficient_privilege';
      else
        raise exception 'Request % has already been validated; its budget, category and vendor are fixed.',
          old.request_no using errcode = 'insufficient_privilege';
      end if;
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

-- ------------------------------------------------------------- the one door
-- Draft only, deliberately.
--
-- A returned request is also the requester's to amend -- that is what "returned
-- for correction" means, and the amend policy has allowed it since F3. This
-- function does not widen to cover it. A correction before anybody has looked at
-- the claim and a correction in answer to a reviewer's remarks are different
-- acts, and giving them one entry point is how "editable" stops meaning
-- anything. The narrow one is the one acceptance asked for.
--
-- The parameters are the fields the form owns. There is no budget parameter,
-- no status parameter and no payment parameter -- not as an ignored argument,
-- but absent, so that no future caller can pass one hopefully.
create or replace function public.update_finance_request_draft(
  _request_id           uuid,
  _title                text,
  _amount               numeric,
  _priority             text,
  _description          text        default null,
  _justification        text        default null,
  _expense_date         date        default null,
  _needed_by            date        default null,
  _expected_updated_at  timestamptz default null
)
returns public.finance_requests
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  _r   public.finance_requests;
  _uid uuid := (select auth.uid());
  _t   text := nullif(btrim(coalesce(_title, '')), '');
begin
  if _uid is null then
    raise exception 'You must be signed in to edit a request.'
      using errcode = 'insufficient_privilege';
  end if;

  -- Locked before anything is read, so two saves racing each other resolve in
  -- order rather than both reading the same "before" and both writing.
  select * into _r from public.finance_requests where id = _request_id for update;
  if not found then
    raise exception 'That request no longer exists.' using errcode = 'no_data_found';
  end if;

  if _r.requester_id is distinct from _uid then
    raise exception 'Only the person who raised a request can edit it.'
      using errcode = 'insufficient_privilege';
  end if;

  if _r.status is distinct from 'draft' then
    raise exception 'Request % has already been submitted, so it can no longer be edited. Ask Finance to return it if it needs correcting.',
      _r.request_no using errcode = 'insufficient_privilege';
  end if;

  -- Optimistic concurrency. The browser sends back the version it rendered; if
  -- the row has moved on since -- a second tab, a double-clicked Save -- the
  -- later edit is refused rather than quietly overwriting the earlier one. Null
  -- means the caller is not tracking a version, which is the API's business and
  -- not something to force.
  if _expected_updated_at is not null and _r.updated_at is distinct from _expected_updated_at then
    raise exception 'This request was changed somewhere else while you were editing it. Close it and open it again to see the current version.'
      using errcode = 'check_violation';
  end if;

  -- The same rules the form applies, applied where they cannot be skipped.
  if _t is null then
    raise exception 'Say what this is for.' using errcode = 'check_violation';
  end if;
  if length(_t) > 150 then
    raise exception 'Keep what this is for under 150 characters.' using errcode = 'check_violation';
  end if;
  if _amount is null or _amount <= 0 then
    raise exception 'An amount must be more than zero.' using errcode = 'check_violation';
  end if;
  if _priority is null or _priority not in ('low', 'medium', 'high') then
    raise exception 'Choose a priority of low, medium or high.' using errcode = 'check_violation';
  end if;
  if length(coalesce(_description, '')) > 1000 then
    raise exception 'Keep the details under 1000 characters.' using errcode = 'check_violation';
  end if;
  if length(coalesce(_justification, '')) > 1000 then
    raise exception 'Keep the reason under 1000 characters.' using errcode = 'check_violation';
  end if;
  -- Already a table constraint. Raised here too so it arrives as a sentence
  -- rather than as a constraint name.
  if _expense_date is not null and _r.type is distinct from 'reimbursement' then
    raise exception 'Only a reimbursement has a date the money was already spent.'
      using errcode = 'check_violation';
  end if;

  update public.finance_requests
     set title         = _t,
         description   = nullif(btrim(coalesce(_description, '')), ''),
         justification = nullif(btrim(coalesce(_justification, '')), ''),
         amount        = _amount,
         priority      = _priority,
         expense_date  = case when _r.type = 'reimbursement' then _expense_date else null end,
         needed_by     = _needed_by
   where id = _request_id
   returning * into _r;

  return _r;
end;
$fn$;

revoke all on function public.update_finance_request_draft(
  uuid, text, numeric, text, text, text, date, date, timestamptz) from public, anon;
grant execute on function public.update_finance_request_draft(
  uuid, text, numeric, text, text, text, date, date, timestamptz) to authenticated;

comment on function public.update_finance_request_draft(
  uuid, text, numeric, text, text, text, date, date, timestamptz) is
  'Correct one''s own request while it is still a draft. Authorization, status, '
  'validation and staleness are decided here; the caller cannot reach budget, '
  'classification, status or payment through it.';
