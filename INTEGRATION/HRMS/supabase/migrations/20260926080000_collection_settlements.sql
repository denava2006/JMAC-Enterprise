-- ===========================================================================
-- F6A  Collection settlements: getting POS money into a company account
-- ===========================================================================
--
-- F5.5 answers "how much did we sell, and where is the money". It shows cash
-- sitting in branch drawers and card money sitting with PayMongo. Neither is
-- yet in an account JMAC can spend from, and this phase is how it gets there.
--
-- Two flows, because the two are genuinely different events:
--
--   branch_cash  someone carried the takings to a bank and deposited them
--   provider     PayMongo paid out, keeping a fee
--
-- Both are RECORDED, not performed. PayMongo is test-mode only in this
-- deployment -- pos_payment_attempts_test_mode_only forces livemode false --
-- and there is no payout API integrated. So the wording throughout is "record
-- settlement": Finance is writing down something that already happened
-- outside the system, and a button reading "Withdraw from PayMongo" would be
-- claiming a capability that does not exist.
--
-- WHAT MAKES A SETTLEMENT HONEST.
--
-- Every settlement names the actual POS sales it settles. A settlement whose
-- amount is typed in free-hand is a number nobody can check; one built from
-- sale rows can be walked back to receipts. The item table carries a unique
-- index on the sale, so the same 70-peso sale cannot be deposited twice --
-- not by a double click, not by two Accountants working the same day, not by
-- a retry.
--
-- Gross comes from the sales. The Accountant states the fee. Net is gross
-- minus fee, and only the net reaches the bank -- which is the entire point of
-- keeping the three separate.

-- ---------------------------------------------------------------------------
-- 1. The document
-- ---------------------------------------------------------------------------
create table if not exists public.collection_settlements (
  id uuid primary key default gen_random_uuid(),
  settlement_no text,

  -- Which kind of money is being moved. A branch cash deposit and a provider
  -- payout are different events with different evidence, and collapsing them
  -- into one shape would mean neither could be validated properly.
  kind text not null check (kind in ('branch_cash', 'provider')),

  -- Set for branch_cash: whose drawer this emptied.
  branch_id uuid references public.branches(id) on delete restrict,
  -- Set for provider: which method settled. Matches pos_sales.payment_method.
  payment_method text,

  destination_account_id uuid not null
    references public.treasury_accounts(id) on delete restrict,

  -- The Accountant states the fee; gross is derived from the items, and net
  -- follows. Storing gross would let it drift from the sales it claims to
  -- represent, so it is not stored.
  fee_amount numeric(14,2) not null default 0 check (fee_amount >= 0),

  settlement_date date not null,
  reference text,
  notes text,

  status text not null default 'draft'
    check (status in ('draft', 'for_review', 'confirmed', 'returned', 'rejected')),

  prepared_by uuid references public.profiles(id) on delete set null,
  submitted_at timestamptz,
  reviewed_by uuid references public.profiles(id) on delete set null,
  reviewed_at timestamptz,
  decision_reason text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- A branch cash settlement names a branch and no method; a provider
  -- settlement names a method and no branch. Neither shape can be half-filled.
  constraint collection_settlements_shape check (
    (kind = 'branch_cash' and branch_id is not null and payment_method is null)
    or
    (kind = 'provider' and payment_method is not null and branch_id is null)
  ),
  -- Only a provider keeps a fee. A deposit of cash into a bank does not shrink
  -- on the way; if it did, that is a discrepancy to investigate, not a fee.
  constraint collection_settlements_fee_is_provider check (
    fee_amount = 0 or kind = 'provider'
  )
);

create index if not exists collection_settlements_status_idx
  on public.collection_settlements (status, settlement_date desc);

create unique index if not exists collection_settlements_no_unique
  on public.collection_settlements (settlement_no) where settlement_no is not null;

-- The same external deposit slip cannot be recorded twice. Returned and
-- rejected records are excluded: a rejected attempt should not block the
-- corrected one from carrying the same real-world reference.
create unique index if not exists collection_settlements_reference_unique
  on public.collection_settlements (
    destination_account_id, upper(btrim(reference))
  ) where reference is not null and btrim(reference) <> ''
      and status not in ('returned', 'rejected');

comment on table public.collection_settlements is
  'A record that POS collections reached a company account. Recorded after the '
  'fact -- no payout API is integrated. Gross is derived from the items.';

-- ---------------------------------------------------------------------------
-- 2. What it settles
-- ---------------------------------------------------------------------------
--
-- One row per POS sale. This is the traceability the brief asks for and the
-- duplicate protection at the same time: the unique index below is what stops
-- the same collection reaching the bank twice on paper.
create table if not exists public.collection_settlement_items (
  id uuid primary key default gen_random_uuid(),
  settlement_id uuid not null
    references public.collection_settlements(id) on delete cascade,
  pos_sale_id uuid not null references public.pos_sales(id) on delete restrict,

  -- Snapshotted from the sale when the line is added, so the settlement's
  -- gross stays reconcilable even though pos_sales is immutable anyway. It is
  -- validated against the sale on insert rather than trusted.
  amount numeric(14,2) not null check (amount > 0),
  created_at timestamptz not null default now()
);

create index if not exists collection_settlement_items_settlement_idx
  on public.collection_settlement_items (settlement_id);

comment on table public.collection_settlement_items is
  'The POS sales a settlement covers. One live settlement per sale, so one '
  'collection cannot be settled twice.';

-- "At most one LIVE settlement per sale" cannot be a partial unique index: the
-- predicate would have to consult collection_settlements, and an index
-- predicate may not contain a subquery. A rejected settlement has to release
-- its sales -- otherwise one bad record strands that money for ever -- so the
-- rule genuinely depends on the parent's status, and it is enforced on the row
-- every insert passes through instead.
create or replace function public.guard_settlement_item_once()
returns trigger language plpgsql set search_path = '' as $fn$
declare
  _clash text;
  _sale public.pos_sales%rowtype;
  _s public.collection_settlements%rowtype;
begin
  select * into _s from public.collection_settlements where id = new.settlement_id;
  select * into _sale from public.pos_sales where id = new.pos_sale_id;

  if _sale.id is null then
    raise exception 'That sale does not exist.' using errcode = 'check_violation';
  end if;

  -- Only a completed sale is money. Nothing else in POS produces a pos_sales
  -- row -- abandoned, failed, expired and paid_unfulfilled attempts never do
  -- -- so this predicate is belt to that braces, and stays correct if the
  -- status enum ever grows a member.
  if _sale.status <> 'completed' then
    raise exception 'Only completed sales can be settled.' using errcode = 'check_violation';
  end if;

  -- The line must match the settlement it is on: a provider settlement cannot
  -- carry a cash sale, and a branch deposit cannot carry another branch's.
  if _s.kind = 'branch_cash' then
    if _sale.payment_method <> 'cash' then
      raise exception 'A branch cash remittance can only cover cash sales.'
        using errcode = 'check_violation';
    end if;
    if _sale.branch_id <> _s.branch_id then
      raise exception 'That sale belongs to another branch.' using errcode = 'check_violation';
    end if;
  else
    if _sale.payment_method <> _s.payment_method then
      raise exception 'That sale was not paid by %.', _s.payment_method
        using errcode = 'check_violation';
    end if;
    if _sale.payment_method = 'cash' then
      raise exception 'Cash is remitted by the branch, not settled by a provider.'
        using errcode = 'check_violation';
    end if;
  end if;

  -- The amount is the sale's, not the client's. A settlement line that could
  -- state its own figure would let the gross drift from the receipts.
  if new.amount is distinct from _sale.total_amount then
    new.amount := _sale.total_amount;
  end if;

  -- Settled once, and only once.
  select s.settlement_no into _clash
  from public.collection_settlement_items i
  join public.collection_settlements s on s.id = i.settlement_id
  where i.pos_sale_id = new.pos_sale_id
    and i.settlement_id <> new.settlement_id
    and s.status not in ('returned', 'rejected')
  limit 1;

  if _clash is not null then
    raise exception 'That sale is already covered by settlement %.', coalesce(_clash, 'a draft')
      using errcode = 'unique_violation';
  end if;

  return new;
end;
$fn$;

drop trigger if exists trg_settlement_item_once on public.collection_settlement_items;
create trigger trg_settlement_item_once
  before insert or update on public.collection_settlement_items
  for each row execute function public.guard_settlement_item_once();

-- ---------------------------------------------------------------------------
-- 3. Derived figures
-- ---------------------------------------------------------------------------
create or replace function public.settlement_gross(_settlement_id uuid)
returns numeric
language sql
stable
security definer
set search_path = ''
as $fn$
  select coalesce(sum(i.amount), 0)::numeric(14,2)
  from public.collection_settlement_items i
  where i.settlement_id = _settlement_id;
$fn$;

create or replace view public.collection_settlement_status
with (security_invoker = on) as
  select
    s.id,
    s.settlement_no,
    s.kind,
    s.branch_id,
    b.name as branch_name,
    s.payment_method,
    s.destination_account_id,
    ta.name as destination_account_name,
    ta.account_type as destination_account_type,
    coalesce(g.gross, 0)::numeric(14,2) as gross_amount,
    s.fee_amount,
    (coalesce(g.gross, 0) - s.fee_amount)::numeric(14,2) as net_amount,
    coalesce(g.item_count, 0)::integer as item_count,
    s.settlement_date,
    s.reference,
    s.notes,
    s.status,
    s.prepared_by,
    pp.full_name as prepared_by_name,
    s.submitted_at,
    s.reviewed_by,
    rp.full_name as reviewed_by_name,
    s.reviewed_at,
    s.decision_reason,
    s.created_at,
    s.updated_at
  from public.collection_settlements s
  left join public.branches b on b.id = s.branch_id
  left join public.treasury_accounts ta on ta.id = s.destination_account_id
  left join public.profiles pp on pp.id = s.prepared_by
  left join public.profiles rp on rp.id = s.reviewed_by
  left join lateral (
    select sum(i.amount) as gross, count(*) as item_count
    from public.collection_settlement_items i
    where i.settlement_id = s.id
  ) g on true;

-- ---------------------------------------------------------------------------
-- 4. Numbering
-- ---------------------------------------------------------------------------
create or replace function public.set_settlement_no()
returns trigger language plpgsql set search_path = '' as $fn$
declare _year text := to_char(coalesce(new.settlement_date, current_date), 'YYYY');
begin
  if new.settlement_no is null then
    new.settlement_no := 'CS-' || _year || '-' || lpad((
      select count(*) + 1 from public.collection_settlements
       where settlement_no like 'CS-' || _year || '-%'
    )::text, 4, '0');
  end if;
  return new;
end;
$fn$;

drop trigger if exists trg_settlement_no on public.collection_settlements;
create trigger trg_settlement_no
  before insert on public.collection_settlements
  for each row execute function public.set_settlement_no();

-- ---------------------------------------------------------------------------
-- 5. Who may do what
-- ---------------------------------------------------------------------------
alter table public.collection_settlements enable row level security;
alter table public.collection_settlement_items enable row level security;

drop policy if exists collection_settlements_read on public.collection_settlements;
create policy collection_settlements_read on public.collection_settlements
  for select to authenticated using (public.can_read_finance_master());

drop policy if exists collection_settlement_items_read on public.collection_settlement_items;
create policy collection_settlement_items_read on public.collection_settlement_items
  for select to authenticated using (public.can_read_finance_master());

-- Preparing is the Accountant's. The Finance Manager reviews and never writes:
-- a checker who can edit the document is approving their own work under
-- another name, which is the whole failure maker/checker exists to prevent.
drop policy if exists collection_settlements_write on public.collection_settlements;
create policy collection_settlements_write on public.collection_settlements
  for insert to authenticated
  with check (public.has_finance_privilege(array['accountant']));

drop policy if exists collection_settlements_edit on public.collection_settlements;
create policy collection_settlements_edit on public.collection_settlements
  for update to authenticated
  using (public.has_finance_privilege(array['accountant', 'finance_manager']))
  with check (public.has_finance_privilege(array['accountant', 'finance_manager']));

drop policy if exists collection_settlement_items_write on public.collection_settlement_items;
create policy collection_settlement_items_write on public.collection_settlement_items
  for insert to authenticated
  with check (public.has_finance_privilege(array['accountant']));

drop policy if exists collection_settlement_items_delete on public.collection_settlement_items;
create policy collection_settlement_items_delete on public.collection_settlement_items
  for delete to authenticated
  using (public.has_finance_privilege(array['accountant']));

-- The document is only editable while it is the Accountant's to edit, and the
-- Manager may only ever move its status. Enforced on the row every path writes
-- rather than inside each function, so a route added later cannot miss it.
create or replace function public.guard_settlement_edit()
returns trigger language plpgsql set search_path = '' as $fn$
begin
  if tg_op = 'INSERT' then
    new.status := 'draft';
    new.prepared_by := coalesce(new.prepared_by, (select auth.uid()));
    new.reviewed_by := null;
    new.reviewed_at := null;
    new.submitted_at := null;
    return new;
  end if;

  -- A confirmed settlement is history. It moved money; changing it now would
  -- restate a balance that has already been reported.
  if old.status = 'confirmed'
     and (new.status is distinct from old.status
          or new.fee_amount is distinct from old.fee_amount
          or new.destination_account_id is distinct from old.destination_account_id
          or new.settlement_date is distinct from old.settlement_date
          or new.reference is distinct from old.reference)
  then
    raise exception 'A confirmed settlement is a permanent record and cannot be changed.'
      using errcode = 'insufficient_privilege';
  end if;

  -- Content changes belong to the Accountant, and only before review.
  if (new.fee_amount is distinct from old.fee_amount
      or new.destination_account_id is distinct from old.destination_account_id
      or new.settlement_date is distinct from old.settlement_date
      or new.reference is distinct from old.reference
      or new.notes is distinct from old.notes
      or new.kind is distinct from old.kind
      or new.branch_id is distinct from old.branch_id
      or new.payment_method is distinct from old.payment_method)
  then
    if not public.has_finance_privilege(array['accountant']) then
      raise exception 'Only the Accountant who prepares a settlement may change its details.'
        using errcode = 'insufficient_privilege';
    end if;
    if old.status not in ('draft', 'returned') then
      raise exception 'This settlement is with the Finance Manager. Ask for it back before editing.'
        using errcode = 'check_violation';
    end if;
  end if;

  new.updated_at := now();
  return new;
end;
$fn$;

drop trigger if exists trg_settlement_edit on public.collection_settlements;
create trigger trg_settlement_edit
  before insert or update on public.collection_settlements
  for each row execute function public.guard_settlement_edit();

-- Lines follow the document: once it has left the Accountant's hands they are
-- fixed, because the gross the Manager approved is computed from them.
create or replace function public.guard_settlement_item_editable()
returns trigger language plpgsql set search_path = '' as $fn$
declare _status text;
begin
  select status into _status from public.collection_settlements
   where id = coalesce(new.settlement_id, old.settlement_id);
  if _status is null then return coalesce(new, old); end if;
  if _status not in ('draft', 'returned') then
    raise exception 'This settlement is no longer a draft, so its sales are fixed.'
      using errcode = 'check_violation';
  end if;
  return coalesce(new, old);
end;
$fn$;

drop trigger if exists trg_settlement_item_editable on public.collection_settlement_items;
create trigger trg_settlement_item_editable
  before insert or update or delete on public.collection_settlement_items
  for each row execute function public.guard_settlement_item_editable();
