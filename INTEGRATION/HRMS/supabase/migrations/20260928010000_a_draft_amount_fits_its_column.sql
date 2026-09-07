-- F7 QA: an amount too large to store, refused as a sentence.
--
-- finance_requests.amount is numeric(14,2). An amount of 1000000000000 passes
-- the form -- the shared schema asked only that it be positive -- and passes
-- every check in update_finance_request_draft, and then the UPDATE fails with
--
--   numeric field overflow
--   DETAIL: A field with precision 14, scale 2 must round to an absolute value
--           less than 10^12.
--
-- which is a sentence about a column, addressed to nobody. Worse, it reached
-- the screen: describeRequestEditError passed any message that was not a
-- row-level-security refusal straight through, so a claimant saw the schema.
--
-- Both halves are fixed. The client now refuses it before saving and no longer
-- forwards messages Postgres wrote about itself; this states the same bound
-- where it cannot be skipped, so a caller that never loads the form is told the
-- same thing in the same words.
--
-- Unchanged from F7 except for the one check, marked. Reproduced whole because
-- create or replace takes the whole body.
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
  -- NEW. The ceiling numeric(14,2) already imposes, said in words and said
  -- before the UPDATE, so it arrives as advice rather than as an overflow.
  if _amount > 999999999999.99 then
    raise exception 'Keep the amount under 1,000,000,000,000.' using errcode = 'check_violation';
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
