-- F7-QA-05: a request cannot be validated until it is charged to something.
--
-- Continuation acceptance opened RB-2026-0001 as Finance Staff and found
-- Category "Not classified", Budget "Not assigned", no controls to set either,
-- and "Forward for approval" available anyway. The missing controls are a UI
-- defect and are fixed there. This is the half that is not a UI defect.
--
-- Forwarding an unclassified request succeeds today, and then approval does
-- this:
--
--   if _action = 'approved' and _r.budget_id is not null then ... reserve ...
--
-- so a request with no budget is approved and reserves nothing. The ceiling
-- never sees it, budget_status.reserved does not move, and the claim sits
-- "Approved — awaiting payment" against a budget line that does not know it
-- exists. F4 fixed exactly this for purchases by giving Finance Staff the
-- controls; what it did not do was make the rule true when nobody uses them.
--
-- The rule belongs on the row rather than inside transition_finance_request.
-- Reproducing that function to add four lines means transcribing a
-- thirty-branch authority matrix to change something that is not about
-- authority at all, and every path that writes this status -- the RPC today,
-- anything else later -- passes through the trigger.
--
-- Budget is required; category is not, and that is deliberate rather than an
-- oversight. Budget is what reserves money, so a request without one is the
-- defect above. A category is classification for reporting, and every budget
-- already carries its own finance_category_id, so demanding a second one on
-- the request would be asking twice for something already known. The
-- Classification panel has always marked Budget with an asterisk and Category
-- without; this makes that asterisk true.

create or replace function public.require_budget_before_validation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  _budget_status text;
begin
  -- Only the validation step, and only when it is actually being crossed. A
  -- request already past validation is not re-checked: its budget was fixed
  -- when it was validated, and a later edit cannot clear it -- the classify
  -- policy stops at pending_validation.
  if new.status is distinct from 'pending_approval'
     or old.status is not distinct from 'pending_approval' then
    return new;
  end if;

  if new.budget_id is null then
    raise exception
      'Request % has no budget, so approving it would reserve nothing. Assign a budget before forwarding it for approval.',
      old.request_no
      using errcode = 'check_violation';
  end if;

  -- Charged to something that cannot receive it is the same defect wearing a
  -- budget id. The Classification panel only ever offers active budgets, so
  -- this is that list stated where it cannot be bypassed. Approval checks the
  -- status again, because a budget can be closed in between -- this one is
  -- about not forwarding a claim that was already doomed.
  select b.status into _budget_status from public.budgets b where b.id = new.budget_id;
  if _budget_status is distinct from 'active' then
    raise exception
      'Request % is charged to a budget that is %, so approval could not commit against it. Assign an active budget before forwarding it.',
      old.request_no, coalesce(_budget_status, 'missing')
      using errcode = 'check_violation';
  end if;

  return new;
end;
$fn$;

revoke all on function public.require_budget_before_validation() from public, anon, authenticated;

-- Deliberately NOT exempt from jmac.finance_transition. That flag exists so
-- protect_finance_request lets the workflow function move a status it forbids
-- everybody else from moving; this rule is about what the row must contain
-- when it lands there, which is as true of the workflow function as of
-- anything else.
drop trigger if exists trg_finance_requests_validation_budget on public.finance_requests;
create trigger trg_finance_requests_validation_budget
  before update on public.finance_requests
  for each row execute function public.require_budget_before_validation();

comment on function public.require_budget_before_validation() is
  'Refuses the move into pending_approval unless the request is charged to a '
  'budget, because approval reserves against that budget and a null one '
  'reserves nothing.';
