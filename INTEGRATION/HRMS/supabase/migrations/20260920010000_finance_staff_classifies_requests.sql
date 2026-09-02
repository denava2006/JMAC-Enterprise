-- Finance Staff classify a request during validation.
--
-- A gap F3 left: budget_id, finance_category_id and vendor_id were writable
-- only by the requester, only while the request was a draft -- and a requester
-- cannot read budgets, categories or vendors at all, because those are Finance
-- master data. So through the UI every request arrived with no budget, approval
-- reserved nothing, and a ceiling could never be reached.
--
-- Classification is Finance's job anyway. "Finance Staff check the documents and
-- the budget" is the validation step; deciding which budget line a request is
-- charged to is exactly that check, not something to ask a requester who cannot
-- see the budgets to guess at.
--
-- What stays frozen is what the requester asked for. The amount and the type are
-- theirs and are already immutable once submitted; only the classification opens,
-- and only while the request is with Finance Staff.

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

  -- The requester's ask. Frozen the moment it leaves their hands.
  if old.status not in ('draft', 'returned') then
    if new.amount is distinct from old.amount
       or new.type is distinct from old.type
    then
      raise exception 'Request % has already been submitted; its amount and type can no longer be changed.',
        old.request_no using errcode = 'insufficient_privilege';
    end if;
  end if;

  -- The classification. The requester sets it if they can (they usually cannot),
  -- and Finance Staff set it during validation. After that it is fixed: what was
  -- approved was approved against a particular budget line.
  if old.status not in ('draft', 'returned', 'pending_validation') then
    if new.vendor_id is distinct from old.vendor_id
       or new.finance_category_id is distinct from old.finance_category_id
       or new.budget_id is distinct from old.budget_id
    then
      raise exception 'Request % has already been validated; its budget, category and vendor are fixed.',
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

-- Finance Staff may write the classification while the request is theirs to
-- validate, and nothing else: the trigger above independently refuses the
-- amount, the type, the status and the payment fields, so this policy widening
-- cannot reach past classification even if it is read too generously.
drop policy if exists finance_requests_classify on public.finance_requests;
create policy finance_requests_classify on public.finance_requests
  for update to authenticated
  using (
    status = 'pending_validation'
    and public.has_finance_privilege(array['finance_staff'])
  )
  with check (
    status = 'pending_validation'
    and public.has_finance_privilege(array['finance_staff'])
  );
