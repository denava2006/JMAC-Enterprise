-- FMS F4.2 -- the checker stops being able to write the document
--
-- A hosted screenshot showed a Finance Manager looking at a purchase order
-- with the line editor and the delete icons still on screen. The frontend has
-- been corrected, but the frontend was never the reason it was wrong: the
-- write policies admitted finance_manager to purchase_orders, its lines and
-- its sources, so the Manager really could author the document they were
-- being asked to approve. That is the hole.

drop policy if exists purchase_orders_prepare on public.purchase_orders;
create policy purchase_orders_prepare on public.purchase_orders
  for insert to authenticated
  with check (
    status = 'draft'
    and public.has_finance_privilege(array['finance_staff'])
  );

drop policy if exists purchase_orders_amend on public.purchase_orders;
create policy purchase_orders_amend on public.purchase_orders
  for update to authenticated
  using (
    status in ('draft', 'returned')
    and public.has_finance_privilege(array['finance_staff'])
  )
  with check (
    status in ('draft', 'returned')
    and public.has_finance_privilege(array['finance_staff'])
  );

drop policy if exists purchase_order_items_write on public.purchase_order_items;
create policy purchase_order_items_write on public.purchase_order_items
  for all to authenticated
  using (
    public.has_finance_privilege(array['finance_staff'])
    and exists (
      select 1 from public.purchase_orders po
      where po.id = purchase_order_id and po.status in ('draft', 'returned')
    )
  )
  with check (
    public.has_finance_privilege(array['finance_staff'])
    and exists (
      select 1 from public.purchase_orders po
      where po.id = purchase_order_id and po.status in ('draft', 'returned')
    )
  );

drop policy if exists purchase_order_sources_link on public.purchase_order_sources;
create policy purchase_order_sources_link on public.purchase_order_sources
  for all to authenticated
  using (
    public.has_finance_privilege(array['finance_staff'])
    and exists (
      select 1 from public.purchase_orders po
      where po.id = purchase_order_id and po.status in ('draft', 'returned')
    )
  )
  with check (
    public.has_finance_privilege(array['finance_staff'])
    and exists (
      select 1 from public.purchase_orders po
      where po.id = purchase_order_id and po.status in ('draft', 'returned')
    )
  );

-- ------------------------------------------------------------ the transition
--
-- Same signature as F4, three rules added. Reproduced whole rather than
-- patched because create-or-replace takes the entire body, and a transition
-- table is easier to read as one piece than as a diff.
create or replace function public.transition_purchase_order(
  _purchase_order_id uuid,
  _to_status text,
  _remarks text default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  _po          record;
  _uid         uuid := (select auth.uid());
  _role        text;
  _allowed     boolean := false;
  _lines       integer;
  _vendor      record;
  _outstanding integer;
  _action      text;
begin
  select * into _po from public.purchase_orders where id = _purchase_order_id for update;
  if _po.id is null then
    raise exception 'That purchase order no longer exists.' using errcode = 'no_data_found';
  end if;

  select role::text into _role from public.profiles where id = _uid and status = 'active';
  if _role is null or not public.has_finance_privilege(array[_role]) then
    raise exception 'Only Finance can move a purchase order.' using errcode = 'insufficient_privilege';
  end if;

  if _role = 'finance_staff' and _po.status = 'draft' and _to_status = 'pending_approval' then
    _allowed := true;
  elsif _role = 'finance_staff' and _po.status = 'returned' and _to_status = 'pending_approval' then
    _allowed := true;
  elsif _role = 'finance_staff' and _po.status in ('draft', 'returned') and _to_status = 'cancelled' then
    _allowed := true;
  elsif _role = 'finance_manager' and _po.status = 'pending_approval'
        and _to_status in ('approved', 'returned', 'rejected') then
    _allowed := true;
  elsif _role = 'finance_manager' and _po.status = 'approved' and _to_status = 'cancelled' then
    -- Withdrawing an order before anything was delivered. The receiving bridge
    -- refuses a PO that is not approved, so this stops further receipts.
    _allowed := true;
  elsif _role = 'finance_manager' and _po.status = 'approved' and _to_status = 'closed' then
    _allowed := true;
  end if;

  if not _allowed then
    raise exception 'A % cannot move purchase order % from % to %.',
      _role, _po.po_number, _po.status, _to_status
      using errcode = 'insufficient_privilege';
  end if;

  -- Nobody approves the order they raised. The role matrix above very nearly
  -- guarantees this already, since only Staff may create a draft -- but only
  -- while nobody is ever promoted. This is the rule stated as a rule.
  if _to_status = 'approved' and _po.created_by is not distinct from _uid then
    raise exception 'You raised purchase order %, so somebody else has to approve it.', _po.po_number
      using errcode = 'insufficient_privilege';
  end if;

  -- An order with no lines orders nothing.
  if _to_status = 'pending_approval' then
    select count(*) into _lines from public.purchase_order_items where purchase_order_id = _po.id;
    if _lines = 0 then
      raise exception 'Add at least one line before submitting purchase order %.', _po.po_number
        using errcode = 'check_violation';
    end if;
  end if;

  -- A proposed vendor is not yet a supplier the company deals with. Checked
  -- when the order is put forward and again when it is approved, because a
  -- material edit to the vendor reopens its approval and the order must not
  -- quietly carry the stale verdict across.
  if _to_status in ('pending_approval', 'approved') then
    select * into _vendor from public.vendors where id = _po.vendor_id;
    if _vendor.approval_status <> 'approved' then
      raise exception 'Vendor % is not an approved supplier yet.', _vendor.name
        using errcode = 'check_violation';
    end if;
    if not _vendor.is_active then
      raise exception 'Vendor % is no longer active.', _vendor.name
        using errcode = 'check_violation';
    end if;
  end if;

  -- Cancelling an order that has already taken delivery would leave received
  -- stock attached to a cancelled document. (Note what is NOT done here: the
  -- POS movements from any receipt stand. Stock that physically arrived is on
  -- the shelf whatever happens to the paperwork.)
  if _to_status = 'cancelled' and exists (
    select 1 from public.procurement_receipts pr
    join public.purchase_order_items i on i.id = pr.purchase_order_item_id
    where i.purchase_order_id = _po.id
  ) then
    raise exception 'Purchase order % has already taken delivery and cannot be cancelled.',
      _po.po_number using errcode = 'check_violation';
  end if;

  _action := 'Purchase Order ' || initcap(_to_status);

  -- Closing means finished, and finished means everything ordered arrived.
  -- Only stock lines can be received at all -- a line for services or rent has
  -- no delivery to wait for -- so outstanding is counted over the receivable
  -- lines and nothing else.
  --
  -- Short-closing is allowed but never silent: it takes an explicit reason,
  -- it is only ever the Manager's call, and it is audited under its own name
  -- so a closed-short order can never be mistaken for a completed one.
  if _to_status = 'closed' then
    select coalesce(sum(i.quantity_ordered - coalesce(r.received, 0)), 0)
      into _outstanding
      from public.purchase_order_items i
      left join (
        select purchase_order_item_id, sum(quantity_received) as received
          from public.procurement_receipts group by purchase_order_item_id
      ) r on r.purchase_order_item_id = i.id
     where i.purchase_order_id = _po.id
       and i.pos_product_id is not null;

    if _outstanding > 0 then
      if nullif(btrim(coalesce(_remarks, '')), '') is null then
        raise exception
          'Purchase order % still has % unit(s) undelivered. Receive them, or give a reason to close it short.',
          _po.po_number, _outstanding
          using errcode = 'check_violation';
      end if;
      _action := 'Purchase Order Closed Short';
    end if;
  end if;

  update public.purchase_orders
     set status = _to_status,
         submitted_at = case when _to_status = 'pending_approval' then now() else submitted_at end,
         approved_by  = case when _to_status = 'approved' then _uid else approved_by end,
         approved_at  = case when _to_status = 'approved' then now() else approved_at end,
         closed_at    = case when _to_status in ('closed', 'cancelled', 'rejected') then now() else closed_at end,
         closed_reason = case when _to_status in ('closed', 'cancelled', 'rejected')
                              then coalesce(_remarks, _to_status) else closed_reason end,
         updated_at = now()
   where id = _purchase_order_id;

  insert into public.audit_logs (actor_id, action, table_name, record_id, new_data)
  values (_uid, _action, 'purchase_orders', _purchase_order_id,
          jsonb_build_object('po_number', _po.po_number, 'from', _po.status,
                             'to', _to_status, 'remarks', _remarks,
                             'outstanding', _outstanding));
end;
$fn$;

comment on function public.transition_purchase_order(uuid, text, text) is
  'Moves a purchase order. Maker submits, checker approves, and never the same person. Closing requires nothing outstanding unless a reason is given.';
