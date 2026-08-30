# JMAC Integration — Architecture

The durable technical reference for `C:\Projects\JMAC\INTEGRATION`.

First written 2026-08-24 as an audit, from the filesystem, the migration files
and the live local database. Kept current since; last updated **2026-08-25,
after Phase 7B**.

It records what **actually exists**, not what was planned. Where documentation
and code disagree, the code wins and the disagreement is recorded rather than
resolved silently — see [Conflicts](#e-conflicts-and-duplicate-concepts).

For current status, the next task and known problems, read `AI_HANDOFF.md`.
For how to work here, `AI_WORKFLOW.md`. For phase history and the reasons behind
each divergence from the standalone POS, `POS_TO_HRMS_MIGRATION_CLAUDE(1).md`.

---

## 0. Provenance — the two-repository trap

There are **two** JMAC integration attempts on this machine, and confusing them
has cost time before.

| Repo | Package | POS state |
| --- | --- | --- |
| `C:\Projects\JMAC Enterprise` | `jmac` 0.1.0 | an earlier, abandoned attempt: POS rebuilt inside a purpose-built app with `src/features/`, `src/services/`, `db/migrations/0001..0007` |
| `C:\Projects\JMAC` **(this one)** | `harmony-suite` 0.0.0 | the live effort: POS integrated into the real Harmony Suite HRMS codebase |

This workspace is the newer effort and a deliberate restart. Concepts from the
other repository — `store_memberships` as a view over `users`, `users.branch_id`,
permission strings like `product.manage` / `sales.create` / `company.update`,
`finance_post_sale` — **do not exist here**, and must not be introduced.

The old `AI_HANDOFF.md` that described that repository has been archived as
`AI_HANDOFF_LEGACY_JMAC_ENTERPRISE.md`. `AI_HANDOFF.md` now describes this
workspace.

---

## A. Current structure

The brief for this restart described `jmac/integrations/{hmrs,pos}`. The real
layout is:

```text
C:\Projects\JMAC\                     <- git repository root
└── INTEGRATION\                      <- currently UNTRACKED by git
    ├── AI_HANDOFF.md                 <- current implementation handoff
    ├── AI_WORKFLOW.md                <- agent workflow and verification rules
    ├── ARCHITECTURE.md               <- this file
    ├── POS_TO_HRMS_MIGRATION_CLAUDE(1).md   <- the authoritative migration plan
    ├── README.md                     <- repository setup and current status
    ├── HRMS\                         <- Harmony Suite HRMS (the parent system)
    ├── POS\                          <- SariSwift standalone POS (reference impl)
    └── FMS\                          <- Next.js finance app, out of scope for now
```

There is no `hmrs/` — the folder is `HRMS/`. There is a third system, `FMS/`,
that the restart brief did not mention.

### Git state — needs attention

```text
439 deleted tracked files   (the old JMAC/HRMS/... layout, incl. JMAC/HRMS/POS/)
  1 untracked directory     (INTEGRATION/)
```

The reorganisation was done on disk without git. POS used to live *inside* HRMS
at `JMAC/HRMS/POS/` (147 tracked files) and was lifted out to
`INTEGRATION/POS/`. Git currently has **no committed copy of the new layout** —
the working tree is the only copy. Committing is the user's call
(`AI_WORKFLOW.md`: agents never commit), but until it happens there is no
restore point for the reorganised tree.

### Toolchain

| | HRMS | POS | FMS |
| --- | --- | --- | --- |
| Framework | React 19 + Vite | React + Vite | Next.js |
| Package manager | npm (`package-lock.json`) | npm (`package-lock.json`, stray `bun.lockb`) | npm |
| Entry | `src/main.tsx` → `src/App.tsx` | `src/main.tsx` → `src/App.tsx` | `src/app` |
| Build | `npm run build` (`tsc -b && vite build`) | `npm run build` (no typecheck; separate `npm run typecheck`) | — |
| Lint | `npm run lint` (**oxlint**) | `npm run lint` (**eslint**) | — |
| Test | `npm test` (vitest) | `npm test` (vitest) | — |
| Supabase project | `harmony-suite` | `sariswift-offline` | own |
| Local API port | `127.0.0.1:55321` | `127.0.0.1:54321` | — |

**Initial audit test baseline (run 2026-08-24):**

- HRMS — `npm test`: **2 files, 34 tests, all pass**
- POS — `npm test`: **9 files, 61 tests, all pass**

Neither project has Playwright or any end-to-end tests. `build` and `lint` were
not run during this audit.

---

## B. HRMS architecture (`INTEGRATION/HRMS`)

Harmony Suite — React 19, TypeScript, Vite, Tailwind v4, Supabase. This is the
parent enterprise system and the identity authority.

### Frontend

```text
src/
├── App.tsx              routes
├── contexts/            AuthContext
├── components/
│   ├── PortalRedirect.tsx
│   ├── ProtectedRoute.tsx
│   └── layout/          DashboardLayout, PosLayout, PosSidebar, Navbar, Sidebar
├── layouts/PublicLayout.tsx
├── lib/                 portals.ts, database.types.ts, supabase client
└── pages/               admin, attendance, auth, deployment, employee-portal,
                         employees, interviews, leave, payroll, pos, public,
                         recruitment, reports
```

### Authentication

Supabase Auth, single login page at `/login`. `AuthContext` loads, in parallel on
every session change: the `profiles` row, `has_pos_access()` and
`my_pos_branches()`. Privileged account creation is done by Edge Functions with
the service-role key — `create-hr-account`, `create-employee-account`,
`reset-employee-password`, `applicant-file` — never from the browser.

`create-employee-account` provisions employee logins with a fixed default
password because the stack runs locally with no reachable mailbox (the value is
in the edge function and in `HRMS/DEMO.md`, deliberately not repeated here); a
later migration
(`20260731130000_employees_must_set_own_password.sql`) forces the employee to
choose their own password before first use.

### Routes and portals

```text
/                       public site (careers, track application)
/login                  the ONLY login page
/auth/setup-password
/home                   PortalRedirect — decides the landing portal
/pos                    PosIndexRedirect: manager → dashboard, cashier → till
                                            (requirePos, blockRoles=['admin'])
/pos/dashboard          PosLayout + PosDashboardPage   manager
/pos/till               PosLayout + PosTillPage        cashier + manager
/pos/stock              PosLayout + PosStockPage       manager
/pos/categories         PosLayout + PosCategoriesPage  manager, read-only
/pos/transactions       PosLayout + PosTransactionsPage
/pos/reports            PosLayout + PosReportsPage     manager
/pos/requests           PosLayout + PosRequestsPage    manager, Inventory tab
/pos/audit-logs         PosLayout + PosAuditLogsPage   manager, POS-operational
/pos/catalogue          → /pos/stock          (retired)
/dashboard/*            DashboardLayout — ~25 HR routes, each role-gated
/dashboard/admin/pos    DashboardLayout + PosTillPage  the SAME till component
/dashboard/admin/pos-transactions
/dashboard/admin/pos-requests
/dashboard/admin/pos-audit-logs
/dashboard/admin/pos-reports      DashboardLayout + AdminPosReportsPage
```

`/home` exists because the login form cannot decide the landing portal: at the
moment the password is accepted the profile and POS queries have not resolved,
so a cashier would be computed into the back office and bounced straight out.
Under `ProtectedRoute` both are loaded before `defaultPortalPath()` runs.

`src/lib/portals.ts` defines three portals — `admin` (`/dashboard`), `pos`
(`/pos`), `employee` (`/dashboard` with its own nav) — with landing priority
`admin → pos → employee`.

The POS portal's path is `/pos`, not a specific screen: its index route
(`PosIndexRedirect`) decides between the till and the manager dashboard, so
`defaultPortalPath()` needs to know nothing about POS roles and there is only
one copy of that test.

**The Administrator holds exactly one portal.** `portalsFor()` returns
`['admin']` for `role === 'admin'` before it looks at POS assignments at all, so
a stray assignment cannot reactivate a workspace switcher for them, and
`blockRoles={['admin']}` on `/pos` turns a typed POS URL into a redirect back to
`/dashboard`. They still run a till — at `/dashboard/admin/pos`, which mounts
the *same* `PosTillPage` inside `DashboardLayout`. There is one checkout
implementation, not two; only the chrome around it differs.

An account that is a Manager at one branch and a Cashier at another is the case
that shapes the model, so POS access is carried as `(branch_id, pos_role)` pairs
(`my_pos_assignments()`), never as a global "is a manager" flag. Manager
navigation appears if the account manages anywhere; *which* branch it may
actually manage is decided per branch by the page and, finally, by the
database.

### Roles

`public.user_role` enum, on `profiles.role`, global and single-valued:

```text
admin · hr_manager · hr_staff · employee
```

`public.pos_role` enum, on `pos_branch_assignments.pos_role`, branch-scoped:

```text
manager · cashier
```

Administrators are **deliberately absent** from `pos_role`. An Administrator's
POS access comes from `profiles.role = 'admin'` and covers every branch;
recording it in the assignment table too would create two places answering the
same question.

Since Phase 9A a third, non-granting layer sits alongside these:
`position_system_roles` records which **job** may hold which system role. It
confers nothing on its own — see D2d. An assignment is refused unless the
holder's position makes them eligible, which is why `profiles.role` must be
`employee` for a POS assignment: `hr_manager` and `hr_staff` are HR identities,
and `admin` needs no entitlement because `is_admin()` short-circuits ahead of
the check.

### Database

**123 migrations, all applied** to the live local database (verified against
`supabase_migrations.schema_migrations`, 2026-08-30). The HR tables:

```text
profiles  employees  employee_history  employee_documents
branches  work_locations  departments  positions  salary_grades
applicants  applications  application_history  job_postings  job_offers
interviews  employment_contracts  deployment_records
attendance_records  work_schedules  leave_types  leave_requests  leave_balances
payroll_periods  payroll_records  payroll_line_items  payslips
generated_reports  audit_logs  change_requests  system_settings
ph_locations  holidays
```

Plus the POS tables added by Phases 2A–7B:

```text
pos_branch_assignments   pos_product_categories   pos_products
pos_branch_products      pos_branch_inventory     pos_inventory_movements
pos_sales                pos_sale_items
```

(The original audit recorded "no product, inventory, sale or transaction tables
in HRMS." That was true on 2026-08-24 and is no longer — Phases 3 to 6 added
them. Nothing was ported from the standalone schema verbatim; see
[F](#f-recommended-integration-architecture) and the migration ledger.)

### POS integration inside HRMS — delivered through Phase 7B

The first slice was `20260813000000_pos_branch_assignments.sql` plus
`20260813010000_pos_helpers_not_callable_by_anon.sql`. The second of those is
still worth reading: the first migration's `revoke ... from public` did **not**
close anon access, because `ALTER DEFAULT PRIVILEGES ... ON ROUTINES TO anon`
(migration `20260716070000`) gives every new function in `public` an explicit
anon grant, and revoking from `PUBLIC` does not remove an explicit grant to a
named role. It was caught with `has_function_privilege()` rather than assumed,
and fixed forward-only. That pattern has recurred four more times since — see
[D2](#d2-postgresql-acl-the-recurring-trap).

Delivered since, all applied and contract-tested:

| Phase | Migrations | Adds |
| --- | --- | --- |
| 2A | `20260813*` | POS access assignment admin |
| 2B | `20260825000000` | branch POS settings, fees, payment QR |
| 2C | `20260825010000` | `created_by` stamped from `auth.uid()` and frozen |
| 3 | `20260825020000`–`050000` | products, global categories, branch catalogue, private image bucket |
| 4 | `20260825060000`, `070000` | branch inventory + movement ledger |
| 5 | `20260825080000`–`100000` | `checkout_pos_sale`, sales, idempotency, receipt helper |
| 6 | `20260825110000`–`130000` | `my_pos_assignments`, the three transaction read paths, `get_sale_detail`, units-not-lines fix |
| 7A | `20260826000000`, `010000` | business-time helpers, manager dashboard, branch category summary |
| 7B | `20260826020000` | database-owned report periods and presets; separate Manager operational and Administrator financial report contracts |

Phase 7B keeps the two report audiences structurally separate. Manager RPCs
return operational totals, trends, payment totals and top products; neither
their typed signatures nor their definitions expose or depend on cost, COGS,
margin, profit, or Administrator report functions. Administrator RPCs may
return COGS, Gross Product Profit and Gross Product Margin %, where:

```text
Gross Product Margin % = ((Product Sales - COGS) / Product Sales) × 100
```

The percentage is `NULL` when Product Sales is zero. Report presets originate
from `pos_business_date()`, daily buckets use `pos_business_timezone()`, date
ranges are half-open and capped at 366 inclusive days, and every sales read
explicitly filters `status = 'completed'`. Payment-method amount collected is
`SUM(total_amount)`. Top Products aggregates by `product_id`, using historical
`line_total` and the most recent in-range product-name snapshot; branch
comparison aggregates by `branch_id`. Final routine ACLs are verified from the
actual PostgreSQL catalogs rather than inferred from migration text.

Frontend: `PortalRedirect`, `PosLayout`, `PosSidebar`, `PosIndexRedirect`,
`portals.ts`, `posAccess` in `AuthContext`, `requirePos` and `blockRoles` in
`ProtectedRoute`, and the pages under `src/pages/pos/` and the POS pages under
`src/pages/admin/`. 403 vitest tests across 28 files.

`PosOverviewPage` and `PosCataloguePage` were **deleted** in Phase 6: the first
described the portal instead of doing anything, and the second's one real
capability — pausing a product at a branch — moved onto Inventory, which already
lists the same products. `/pos/catalogue` redirects to `/pos/stock`.

---

## C. POS architecture (`INTEGRATION/POS`)

SariSwift — React + Vite + TypeScript, Supabase project `sariswift-offline`.
A complete, working, standalone retail POS. ~3,700 lines of pages plus ~1,450
lines of library code.

### Frontend

```text
/auth                 own login page          (Auth.tsx)
/reset-password
/                     Dashboard               admin, manager
/pos                  Till / checkout         admin, manager, cashier   (545 LOC)
/inventory            Products + stock        admin, manager            (455 LOC)
/categories           Category management     admin, manager            (375 LOC)
/transactions         All transactions        admin, manager
/my-transactions      Own transactions        cashier
/reports              Sales/profit reports    admin, manager            (364 LOC)
/staff                Staff management        admin                     (347 LOC)
/payment-qr           Payment QR              admin
/fees                 Additional fees         admin
/audit-logs           Audit log               admin, manager
/branch               Store details           admin
/export               Data export             admin
```

Gating is `<RoleRoute allowed={[...]}>` in the frontend, backed by RLS and
SECURITY DEFINER RPCs in the database.

### Authentication and roles

`src/lib/auth.tsx` — Supabase Auth, then resolves a `store_memberships` row into
`role`, `store`, and a computed `Permissions` object (`canUsePOS`,
`canManageInventory`, `canViewProfit`, `canViewAuditLogs`, …).

```text
public.app_role         admin · owner              (user_roles, legacy)
public.membership_role  admin · manager · cashier  (store_memberships)
public.membership_status active · inactive
```

**POS has no `profiles` table.** Identity is `auth.users` plus
`store_memberships.display_name`. Staff accounts are created by the
`create-staff-user` Edge Function, which calls `auth.admin.createUser` and then
inserts a `store_memberships` row — i.e. **the POS mints its own login
accounts.**

### Stores

`public.stores` — `name`, `owner_id → auth.users`, `currency`, `owner_name`,
`phone`, `address`, `fees jsonb`, `payment_qr_url`. Every operational table is
scoped by `store_id`.

### Database

9 tables across 12 migrations:

```text
user_roles          legacy owner/admin
stores              the tenant boundary
store_memberships   user × store × role × status
products            name, category, category_id, stock, buying_price,
                    selling_price, image_url, is_archived, is_deleted, store_id
product_categories  per-store, ordered, colour/icon, normalized unique name
sales               total_amount, total_profit, payment_method, payment_reference,
                    amount_tendered, fees, subtotal, created_by, checkout_key
sale_items          product_name, quantity, unit_price, unit_profit,
                    line_total, line_profit
inventory_movements full stock ledger
audit_logs          store-scoped, old_values/new_values jsonb
```

`inventory_movements` is the strongest piece of the POS schema:

```text
movement_type ∈ initial_stock, restock, adjustment_in, adjustment_out,
                sale, refund, return, damaged, expired, correction
check (stock_after = stock_before + quantity_change)
foreign key (product_id, store_id) → products(id, store_id)   -- store cannot drift
```

### Authorization helpers (schema `private`, revoked from `public`)

```text
private.has_active_store_role(_store_id, _roles membership_role[]) -> boolean
private.active_store_role(_store_id) -> membership_role
```

### RPCs

```text
secure_checkout(_store_id, _items, _payment_method, _payment_reference,
                _amount_tendered, _checkout_key)   <- the important one
checkout_sale                                       (earlier form)
get_pos_products(_store_id)                         cashier catalogue read path
get_pos_categories(_store_id)
get_pos_store(_store_id)
get_my_transactions(...)                            cashier's own sales
restock_product · adjust_product_stock              the only stock write paths
delete_product_category · reassign_category_products
reassign_category_products_subset · reorder_product_category
```

`secure_checkout` is `SECURITY DEFINER`, `set search_path = ''`, and enforces
server-side: authentication, active membership in the target store, cart size
1–100, no duplicate product ids, valid payment method, cash tender present for
cash, server-side pricing from the `products` row (never the client's price),
and idempotency through `checkout_key` unique per `(store_id, created_by)`.
Profit is withheld from the cashier's response
(`20260730200702_remove_cashier_profit_from_checkout_response.sql`).

**This is the reference implementation to port. Its rules are the deliverable,
not its tables.**

### Tests

9 vitest files, 61 tests: `checkoutAttempt`, `fees`, `receipts`,
`paymentValidation`, `adminApi`, `categoryReassignment`, `storeData`,
`storeRealtime`. All client-side logic — there are no database contract tests.

---

## D. Shared infrastructure

Today, **almost nothing is shared.** That is the core finding.

| Concern | HRMS | POS | Shared? |
| --- | --- | --- | --- |
| Supabase project | `harmony-suite` | `sariswift-offline` | **No — two separate databases** |
| Local API port | 55321 | 54321 | No |
| `auth.users` | own | own | **No — separate user pools** |
| Login page | `/login` | `/auth` | **No** |
| Identity record | `profiles` | `auth.users` + membership | **No** |
| Org unit | `branches` | `stores` | **No** |
| Roles | `user_role` + `pos_role` | `membership_role` | **No** |
| Audit | `audit_logs` (global) | `audit_logs` (store) | Same name, different table |
| UI kit | shadcn/ui + Tailwind | shadcn/ui + Tailwind | Same libraries, duplicated code |

Two Supabase projects means **a POS user account literally cannot see an HRMS
employee.** They are different `auth.users` tables in different Postgres
instances. No RLS policy, view, or foreign key can span them. This is why the
identity model in the restart brief — one person, one login — cannot be reached
by configuration; it requires the POS domain to live in the HRMS database.

What *can* genuinely be shared, and should be:

- **The Supabase project** — `harmony-suite` becomes the single backend.
- **Auth** — one `auth.users`, one `/login`, one session.
- **`profiles`** — the one identity row per person.
- **`branches`** — the one physical-location concept.
- **Authorization helpers** — `is_admin()`, `is_active_staff()`, and the POS
  trio `has_pos_role()` / `has_pos_access()` / `my_pos_branches()`.
- **Audit** — HRMS `audit_logs` extended, rather than a second log.
- **UI primitives** — both use shadcn/ui; HRMS's copy wins.

---

### D2. PostgreSQL ACL — the recurring trap

Migration `20260716070000` installs

```sql
alter default privileges in schema public
  grant all on routines to anon, authenticated, service_role;
alter default privileges in schema public
  grant all on tables   to anon, authenticated, service_role;
```

PostgreSQL *separately* grants `PUBLIC EXECUTE` on every new function. Together
these mean:

> **A `REVOKE` statement in a migration is not evidence that the privilege is
> gone.** Revoking from `PUBLIC` does not remove an explicit grant to a named
> role, and `CREATE OR REPLACE` on an existing function does not reset its ACL.

Five separate incidents have been found and fixed here:

| # | Incident | Fixed by |
| --- | --- | --- |
| 1 | POS helpers (`has_pos_role`, `has_pos_access`, `my_pos_branches`) reachable by `PUBLIC` and `anon` | `20260813010000` |
| 2 | Catalogue RPCs left with the default `PUBLIC EXECUTE` | `20260825030000` |
| 3 | Table-level default DML privileges on a new POS table | `20260825070000` |
| 4 | `pos_sale_receipt` — the internal helper that returns any receipt by id — executable by `authenticated` | `20260825100000` |
| 5 | Routines silently re-granted by the default-privileges rule after `CREATE OR REPLACE` | both revokes re-issued in `20260825130000` |
| 6 | **TRUNCATE granted to `anon` and `authenticated` on 36 tables, including `audit_logs` and `pos_branch_assignments`.** RLS does not filter TRUNCATE -- it is not a row operation, so no policy is consulted. Any authenticated user could wipe the enterprise audit trail or every POS access grant in one statement. | `20260826030000`, which also fixes the **default privileges** so future tables do not inherit it |

Incident 4 is the instructive one: it would have made every receipt in the system
readable by anyone who could guess or observe a `sale_id`, with no policy
anywhere looking wrong.

**Standing rules.**

- Every privileged routine: `SECURITY DEFINER`, `SET search_path = ''`.
- Always issue **both** revokes, then grant explicitly:

  ```sql
  revoke all on function public.f(args) from public, anon;
  grant execute on function public.f(args) to authenticated;
  ```

- Assert the **final catalog state** in a contract test —
  `has_function_privilege('anon', 'public.f(args)', 'execute')` for functions,
  `information_schema.role_table_grants` for tables. Never assert that a REVOKE
  line exists in a file.
- Prefer typed `returns table (...)` over `returns jsonb` for anything a
  cost-safety test must inspect: `pg_get_function_result` can be asserted
  against, a `jsonb` blob cannot.
- Never put a Supabase service-role key in frontend code, and never weaken an
  RLS policy to make a UI work.

---

### D2b. POS operational audit, and why it is not `audit_logs` (Phase 7C)

The enterprise `public.audit_logs` is a single generic table: arbitrary action
text, arbitrary `table_name`, generic `record_id`, and unrestricted
`old_data`/`new_data` JSONB written by five different subsystems. It has no
branch column and no domain discriminator, and one of its writers
(`receive_pos_stock`) already puts `average_unit_cost` into it. Exposing it to a
POS Manager would mean maintaining a safe projection over free-form JSON
forever, and every future writer anywhere in HRMS would become a potential cost
leak into the POS.

It therefore stays Administrator-only and unchanged, with no backfill.
`public.pos_audit_events` is a separate, bounded stream:

```text
pos_audit_event_type   21 values, enum -- no free-text action strings
pos_audit_entity_type   6 values, enum

pos_audit_events
  branch_id               null for enterprise-wide catalogue and access events
  event_type/entity_type  constrained
  actor_id                derived from auth.uid() in the writer, never supplied
  actor_name_snapshot     history survives a rename
  actor_enterprise_role   public.user_role
  actor_pos_role          public.pos_role, the role held AT branch_id, or null
  manager_visible         CHECK-tied to the taxonomy, not writer-supplied
  safe_old_value/new      manager-readable; CHECK-forbidden on admin-only events
  admin_description       administrator-only
  admin_old_value/new     administrator-only
```

Access:

| | table | manager RPC | admin RPC |
| --- | --- | --- | --- |
| anon, authenticated, service_role | no privilege at all | — | — |
| Cashier | denied | denied | denied |
| Manager @ A | denied | branch A, manager-visible events only | denied |
| Manager @ A / Cashier @ B | denied | branch A only | denied |
| Administrator | denied | inherits via `has_pos_role` | all POS, branch or global |

RLS is enabled with **zero policies**, and every table privilege is revoked, so
reads are RPC-only by construction rather than by a policy someone could widen.
The log is append-only: row triggers refuse UPDATE and DELETE, and a statement
trigger refuses TRUNCATE — which RLS would not have stopped (see D2).

**Not audited, deliberately:** ordinary checkout, receiving, adjustment, and all
reads. `pos_sales`, `pos_sale_items` and `pos_inventory_movements` are already
immutable, actor-attributed ledgers; a parallel event would duplicate them and
grow at transaction volume. A low-stock *threshold* change is audited, because
it is configuration rather than movement.

**Storm suppression is structural.** `reorder_pos_category()` rewrites every
category's `sort_order`; `delete_pos_category()` bulk-moves every product in the
category. The row triggers ignore sort-order-only changes and exclude
`category_id` from the product allowlist, and each RPC emits exactly one
aggregate event recording what the bulk operation did. No caller-controlled flag
influences whether an event is written.

Migrations `20260826040000`, `20260826050000`, `20260826060000`.

---

### D2c. POS inventory / product requests (Phase 8)

A branch demand signal, and nothing more.

```text
approved  =  this branch demand is legitimate and may proceed to procurement
approved  ≠  budget approved · vendor selected · purchase authorized · stock received
```

```text
pos_request_type    restock | carry_existing_product
pos_request_status  pending | approved | declined | cancelled

pos_inventory_requests
  branch_id, product_id          both NOT NULL -- deferring new_product buys this
  request_type, requested_quantity, reason
  status
  requested_by / requested_at    auth.uid(), never client-supplied
  reviewed_by / reviewed_at / review_note      GENERIC -- name no authority
  *_name_snapshot                history survives every rename
```

**Two decisions, two owners.** `restock` is reviewed by an Administrator *today
only*: it is ultimately a procurement decision — what to buy, from whom, against
which budget — and belongs to FMS. `carry_existing_product` is reviewed by an
Administrator *permanently*: an enterprise catalogue and branch-carrying
decision with no money in it.

`can_review_pos_request(request_type)` is the **only** place either is decided.
Both branches read `is_admin()` today and look identical; one is a placeholder
with a shelf life and the other is the end state, and the function says which is
which. FMS integration replaces one function body.

The row records no authority — no `review_authority`, no `admin_approved_by`, no
`fms_approved_by`. When FMS integrates, the link is an explicit bridge (an FMS
request reference or a bridge table), never an extra column on the reviewer
fields.

**Why it does not compete with FMS.** `INTEGRATION/FMS` already owns `requests`,
`request_approvals`, `vendors`, `budgets`, `payments` and `journal_entries`. Its
request carries `amount`, `vendor_id`, `budget_id`, `category_id` and
`payment_schedule` through `pending_finance_staff → pending_finance_manager →
pending_accountant → completed`. That answers *"may we spend this money"*. This
table answers *"is this branch short of stock"*. Different question, different
approver, different lifecycle — and they stay separate only while this table has
**no procurement columns**, which `pos_requests_rls.sql` asserts on every run.

**Approval moves no stock.** The intended flow:

```text
POS Manager request  →  review  →  [future FMS procurement]  →  receive_pos_stock()
                                                                        ↓
                                                            pos_inventory_movements
```

A carry approval creates `pos_branch_products` with `is_available = false`; the
existing `trg_create_branch_inventory` makes the inventory row at zero, and the
Phase 7C trigger emits `branch_product_added`. A restock approval creates
nothing at all.

**Deliberately absent:** `new_product` (a manager proposing enterprise taxonomy
and pricing, which Phase 3 made Administrator-only), and `fulfilled` (nothing
could set it truthfully without a receiving link). Duplicates are blocked only
while `pending` — with no `fulfilled` state, an approved request would otherwise
block that branch/product pair forever.

Concurrency follows `approve_change_request`: `SELECT ... FOR UPDATE` plus
`WHERE status = 'pending'`, so exactly one terminal transition wins. Nobody may
review their own request.

Migrations `20260827000000` / `000100` / `010000` / `020000` / `030000`.

---

### D2d. Workforce eligibility — your job decides your systems (Phase 9A)

The defect that prompted this phase was live in the working database:
**Jerome Castillo, Department IT, Position IT Support, held POS Manager.**
Nothing was broken — the screen did exactly what it was asked. There was simply
no rule saying an assignment must correspond to the job the person actually
holds.

(Production carries the schema and two branches but no workforce yet — no
employees, profiles or assignments — so the violation exists only in the local
database. It is nonetheless a real defect in the *authorization model*, and it
would have reproduced the moment production was populated.)

```text
Human Resources        Store Operations       IT
├── HR Manager         ├── POS Manager        └── IT Support
└── HR Staff           └── Cashier
```

**Three layers, still separate.** Phase 9A adds a layer; it collapses nothing.

```text
profiles.role                    enterprise / HR identity   admin | employee
pos_branch_assignments.pos_role  the actual authorization   manager | cashier
position_system_roles            eligibility only           -- NEW
```

`position_system_roles` never grants anything. It answers one question — *may
this job hold that role at all* — and an Administrator must still make the
assignment. Eligibility is a precondition, not a grant.

```text
position_system_roles
  position_id → positions(id) on delete cascade
  system       entitlement_system   hrms | pos | fms
  role_code    text                 CHECK-constrained per system
  unique (position_id, system, role_code)
```

`'admin'` and `'employee'` are **deliberately absent** from every branch of that
CHECK. Administrator is an enterprise identity, not something a job title
confers, and Employee Self-Service is the baseline every employee already has —
making either an entitlement would invite a position to grant it.

**Eligibility is a conjunction, and every term is load-bearing:**

```sql
is_eligible_for_system_role(profile, system, role) =
     profile.status = 'active'
 and profile.role   = 'employee'          -- an Administrator needs no entitlement
 and employment_permits_operational_work(employee.employment_status)
 and employee.department_id is not null
 and position.department_id = employee.department_id   -- the pairing must hold
 and (position, system, role) ∈ position_system_roles
```

`employment_permits_operational_work()` exists as its own function so that
"which employment statuses may work a till" is a single named decision rather
than a predicate copied into five places. Today it is `status = 'active'`.

**Three gates, because one is not enough.**

```text
write   pos_assignment_requires_eligibility   BEFORE INSERT/UPDATE   POS_ASSIGNMENT_NOT_ELIGIBLE
read    has_pos_role / my_pos_assignments /   every authorization    an ineligible holder is
        has_pos_access                        check                  refused live
drift   revoke_ineligible_pos_assignments     AFTER UPDATE on        status='inactive',
                                              employees              revoked_reason='workforce_ineligible'
```

The write gate alone would leave every pre-existing grant intact and working.
The read gate alone would let invalid rows accumulate. The drift trigger alone
would not stop a bad grant being made in the first place. `is_admin()` still
short-circuits the read path — an Administrator's access does not come from a
position.

**The drift trigger only ever closes.** It sets `status = 'inactive'`; no branch
sets `active`. Transferring an employee *back* into an eligible position does
not resurrect their old assignment — an Administrator must grant it again,
deliberately. `no_assignment_resurrection` enforces the other half: reopening a
closed row raises `POS_ASSIGNMENT_CLOSED`. Access that returns by itself, days
later, as a side effect of an HR edit, is not access anyone authorized.

**History is preserved, and the audit trail does not lie.** Nothing is deleted.
`revoked_reason` records *why* a row closed, and `pos_audit_assignment()` reads
it to say "POS access closed automatically: the employee is no longer eligible
for this role" — attributed to no actor, because no person did it. Inventing a
revoking Administrator would have been the easier implementation and a false
record.

**Department/position integrity underpins all of it.** Eligibility is meaningless
if an employee can hold a position belonging to another department, so
`enforce_position_department_pairing()` guards `employees` and `job_postings`
(`POSITION_DEPARTMENT_MISMATCH`), and `guard_position_department_move()` stops a
position being moved out from under its holders (`POSITION_DEPARTMENT_IN_USE`).
Null semantics are preserved throughout: the check fires only when both sides
are present, so an employee with no position assigned yet is still valid.

**The picker is a convenience, not a control.** `get_eligible_pos_employees()`
returns identity and org placement only — no salary, no pay grade, no personal
data — and a contract test pins that signature, because an assignment screen is
not a reason to widen access to payroll. The list is filtered in the database; a
candidate list filtered in React is a candidate list that can be unfiltered in
React, and the write gate refuses regardless of what the client sends.

**Existing violations were not quietly rewritten.**
`get_noncompliant_pos_assignments()` surfaces every active assignment whose
holder is no longer eligible, with the reason, on the POS Access page. The
alternative — editing Jerome's department to make his assignment valid — would
have falsified an employment record to protect an access grant. Real employees
keep their real jobs; the invalid *assignment* is what an Administrator
resolves.

**Scope.** Phase 9A enforces **POS only**. HRMS and FMS entitlements are
configurable and displayed read-only, so the model is legible, but nothing reads
them yet — 9B and 9C. `ENFORCED_SYSTEMS = ['pos']` is the single client-side
statement of that, and it is asserted by test rather than left as a comment.

Migrations `20260828000000` / `010000` / `020000` / `030000` / `040000` /
`050000` / `060000`. Contract suite `workforce_eligibility_rls.sql` (35 checks).

---

### D3. FMS boundary

FMS integration has **not** begun. The boundary is defined now so POS does not
grow into it.

**POS owns and produces** the operational facts FMS will consume: sales, sale
items, payment method and reference, customer-paid fees, inventory movements,
unit-cost snapshots and COGS-ready figures.

**FMS will own** suppliers, purchase requests and their approval, purchase
orders, supplier invoices and payments, accounts payable, purchase-cost
accounting, cash and bank outflows, journal entries, operating expenses, payment
reconciliation, and final financial profit.

Two rules:

1. Do not build any FMS concern into POS prematurely.
2. When FMS eventually triggers receiving, it must write through the **same**
   `pos_inventory_movements` ledger and the same `receive_pos_stock()` path — not
   a second stock system. One ledger, one balance.

Customer-paid POS fees are reported as a separate fact (`fees_total`) and are
deliberately **not** folded into any profit figure until FMS settles their
accounting classification.

---

## E. Conflicts and duplicate concepts

### E1. `stores` vs `branches` — the same business concept, different owners

Not an assumption — the evidence:

- HRMS seeds `branches` with *Main Office* and *Cavite Branch*, each with an
  address, and `work_locations` under Cavite Branch include "Cavite Store" and
  "Cavite Warehouse".
- POS `stores` carries `name`, `address`, `phone`, `owner_name` — a physical
  retail site.
- The POS's own UI route for editing a store is `/branch`, titled
  `BranchDetails.tsx`. The POS already calls its store a branch.

They are the same thing. `branches` is the better home: it already exists in the
identity system, it is already referenced by `deployment_records`, and POS staff
are already assigned to it.

`stores` carries three things `branches` lacks — `currency`, `fees jsonb`, and
`payment_qr_url`. `currency` is already settled in HRMS
(`20260731070000_fixed_currency.sql` fixes it to PHP), so only fees and the
payment QR need a home on the branch side.

`stores.owner_id` has **no equivalent and needs none.** In HRMS a branch is not
owned by a user; authority comes from `profiles.role` and
`pos_branch_assignments`.

### E2. `store_memberships` vs `pos_branch_assignments` — same shape, different identity

```text
POS      auth.users ─→ store_memberships ─→ stores          role: admin|manager|cashier
HRMS     profiles   ─→ pos_branch_assignments ─→ branches   role: manager|cashier
```

Structurally near-identical: both are (person × place × role × active/inactive)
with a uniqueness constraint. Three real differences:

1. **Subject.** POS points at `auth.users`; HRMS points at `profiles`. HRMS is
   right — `profiles` is the row that knows the person is an employee.
2. **`admin`.** POS has a per-store `admin` membership role. HRMS deliberately
   omits it, because an Administrator is global. **This is the one substantive
   semantic conflict**, and it is not cosmetic: every POS RLS policy and RPC
   that says `array['admin','manager']` has to be re-expressed. The HRMS
   equivalent of POS-`admin` is `is_admin()` OR `pos_role = 'manager'`,
   depending on the operation — each policy must be decided individually, not
   mapped mechanically.
3. **Uniqueness.** POS: `unique (store_id, user_id)` — one membership ever.
   HRMS: partial unique index on `(profile_id, branch_id) where status =
   'active'` — revoked assignments survive as history and access can be
   re-granted. HRMS's is better and should stand.

### E3. Two identity systems minting logins for the same people

POS `create-staff-user` creates an `auth.users` row and a membership. HRMS
`create-employee-account` creates an `auth.users` row and a `profiles` row
linked to an `employees` row. Run both for one person and you get exactly the
outcome the brief forbids:

```text
john@company.com           (HRMS employee, harmony-suite)
cashier.john@company.com   (POS cashier,   sariswift-offline)
```

POS staff creation must not survive integration. Granting POS access has to
become an *assignment on an existing profile*, not an account creation.

### E4. `audit_logs` collision

Both databases have `public.audit_logs` with different columns — POS's is
`store_id`-scoped with `old_values`/`new_values` jsonb; HRMS's is the global HR
audit table. When POS moves into `harmony-suite` the names collide. HRMS's table
is the survivor; POS's store-scoped triggers (`private.audit_product_change`,
`private.audit_store_change`) get re-pointed at it with `branch_id`.

### E5. Documentation vs reality

- `AI_HANDOFF.md` documents `C:\Projects\JMAC Enterprise`, not this workspace
  (section 0). Its "POS complete across all four slices" is **not** a statement
  about this codebase.
- `AI_WORKFLOW.md` references `integration/hrms`, `integration/pos` and a shared
  `src` — the `JMAC Enterprise` layout, not this one.
- `README.md` is two lines and says only "HRMS".
- `HRMS/PROJECT_CONTEXT.md` lists Recruitment, Attendance, Payroll, Reports as
  *Remaining*. All four are built and have migrations. It is stale.
- The restart brief's `jmac/integrations/{hmrs,pos}` layout does not exist, and
  the brief does not mention `FMS/`, which does.

`POS_TO_HRMS_MIGRATION_CLAUDE(1).md` is the **one document that matches reality**
and should be treated as the authoritative plan.

### E6. Divergence risk between the two repos

`C:\Projects\JMAC Enterprise` still contains a working four-slice POS
integration. It is a genuinely useful reference for this effort — but it is
built on a different identity model (`users` + permission strings, with
`store_memberships` as a *view*), so its code cannot be lifted directly into
`harmony-suite`, which uses `profiles` + a role enum. Read it for the UI and the
sequencing; do not copy its authorization.

---

## F. Recommended integration architecture

### Which model becomes authoritative

**HRMS (`harmony-suite`) is the system of record. POS becomes a portal inside
it.** This is what `POS_TO_HRMS_MIGRATION_CLAUDE(1).md` specifies, it is what
slice 1 already implements, and it is the only model that satisfies "one real
employee = one authentication identity" — because that identity has to live in
one `auth.users`, and HRMS's is the one that knows about employees.

```text
                        Supabase: harmony-suite
                                  │
                             auth.users
                                  │
                              profiles ──── employees
                                  │
              ┌───────────────────┼───────────────────┐
              │                   │                   │
      profiles.role       pos_branch_assignments   (future FMS)
      admin/hr_manager     branch × manager|cashier
      hr_staff/employee            │
              │                    │
        /dashboard/*             /pos/*
        HR Workspace         Point of Sale
                                   │
                                branches  <- one place concept
                                   │
                    products · categories · inventory_movements
                    sales · sale_items · (all branch_id-scoped)
```

### The resolutions

| Conflict | Resolution |
| --- | --- |
| `stores` vs `branches` | **`branches` wins.** Add the POS-specific columns (`fees jsonb`, `payment_qr_url`) to `branches` or to a `branch_pos_settings` side table. Do not create `stores` in `harmony-suite`. |
| `store_memberships` vs `pos_branch_assignments` | **`pos_branch_assignments` wins** — it already exists, is RLS-protected, and is verified live. |
| POS `admin` role | Does not migrate as a role. Re-express each policy as `is_admin() or has_pos_role(branch, ...)`, deciding per operation. |
| POS login page | Deleted. `/login` is the only login. |
| POS staff creation | Replaced by an admin screen that writes `pos_branch_assignments` for an existing profile. |
| POS `audit_logs` | Merged into HRMS `audit_logs`, re-scoped `store_id → branch_id`. |
| POS RPCs | **Ported, not rewritten.** `secure_checkout` keeps its logic, validation and idempotency; `_store_id` becomes `_branch_id` and the membership lookup becomes `has_pos_role()`. |
| POS product/inventory/sales tables | Recreated in `harmony-suite` with `branch_id` in place of `store_id`, preserving every check constraint — especially the `inventory_movements` stock-math check. |
| `INTEGRATION/POS/` | **Kept, untouched, as the reference implementation.** Not deleted, not the runtime target. |

### The honest statement about "do not rebuild"

The restart brief says do not rebuild existing POS functionality, and that is
right about *behaviour*. But the two systems are in **two separate Postgres
databases**, so the POS tables cannot simply be pointed at HRMS identity — there
is no cross-database foreign key to `auth.users`. The work is therefore:

```text
port the schema (store_id -> branch_id, same constraints)
port the RPCs   (same logic, membership check swapped for has_pos_role)
port the UI     (same screens, HRMS layout/design system)
```

That is migration, not a rewrite. Every business rule, constraint, validation
and RPC body comes from `INTEGRATION/POS`. What changes is the scoping column,
the authorization predicate, and the identity table. **Nothing is redesigned
from scratch, and the standalone POS keeps running until its replacement is
verified.**

---

## G. Proposed phased plan

Slice 1 is done and verified. The remaining phases follow
`POS_TO_HRMS_MIGRATION_CLAUDE(1).md`, adjusted for what this audit found.

```text
[DONE] PHASE 1  Portal, routing, unified login, branch access control
                Verified in code and in the live database.

[DONE] PHASE 2A POS Access Assignment Administration
                Administrator-only screen at /dashboard/admin/pos-access for
                granting, revoking and re-granting pos_branch_assignments on
                existing profiles. No migration: the schema and RLS already
                supported all of it, proven by supabase/tests/pos_access_rls.sql.
                Closes the two-accounts-per-person problem.

[DONE] PHASE 2B Branch as the POS place
                branches.phone + branch_pos_settings (fees jsonb, payment
                qr path), a private pos-payment-qr bucket reached by signed
                URL, RLS (POS staff read their own branch, admin writes), and
                an Administrator-only POS Settings screen. `stores` is not
                needed when the operational tables arrive.
                Migration 20260825000000_branch_pos_settings.sql.

[DONE] PHASE 2C Audit integrity: pos_branch_assignments.created_by is stamped
                with auth.uid() on insert and frozen on update.
                Migration 20260825010000.

[DONE] PHASE 3  Products and categories
                Enterprise product master (pos_products) + global taxonomy
                (pos_product_categories) + branch catalogue
                (pos_branch_products), NOT one product row per branch.
                Catalogue served by SECURITY DEFINER RPCs that declare no cost
                column; tables are Administrator-only. Private
                pos-product-images bucket with batched signed URLs.
                No stock column -- inventory is Phase 4's, with its ledger.
                Migrations 20260825020000 / 030000 / 040000 / 050000.

[DONE] PHASE 4  Inventory and stock movements
                pos_branch_inventory (quantity, low-stock level, branch
                weighted-average cost) + pos_inventory_movements ledger,
                introduced together. Balance moves only through
                receive_pos_stock / adjust_pos_stock (Administrator-only),
                guarded by a trigger and row-locked with SELECT ... FOR UPDATE.
                Receiving never touches pos_products.default_unit_cost.
                Migrations 20260825060000 / 070000.
                The standalone's restock_product / adjust_product_stock and its
                trigger against direct products.stock writes became
                receive_pos_stock / adjust_pos_stock and
                guard_pos_inventory_write over the branch balance.
                Inventory rows are created at zero by trg_create_branch_inventory
                when a branch starts carrying a product.

[DONE] PHASE 5  Till / checkout
                pos_sales + pos_sale_items + checkout_pos_sale: one atomic RPC
                that derives price, fees, cost, totals and the cashier itself.
                Durable idempotency (advisory lock + UNIQUE + SHA-256 request
                fingerprint computed in the database). Receipt built from
                receipt-safe fields only -- no cost for anyone, admin included.
                Migrations 20260825080000 / 090000 / 100000.
                Port secure_checkout: server-side pricing, cart limits, idempotent
                checkout_key, no profit in the cashier response.

[DONE] PHASE 6  Transactions and receipts
                Three list RPCs over the Phase 5 sales, each with an explicit
                receipt-safe column list, so there is no cost-bearing row to
                strip keys from:
                  get_my_transactions      the caller's OWN sales, and it takes
                                           no cashier parameter at all, so "show
                                           me someone else's" cannot be
                                           expressed. This settles the open item
                                           flagged at the end of the older
                                           effort's slice 3: the POS's own sales
                                           SELECT policy admits admin/manager
                                           only, so a cashier's history needs an
                                           RPC read path.
                  get_branch_transactions  every cashier at a branch the caller
                                           MANAGES. Per branch, so Manager@A
                                           grants nothing at B.
                  get_admin_transactions   everything, still receipt-safe.
                get_sale_detail authorises by who is asking, never by whether
                they hold the id, and answers a missing id and a forbidden one
                identically so a probe learns nothing. pos_page_size clamps every
                limit to 1..100. item_count is UNITS sold, not lines.
                Migrations 20260825110000 / 120000 / 130000.

[DONE] PHASE 7A POS Manager dashboard + read-only Categories
                Three typed aggregate RPCs (get_pos_dashboard_summary /
                _payment_totals / _top_products) plus reuse of Phase 6's
                get_branch_transactions for recent sales -- typed, not jsonb,
                so "declares no cost column" stays a checkable claim.
                Money is named honestly: Sales Collected = Product Sales +
                Customer Fees. The standalone called subtotal "Net Sales" and
                never showed what the customer paid.
                "Today" is pos_day_bounds() in Asia/Manila, half-open, decided
                in the database -- the standalone used startOfDay(new Date()).
                items_sold sums quantity; top products group by product_id so a
                rename cannot split one product, and value from line_total
                snapshots so re-pricing cannot rewrite history.
                Low stock and out of stock are disjoint; the shipped
                is_low_stock contract is untouched.
                get_branch_category_summary is read-only: categories stay a
                global taxonomy under a single is_admin() policy. The standalone
                gave managers create/rename/archive/reorder and a bulk
                product-move picker; none of it is ported.
                /pos landing is role-aware via PosIndexRedirect.
                Migrations 20260826000000 / 010000.

 [DONE] PHASE 7B Reports
                Database-owned presets and report bounds; Asia/Manila daily
                buckets; explicit completed-sale predicates and a 366-day cap.
                /pos/reports uses four operational, cost-safe Manager RPCs.
                /dashboard/admin/pos-reports uses three dedicated financial
                Administrator RPCs. Product and branch rankings use stable IDs;
                historical snapshots preserve names and sales value.
                Migration 20260826020000.

[DONE] PHASE 7C POS operational audit logs   (see D2b)
                The enterprise HRMS audit and a branch's operational POS audit
                are different things. A POS Manager does not inherit the former
                because the standalone POS had an Audit Logs menu.

[DONE] PHASE 8  Inventory / product requests
                pos_inventory_requests: restock and carry_existing_product.
                Approval means the demand may proceed to procurement -- never
                that budget, vendor, purchase or stock are settled. No
                procurement columns, asserted on every test run. See D2c.
                new_product and a fulfilled status deferred.
                Migrations 20260827000000 / 000100 / 010000 / 020000 / 030000.

       PHASE 9  Merge POS audit into HRMS audit_logs; full security review;
                cross-branch denial testing.
```

Phases 2–8 each end with: migration applied forward-only, tests, and a handoff
note. FMS stays out of scope.

### Testing architecture

HRMS has ten transaction-rolled-back SQL contract suites (329 checks), plus
unit/component coverage, build, lint, inventory and checkout concurrency
harnesses, and role-based browser verification. Database-sensitive phases must
continue to verify the RLS/ACL matrix directly rather than infer it from client
tests or migration statements. Roles to cover include:

```text
admin · hr_staff · hr_manager · employee
POS manager · POS cashier
no assignment · inactive assignment · inactive profile
wrong branch · direct PostgREST access
```

Browser verification must be labelled as such and only claimed when actually
performed.

---

## H. Known problems and next step

1. ~~**The reorganised tree is not in git.**~~ **RESOLVED.** `INTEGRATION/` is
   committed and pushed to `origin/main`; there is a restore point.
2. **`HRMS/PROJECT_CONTEXT.md` is stale** — lists built modules as remaining.
3. **`supabase_vector_harmony-suite` is restart-looping.** Logging/analytics
   only; it does not affect Postgres, auth or the API, but it is noise.
4. **`POS/bun.lockb` alongside `package-lock.json`** — two lockfiles, one
   package manager. Minor, but worth removing.
5. ~~**`supabase gen types typescript` overwrites hand-written aliases.**~~
   **RESOLVED 2026-08-25.** The friendly enum aliases moved to
   `src/lib/enums.ts`, an application-owned module the generator cannot reach.
   Regenerating is now `npx supabase gen types typescript --local >
   src/lib/database.types.ts` followed by a typecheck, with nothing to restore;
   `database.types.ts` is purely generated and must not be hand-edited. A new
   enum gets one `export type X = Enums<'x'>` line in `enums.ts` — never a
   hand-written string union, which would go on compiling after the database
   changed underneath it. The same cleanup removed 7 aliases nothing imported
   and converted three hand-written unions of database enums to
   `Enums<'…'>`-derived types.
6. **Deleting a storage object cannot be tested from SQL.**
   `storage.protect_objects_delete` is a statement-level trigger that refuses
   any direct `DELETE` on `storage.objects` and directs the caller to the
   Storage API. The QR contract test therefore asserts that the only DELETE
   policy on the bucket requires `is_admin()`, and the end-to-end delete is
   covered by browser verification instead.

### The reporting boundary (settled and enforced in Phase 7B)

A permanent distinction, recorded here so a later phase cannot quietly reverse
the security decisions of Phases 3–7A:

```text
Administrator financial reporting
  may access cost / COGS / gross product profit / margins where explicitly
  designed

POS Manager operational reporting
  own branch only — NO cost, NO COGS, NO margin, NO profit

Cashier
  no Reports module at all
```

"Reports is where cost belongs" is a statement about the *Administrator's*
reports. It has never applied to a POS Manager, whose reporting is operational.
The standalone POS did the opposite — `canViewProfit` was `isAdmin || isManager`
and "Today's Net Profit" was the second card on a manager's first screen — so
this is the one place a port would most plausibly go wrong.

### Next step

**None approved.** Phase 9A is complete and released; the candidates and their
scoping notes are in `AI_HANDOFF.md` §13. The two named successors are **9B**
(HRMS role eligibility — making `hr_manager` / `hr_staff` follow from a position
the same way POS now does) and **9C** (FMS, once that integration begins).
Neither is started. One item is outstanding from 9A and is an Administrator
decision, not a code change: the two live assignments the compliance panel now
reports — Jerome Castillo (IT Support / POS Manager) and Liza Fernandez (Sales
Associate / Cashier) — are refused access but still on file, and must be either
revoked or replaced by moving those employees into eligible positions. The nearest is an **Enterprise Audit Cleanup** to
remove the legacy generic `audit_logs` writes still made by `checkout_pos_sale`,
`receive_pos_stock` and `adjust_pos_stock` — with `checkout_pos_sale` left alone
unless it is being changed for another reason, because re-emitting 293 lines of
proven concurrency-critical code to delete six lines of audit insert is a
disproportionate risk for a cosmetic gain.

Phases 2A through 9A — plus the navigation revision — are complete: HRMS 516
tests pass across 35 files, typecheck, build and lint are clean, eleven database
contract suites pass (18 + 42 + 33 + 33 + 36 + 41 + 47 + 19 + 34 + 26 + 35 = 364
checks), both concurrency harnesses pass and leave no residue, the standalone
POS regression remains 61 tests, and Phase 9A browser verification passed 18/18
checks. Phase 7C's browser pass (26/26) ran with every context in
`America/New_York`, a non-Manila timezone, so a browser-computed day boundary
would have shown up.
