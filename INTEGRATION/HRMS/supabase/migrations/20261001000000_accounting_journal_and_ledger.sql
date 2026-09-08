-- F8: journal entries, the general ledger, and the reports over them.
--
-- An accounting mirror, not a new way to move money. Every posted entry is the
-- consequence of a JMAC transaction that has already completed its own
-- workflow, and nothing here can start one.
--
-- WHAT THE AUDIT FOUND, because it decided the whole design:
--
--   finance_accounts is ALREADY a chart of accounts -- account_code,
--   account_type constrained to asset/liability/equity/revenue/expense, and an
--   account_subtype check. It is empty, but it is the right table, so F8 seeds
--   it rather than building a second one.
--
--   treasury_accounts.finance_account_id ALREADY exists as the bank-to-GL
--   mapping. It is null everywhere, so F8 fills it and keeps it filled, rather
--   than matching bank accounts by name at runtime.
--
--   treasury_movements is the one place every final cash event lands. Its
--   source_type is constrained to exactly the four F8 posts from --
--   collection_settlement, supplier_payment, reimbursement_payment,
--   payroll_disbursement -- it carries direction, amount and occurred_on, it is
--   written only inside the authoritative transition functions at the moment
--   the money actually moves, and it is unique on (source_type, source_id).
--
-- So the posting source is the treasury movement. That single choice answers
-- most of the brief on its own: entries can only exist for final events,
-- exactly once, at the authoritative amount and business date, with no second
-- journal from a second table describing the same peso -- and no existing
-- workflow function has to be touched to make it happen.
--
-- Nothing is backfilled here. Production holds four completed movements and
-- this migration deliberately leaves them unposted; posting them is a separate
-- authorisation.

-- ===========================================================================
-- 1. The chart of accounts JMAC actually needs
-- ===========================================================================
-- Codes are already unique -- finance_accounts_code_unique exists on
-- upper(account_code), and there is a matching one on lower(name). Nothing to
-- add, and the seed below is written to respect both rather than relying on
-- ON CONFLICT inferring an expression index.
--
-- Small on purpose. Five operational accounts plus one mirror per treasury
-- account is the whole thing -- a chart with dozens of unused rows would look
-- like accounting software and describe nothing.
insert into public.finance_accounts (account_code, name, account_type, account_subtype, is_active)
select v.code, v.nm, v.typ, v.sub, true
from (values
  ('4000', 'Sales Revenue',                  'revenue', 'operating'),
  ('5000', 'Purchases and Supplier Expense', 'expense', 'operating'),
  ('5100', 'Employee Reimbursement Expense', 'expense', 'operating'),
  ('5200', 'Payroll Expense',                'expense', 'operating'),
  -- Collection settlements carry an authoritative fee_amount. It is a real
  -- cost of collecting, and the settlement records it, so it gets an account
  -- rather than being folded into revenue.
  ('5300', 'Collection Processing Fees',     'expense', 'operating')
) as v(code, nm, typ, sub)
where not exists (
  select 1 from public.finance_accounts a
   where upper(a.account_code) = upper(v.code) or lower(a.name) = lower(v.nm)
);

-- ---------------------------------------------------------------------------
-- Treasury account -> GL account
-- ---------------------------------------------------------------------------
-- One asset account mirroring each treasury account, linked by the column that
-- already existed for it. Created rather than matched: inferring "Main Bank
-- Account" means a GL account by its name is the kind of thing that works until
-- somebody renames a bank.
create or replace function public.ensure_treasury_gl_account(_treasury_account_id uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  _t public.treasury_accounts%rowtype;
  _gl uuid;
  _code text;
begin
  select * into _t from public.treasury_accounts where id = _treasury_account_id;
  if _t.id is null then
    raise exception 'No treasury account %', _treasury_account_id using errcode = 'no_data_found';
  end if;
  if _t.finance_account_id is not null then
    return _t.finance_account_id;
  end if;

  -- 1100 upwards, stepping over whatever is already taken.
  select coalesce(max(a.account_code::integer), 1090) + 10 into _code
  from public.finance_accounts a
  where a.account_code ~ '^1[0-9]{3}$';

  -- finance_accounts also carries a unique index on lower(name). A treasury
  -- account whose name is already taken in the chart gets its code appended
  -- rather than failing the treasury insert that triggered this.
  if exists (select 1 from public.finance_accounts a where lower(a.name) = lower(_t.name)) then
    _t.name := _t.name || ' (' || _code || ')';
  end if;

  insert into public.finance_accounts
    (account_code, name, account_type, account_subtype, currency, is_active)
  values (
    _code, _t.name, 'asset',
    case _t.account_type
      when 'bank' then 'bank'
      when 'cash' then 'cash'
      when 'e_wallet' then 'e_wallet'
      else 'other'
    end,
    coalesce(_t.currency, 'PHP'), true)
  returning id into _gl;

  update public.treasury_accounts set finance_account_id = _gl where id = _treasury_account_id;
  return _gl;
end;
$fn$;

revoke all on function public.ensure_treasury_gl_account(uuid) from public, anon, authenticated;

-- Every treasury account that exists now.
do $$
declare _id uuid;
begin
  for _id in select id from public.treasury_accounts where finance_account_id is null order by created_at loop
    perform public.ensure_treasury_gl_account(_id);
  end loop;
end $$;

-- And every one created afterwards, so posting never meets an unmapped account.
create or replace function public.map_new_treasury_account()
returns trigger
language plpgsql
security definer
set search_path = ''
as $fn$
begin
  perform public.ensure_treasury_gl_account(new.id);
  return null;
end;
$fn$;

revoke all on function public.map_new_treasury_account() from public, anon, authenticated;

drop trigger if exists trg_map_new_treasury_account on public.treasury_accounts;
create trigger trg_map_new_treasury_account
  after insert on public.treasury_accounts
  for each row execute function public.map_new_treasury_account();

-- ===========================================================================
-- 2. Journal entries
-- ===========================================================================
create table if not exists public.journal_entries (
  id uuid primary key default gen_random_uuid(),
  journal_no text unique,

  -- Date-only, and it is the source event's own business date -- occurred_on
  -- off the treasury movement, never a timestamp converted through UTC.
  posting_date date not null,
  description text not null,

  -- Provenance. Server-written, never client-supplied, and immutable after
  -- posting: the answer to "what JMAC transaction created this entry".
  source_type text not null
    check (source_type in ('collection_settlement', 'supplier_payment',
                           'reimbursement_payment', 'payroll_disbursement')),
  source_id uuid not null,
  source_reference text,
  -- The movement this mirrors, so the cash side is traceable both ways.
  treasury_movement_id uuid unique references public.treasury_movements(id) on delete restrict,

  status text not null default 'posted' check (status in ('posted')),
  posted_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  created_by uuid references public.profiles(id) on delete set null,

  -- One finalized source event, one accounting consequence. A retried posting
  -- meets this rather than a check somebody remembered to write.
  constraint journal_entries_one_per_source unique (source_type, source_id)
);

create index if not exists journal_entries_posting_date_idx
  on public.journal_entries (posting_date);

comment on table public.journal_entries is
  'The accounting mirror of a completed JMAC cash event. F8 posts these from '
  'treasury movements; it never originates money and never edits its source.';

create table if not exists public.journal_entry_lines (
  id uuid primary key default gen_random_uuid(),
  journal_entry_id uuid not null
    references public.journal_entries(id) on delete restrict,
  account_id uuid not null references public.finance_accounts(id) on delete restrict,
  description text,

  debit  numeric(14,2) not null default 0,
  credit numeric(14,2) not null default 0,
  line_no integer not null,

  created_at timestamptz not null default now(),

  -- numeric throughout. Money is never a float here.
  constraint journal_entry_lines_signs check (debit >= 0 and credit >= 0),
  -- A line is one side or the other, and is never nothing.
  constraint journal_entry_lines_one_side check (
    (debit > 0 and credit = 0) or (credit > 0 and debit = 0)
  ),
  constraint journal_entry_lines_unique_no unique (journal_entry_id, line_no)
);

create index if not exists journal_entry_lines_entry_idx
  on public.journal_entry_lines (journal_entry_id);
create index if not exists journal_entry_lines_account_idx
  on public.journal_entry_lines (account_id);

-- ---------------------------------------------------------------------------
-- Numbering
-- ---------------------------------------------------------------------------
create or replace function public.set_journal_no()
returns trigger language plpgsql set search_path = '' as $fn$
declare _year text := to_char(new.posting_date, 'YYYY');
begin
  if new.journal_no is null then
    new.journal_no := 'JE-' || _year || '-' || lpad((
      select count(*) + 1 from public.journal_entries
       where journal_no like 'JE-' || _year || '-%'
    )::text, 4, '0');
  end if;
  return new;
end;
$fn$;

drop trigger if exists trg_journal_no on public.journal_entries;
create trigger trg_journal_no before insert on public.journal_entries
  for each row execute function public.set_journal_no();

-- ===========================================================================
-- 3. Debits equal credits, and a posted entry never changes
-- ===========================================================================
-- Checked at the end of the statement, so a multi-line entry is judged once it
-- is whole rather than after its first line.
create or replace function public.require_balanced_journal()
returns trigger
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  _entry uuid;
  _debit numeric(14,2);
  _credit numeric(14,2);
  _lines integer;
begin
  for _entry in
    select distinct journal_entry_id from new_lines
  loop
    select coalesce(sum(debit), 0), coalesce(sum(credit), 0), count(*)
      into _debit, _credit, _lines
    from public.journal_entry_lines where journal_entry_id = _entry;

    if _lines < 2 then
      raise exception 'A journal entry needs at least two lines to balance; this one has %.', _lines
        using errcode = 'check_violation';
    end if;

    if _debit <> _credit then
      raise exception 'A journal entry must balance. Debits total % and credits total %.',
        to_char(_debit, 'FM999,999,999.00'), to_char(_credit, 'FM999,999,999.00')
        using errcode = 'check_violation';
    end if;
  end loop;
  return null;
end;
$fn$;

revoke all on function public.require_balanced_journal() from public, anon, authenticated;

-- Statement-level with a transition table, not a deferred constraint trigger:
-- a deferred one fires at COMMIT, which a rollback-based test never reaches, so
-- the rule would be untestable exactly where it matters most. Every entry
-- therefore writes all of its lines in one statement, and this judges it whole.
drop trigger if exists trg_journal_balances on public.journal_entry_lines;
create trigger trg_journal_balances
  after insert on public.journal_entry_lines
  referencing new table as new_lines
  for each statement execute function public.require_balanced_journal();

-- ---------------------------------------------------------------------------
-- Immutability
-- ---------------------------------------------------------------------------
-- A posted entry is a record of something that happened. F8 has no reversal
-- workflow and deliberately does not invent one: the source processes it
-- mirrors already make their paid events permanent.
create or replace function public.freeze_posted_journal()
returns trigger
language plpgsql
security definer
set search_path = ''
as $fn$
begin
  if tg_op = 'DELETE' then
    raise exception 'A posted journal entry cannot be deleted. It records a transaction that happened.'
      using errcode = 'insufficient_privilege';
  end if;
  raise exception 'A posted journal entry cannot be changed -- not its amounts, its accounts, or what it came from.'
    using errcode = 'insufficient_privilege';
end;
$fn$;

revoke all on function public.freeze_posted_journal() from public, anon, authenticated;

drop trigger if exists trg_freeze_posted_journal on public.journal_entries;
create trigger trg_freeze_posted_journal
  before update or delete on public.journal_entries
  for each row execute function public.freeze_posted_journal();

drop trigger if exists trg_freeze_posted_journal_lines on public.journal_entry_lines;
create trigger trg_freeze_posted_journal_lines
  before update or delete on public.journal_entry_lines
  for each row execute function public.freeze_posted_journal();

-- An account with history behind it is retired, never removed.
create or replace function public.protect_used_finance_account()
returns trigger
language plpgsql
security definer
set search_path = ''
as $fn$
begin
  if exists (select 1 from public.journal_entry_lines l where l.account_id = old.id) then
    raise exception 'Account % has posted journal entries against it. Make it inactive instead of deleting it.',
      old.account_code using errcode = 'insufficient_privilege';
  end if;
  return old;
end;
$fn$;

revoke all on function public.protect_used_finance_account() from public, anon, authenticated;

drop trigger if exists trg_protect_used_finance_account on public.finance_accounts;
create trigger trg_protect_used_finance_account
  before delete on public.finance_accounts
  for each row execute function public.protect_used_finance_account();

-- ===========================================================================
-- 4. Posting
-- ===========================================================================
-- One entry point, taking a movement id and nothing else. There is no
-- parameter for an amount, an account or a date, so no caller -- however
-- authorised -- can post a figure the source does not say. Everything is
-- loaded here from the authoritative rows.
create or replace function public.post_treasury_movement_journal(_movement_id uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  _m public.treasury_movements%rowtype;
  _bank uuid;
  _entry uuid;
  _contra uuid;
  _gross numeric(14,2);
  _fee numeric(14,2);
  _ref text;
  _desc text;
  _fee_account uuid;
begin
  select * into _m from public.treasury_movements where id = _movement_id;
  if _m.id is null then
    raise exception 'No treasury movement %', _movement_id using errcode = 'no_data_found';
  end if;

  -- Already accounted for. Retries, replays and a second delivery of the same
  -- event all land here and get the entry that already exists.
  select id into _entry from public.journal_entries
   where source_type = _m.source_type and source_id = _m.source_id;
  if _entry is not null then
    return _entry;
  end if;

  _bank := public.ensure_treasury_gl_account(_m.treasury_account_id);

  if _m.source_type = 'reimbursement_payment' then
    select account_id_of.id into _contra from public.finance_accounts account_id_of
     where account_id_of.account_code = '5100';
    select p.payment_no into _ref from public.reimbursement_payments p where p.id = _m.source_id;
    _desc := 'Employee reimbursement paid';

  elsif _m.source_type = 'supplier_payment' then
    select a.id into _contra from public.finance_accounts a where a.account_code = '5000';
    select p.payment_no into _ref from public.supplier_payments p where p.id = _m.source_id;
    _desc := 'Supplier payment';

  elsif _m.source_type = 'payroll_disbursement' then
    -- One aggregate line. The per-employee figures are deliberately not read:
    -- Finance Staff can see this ledger, and payroll salary detail is not
    -- theirs. The disbursement's own total is the authoritative amount anyway.
    select a.id into _contra from public.finance_accounts a where a.account_code = '5200';
    select d.disbursement_no into _ref from public.payroll_disbursements d where d.id = _m.source_id;
    _desc := 'Payroll disbursement';

  elsif _m.source_type = 'collection_settlement' then
    select a.id into _contra from public.finance_accounts a where a.account_code = '4000';
    select s.settlement_no, coalesce(s.fee_amount, 0) into _ref, _fee
      from public.collection_settlements s where s.id = _m.source_id;
    select coalesce(sum(i.amount), 0) into _gross
      from public.collection_settlement_items i where i.settlement_id = _m.source_id;
    _desc := 'Collection settled to bank';
  else
    raise exception 'F8 does not know how to account for a % movement.', _m.source_type
      using errcode = 'feature_not_supported';
  end if;

  if _contra is null then
    raise exception 'The accounting account for a % is missing from the chart of accounts.',
      _m.source_type using errcode = 'check_violation';
  end if;

  insert into public.journal_entries
    (posting_date, description, source_type, source_id, source_reference,
     treasury_movement_id, created_by)
  values (_m.occurred_on, _desc, _m.source_type, _m.source_id, _ref, _m.id, _m.created_by)
  returning id into _entry;

  if _m.direction = 'out' then
    -- Money left: the expense is incurred, the bank falls.
    insert into public.journal_entry_lines
      (journal_entry_id, account_id, description, debit, credit, line_no)
    values (_entry, _contra, _ref, _m.amount, 0, 1),
           (_entry, _bank,   _ref, 0, _m.amount, 2);
  else
    -- Money arrived. The bank rises by the net that actually landed; revenue is
    -- the gross the settlement covered, and the difference is the fee the
    -- settlement itself records. Nothing is inferred -- if there is no fee the
    -- third line simply is not written.
    if _gross is null or _gross <= 0 then
      _gross := _m.amount;
      _fee := 0;
    end if;
    if _fee is null then _fee := 0; end if;
    if _m.amount + _fee <> _gross then
      raise exception 'Settlement % does not reconcile: % banked plus % in fees is not the % collected.',
        _ref, _m.amount, _fee, _gross using errcode = 'check_violation';
    end if;

    select a.id into _fee_account from public.finance_accounts a where a.account_code = '5300';
    if _fee > 0 and _fee_account is null then
      raise exception 'Settlement % has a fee but there is no fee account in the chart of accounts.',
        _ref using errcode = 'check_violation';
    end if;

    -- One statement, so the balance check sees the whole entry. The fee line
    -- is filtered out rather than skipped by a branch: no fee, no line.
    insert into public.journal_entry_lines
      (journal_entry_id, account_id, description, debit, credit, line_no)
    select _entry, v.acct, v.descr, v.dr, v.cr, v.ln
    from (values
      (_bank, _ref, _m.amount, 0::numeric, 1),
      (coalesce(_fee_account, _bank), _ref || ' processing fee', _fee, 0::numeric, 2),
      (_contra, _ref, 0::numeric, _gross, 3)
    ) as v(acct, descr, dr, cr, ln)
    where v.dr > 0 or v.cr > 0;
  end if;

  return _entry;
end;
$fn$;

-- Not callable by anybody through the API. It is reached by the trigger below
-- and by an explicitly authorised backfill, never from a browser.
revoke all on function public.post_treasury_movement_journal(uuid) from public, anon, authenticated;

-- The one hook into the existing system, and it changes no existing function:
-- a movement is written only when money has actually moved.
create or replace function public.account_for_treasury_movement()
returns trigger
language plpgsql
security definer
set search_path = ''
as $fn$
begin
  perform public.post_treasury_movement_journal(new.id);
  return null;
end;
$fn$;

revoke all on function public.account_for_treasury_movement() from public, anon, authenticated;

drop trigger if exists trg_account_for_treasury_movement on public.treasury_movements;
create trigger trg_account_for_treasury_movement
  after insert on public.treasury_movements
  for each row execute function public.account_for_treasury_movement();

-- ===========================================================================
-- 5. Reading it back
-- ===========================================================================
-- Everything below derives from posted lines. No balance is stored anywhere.
--
-- security_invoker is on, as it is on every other view over an RLS-protected
-- table here. Without it the view would run as its owner and read straight
-- past the policies below, so a grant to `authenticated` would hand the whole
-- ledger to every logged-in cashier and applicant. The policy on the base
-- table stays the one authorization boundary.
create or replace view public.general_ledger_lines
with (security_invoker = on) as
  select
    l.id,
    l.journal_entry_id,
    e.journal_no,
    e.posting_date,
    e.description,
    e.source_type,
    e.source_reference,
    l.account_id,
    a.account_code,
    a.name as account_name,
    a.account_type,
    l.line_no,
    l.description as line_description,
    l.debit,
    l.credit
  from public.journal_entry_lines l
  join public.journal_entries e on e.id = l.journal_entry_id
  join public.finance_accounts a on a.id = l.account_id;

comment on view public.general_ledger_lines is
  'Posted journal lines with their entry and account. The ledger, the trial '
  'balance and the summaries all read from here -- there is no second set of '
  'balances to disagree with it.';

-- Trial balance: one row per account that has posted activity, netted to the
-- side it falls on.
create or replace view public.trial_balance
with (security_invoker = on) as
  select
    a.id as account_id,
    a.account_code,
    a.name as account_name,
    a.account_type,
    greatest(coalesce(sum(l.debit), 0) - coalesce(sum(l.credit), 0), 0)::numeric(14,2) as debit_balance,
    greatest(coalesce(sum(l.credit), 0) - coalesce(sum(l.debit), 0), 0)::numeric(14,2) as credit_balance
  from public.finance_accounts a
  join public.journal_entry_lines l on l.account_id = a.id
  group by a.id, a.account_code, a.name, a.account_type;

comment on view public.trial_balance is
  'Derived from posted journal lines. Totals balance because every entry does.';

alter table public.journal_entries      enable row level security;
alter table public.journal_entry_lines  enable row level security;

-- Read-only to Finance, and to nobody else. There is no insert, update or
-- delete policy on either table at all: entries arrive through the posting
-- function, which is SECURITY DEFINER, and leave never.
drop policy if exists journal_entries_read on public.journal_entries;
create policy journal_entries_read on public.journal_entries
  for select to authenticated
  using (public.can_read_finance_master());

drop policy if exists journal_entry_lines_read on public.journal_entry_lines;
create policy journal_entry_lines_read on public.journal_entry_lines
  for select to authenticated
  using (public.can_read_finance_master());

grant select on public.journal_entries      to authenticated;
grant select on public.journal_entry_lines  to authenticated;
revoke all on public.general_ledger_lines from anon, public, authenticated;
revoke all on public.trial_balance         from anon, public, authenticated;
grant select on public.general_ledger_lines to authenticated;
grant select on public.trial_balance        to authenticated;
