-- F5 -- recording a supplier invoice, and deciding it
--
-- Two doors: one to create the document from a purchase order, one to move it
-- through its life. Everything else about a supplier invoice is ordinary table
-- access under the policies in the previous migration.
--
-- The rule this file exists to hold: an invoice cannot be approved while it
-- disagrees with the order or the receipts. There is no override. If the
-- supplier billed for twenty-five when six arrived, the answer is to send it
-- back, not to wave it through with a note -- an approval that can be
-- overridden is not a control, and F5 was told not to invent a tolerance
-- nobody has agreed.

-- --------------------------------------------- creating it from the order
--
-- The order supplies the vendor and the lines. The Accountant supplies what
-- only the supplier's document can say: its number, its dates, tax and any
-- charges. Nothing is retyped that the system already knows, for the same
-- reason the purchase order builder stopped asking Finance to retype a branch
-- and a product.
create or replace function public.create_supplier_invoice(
  _purchase_order_id uuid,
  _supplier_invoice_number text,
  _invoice_date date,
  _due_date date default null,
  _lines jsonb default null,
  _tax_amount numeric default 0,
  _other_charges numeric default 0,
  _other_charges_note text default null,
  _notes text default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  _uid     uuid := (select auth.uid());
  _po      record;
  _invoice uuid;
  _line    jsonb;
  _item    record;
  _count   integer := 0;
begin
  if not public.has_finance_privilege(array['accountant']) then
    raise exception 'Recording a supplier invoice is the Accountant''s work.'
      using errcode = 'insufficient_privilege';
  end if;

  select * into _po from public.purchase_orders where id = _purchase_order_id;
  if _po.id is null then
    raise exception 'That purchase order no longer exists.' using errcode = 'no_data_found';
  end if;

  -- Approved or closed, both. Closing a purchase order means the goods
  -- question is settled -- it says nothing about whether the supplier has been
  -- paid, and refusing to invoice a closed order would make the completed ones
  -- unbillable.
  if _po.status not in ('approved', 'closed') then
    raise exception 'Purchase order % is %, so there is nothing to be invoiced for yet.',
      _po.po_number, _po.status using errcode = 'check_violation';
  end if;

  if nullif(btrim(coalesce(_supplier_invoice_number, '')), '') is null then
    raise exception 'Enter the invoice number printed on the supplier''s document.'
      using errcode = 'check_violation';
  end if;
  if _invoice_date is null then
    raise exception 'Enter the date on the supplier''s invoice.' using errcode = 'check_violation';
  end if;
  if _lines is null or jsonb_array_length(_lines) = 0 then
    raise exception 'An invoice with no lines charges for nothing.' using errcode = 'check_violation';
  end if;

  insert into public.supplier_invoices
    (supplier_invoice_number, vendor_id, purchase_order_id, invoice_date, due_date,
     currency, tax_amount, other_charges, other_charges_note, notes, created_by)
  values
    (btrim(_supplier_invoice_number), _po.vendor_id, _purchase_order_id, _invoice_date, _due_date,
     _po.currency, coalesce(_tax_amount, 0), coalesce(_other_charges, 0),
     nullif(btrim(coalesce(_other_charges_note, '')), ''),
     nullif(btrim(coalesce(_notes, '')), ''), _uid)
  returning id into _invoice;

  for _line in select * from jsonb_array_elements(_lines) loop
    select * into _item
      from public.purchase_order_items
     where id = (_line->>'purchase_order_item_id')::uuid
       and purchase_order_id = _purchase_order_id;

    if _item.id is null then
      raise exception 'One of those lines is not part of purchase order %.', _po.po_number
        using errcode = 'check_violation';
    end if;

    insert into public.supplier_invoice_lines
      (supplier_invoice_id, purchase_order_item_id, description, quantity, unit_cost)
    values
      (_invoice, _item.id, _item.description,
       coalesce((_line->>'quantity')::integer, 0),
       coalesce((_line->>'unit_cost')::numeric, _item.unit_cost));
    _count := _count + 1;
  end loop;

  insert into public.supplier_invoice_history
    (supplier_invoice_id, actor_id, role_at_action, action, to_status, remarks)
  values (_invoice, _uid, 'accountant', 'created', 'draft',
          _count || ' line(s) against ' || _po.po_number);

  return _invoice;
end;
$fn$;

revoke all on function public.create_supplier_invoice(
  uuid, text, date, date, jsonb, numeric, numeric, text, text) from public, anon;
grant execute on function public.create_supplier_invoice(
  uuid, text, date, date, jsonb, numeric, numeric, text, text) to authenticated;

-- ------------------------------------------------------------ deciding it
create or replace function public.transition_supplier_invoice(
  _supplier_invoice_id uuid,
  _to_status text,
  _remarks text default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  _uid      uuid := (select auth.uid());
  _inv      record;
  _role     text;
  _allowed  boolean := false;
  _action   text;
  _lines    integer;
  _bad      record;
begin
  select * into _inv from public.supplier_invoices where id = _supplier_invoice_id for update;
  if _inv.id is null then
    raise exception 'That supplier invoice no longer exists.' using errcode = 'no_data_found';
  end if;

  select role::text into _role from public.profiles where id = _uid and status = 'active';
  if _role is null or not public.has_finance_privilege(array[_role]) then
    raise exception 'Only Finance can move a supplier invoice.' using errcode = 'insufficient_privilege';
  end if;

  -- The maker submits and resubmits; the checker decides. Voiding is the
  -- Manager's too: withdrawing a recorded liability is not a correction.
  if _role = 'accountant' and _inv.status in ('draft', 'returned') and _to_status = 'for_review' then
    _allowed := true; _action := case _inv.status when 'returned' then 'resubmitted' else 'submitted' end;
  elsif _role = 'finance_manager' and _inv.status = 'for_review'
        and _to_status in ('approved', 'returned', 'rejected') then
    _allowed := true; _action := _to_status;
  elsif _role = 'finance_manager' and _inv.status in ('draft', 'returned', 'approved')
        and _to_status = 'voided' then
    _allowed := true; _action := 'voided';
  end if;

  if not _allowed then
    raise exception 'A % cannot move supplier invoice % from % to %.',
      _role, _inv.invoice_no, _inv.status, _to_status
      using errcode = 'insufficient_privilege';
  end if;

  -- Nobody approves the invoice they recorded. The role matrix nearly
  -- guarantees it -- an Accountant cannot approve at all -- but not across a
  -- change of role, which is the case the identity check is for.
  if _to_status = 'approved' and _inv.created_by is not distinct from _uid then
    raise exception 'You recorded supplier invoice %, so somebody else has to approve it.',
      _inv.invoice_no using errcode = 'insufficient_privilege';
  end if;

  -- Stopping, returning or refusing takes a reason, as everywhere else.
  if _to_status in ('returned', 'rejected', 'voided') then
    _remarks := public.require_business_reason(_remarks,
      case _to_status
        when 'returned' then 'returning this invoice for correction'
        when 'rejected' then 'rejecting this invoice'
        else 'voiding this invoice'
      end);
  end if;

  if _to_status = 'for_review' then
    select count(*) into _lines
      from public.supplier_invoice_lines where supplier_invoice_id = _inv.id;
    if _lines = 0 then
      raise exception 'An invoice with no lines charges for nothing.'
        using errcode = 'check_violation';
    end if;
  end if;

  -- The three-way match, at the moment it matters. Checked on approval rather
  -- than on submission: an Accountant should be able to record a supplier's
  -- bill exactly as it arrived, discrepancies included, and put it in front of
  -- somebody. What must not happen is the company agreeing to owe it.
  if _to_status = 'approved' then
    select * into _bad
      from public.supplier_invoice_match(_supplier_invoice_id)
     where verdict <> 'matched'
     limit 1;

    if _bad.line_id is not null then
      if _bad.verdict = 'quantity_mismatch' then
        raise exception
          'This invoice bills % of "%" but only % can still be charged for -- % received, % already invoiced. Return it for correction.',
          _bad.invoice_quantity, _bad.description, _bad.billable_quantity,
          _bad.received_quantity, _bad.previously_invoiced
          using errcode = 'check_violation';
      else
        raise exception
          'This invoice charges % for "%" where the purchase order agreed %. Return it for correction.',
          to_char(_bad.invoice_unit_cost, 'FM999,999,990.00'), _bad.description,
          to_char(_bad.po_unit_cost, 'FM999,999,990.00')
          using errcode = 'check_violation';
      end if;
    end if;
  end if;

  update public.supplier_invoices
     set status = _to_status,
         submitted_at = case when _to_status = 'for_review' then now() else submitted_at end,
         approved_by  = case when _to_status = 'approved' then _uid else approved_by end,
         approved_at  = case when _to_status = 'approved' then now() else approved_at end,
         decision_reason = case when _to_status in ('returned', 'rejected', 'voided')
                                then _remarks else decision_reason end,
         updated_at = now()
   where id = _supplier_invoice_id;

  insert into public.supplier_invoice_history
    (supplier_invoice_id, actor_id, role_at_action, action, from_status, to_status, remarks)
  values (_supplier_invoice_id, _uid, _role, _action, _inv.status, _to_status, _remarks);

  insert into public.audit_logs (actor_id, action, table_name, record_id, new_data)
  values (_uid, 'Supplier Invoice ' || initcap(_action), 'supplier_invoices', _supplier_invoice_id,
          jsonb_build_object('invoice_no', _inv.invoice_no,
                             'supplier_invoice_number', _inv.supplier_invoice_number,
                             'from', _inv.status, 'to', _to_status, 'remarks', _remarks));
end;
$fn$;

revoke all on function public.transition_supplier_invoice(uuid, text, text) from public, anon;
grant execute on function public.transition_supplier_invoice(uuid, text, text) to authenticated;

comment on function public.transition_supplier_invoice(uuid, text, text) is
  'Moves a supplier invoice. The Accountant submits, the Finance Manager decides, and never the same person. Approval is refused while the invoice disagrees with the order or the receipts -- there is no override.';

-- ------------------------------------------- purchase orders worth invoicing
--
-- What the Accountant's queue needs: completed procurement that nobody has
-- billed in full yet. Derived from the documents rather than a flag somebody
-- has to remember to set.
create or replace function public.get_invoiceable_purchase_orders()
returns table (
  purchase_order_id uuid,
  po_number         text,
  vendor_id         uuid,
  vendor_name       text,
  status            text,
  received_value    numeric,
  invoiced_value    numeric,
  outstanding_value numeric
)
language sql
stable
security definer
set search_path = ''
as $fn$
  select
    po.id,
    po.po_number,
    po.vendor_id,
    v.name,
    po.status,
    recv.value,
    coalesce(inv.value, 0)::numeric(14,2),
    (recv.value - coalesce(inv.value, 0))::numeric(14,2)
  from public.purchase_orders po
  join public.vendors v on v.id = po.vendor_id
  -- What arrived, valued at the price the order agreed. Cancelled units never
  -- arrive, so they never appear here.
  join lateral (
    select coalesce(sum(
      least(coalesce(r.received, 0), i.quantity_ordered - i.quantity_cancelled) * i.unit_cost
    ), 0)::numeric(14,2) as value
    from public.purchase_order_items i
    left join lateral (
      select sum(pr.quantity_received) as received
        from public.procurement_receipts pr
       where pr.purchase_order_item_id = i.id
    ) r on true
    where i.purchase_order_id = po.id
  ) recv on true
  left join lateral (
    select sum(sl.line_total) as value
      from public.supplier_invoice_lines sl
      join public.supplier_invoices si on si.id = sl.supplier_invoice_id
     where si.purchase_order_id = po.id
       and si.status in ('for_review', 'approved')
  ) inv on true
  where public.can_read_finance_master()
    and po.status in ('approved', 'closed')
    and recv.value > coalesce(inv.value, 0)
  order by po.po_number;
$fn$;

revoke all on function public.get_invoiceable_purchase_orders() from public, anon;
grant execute on function public.get_invoiceable_purchase_orders() to authenticated;
