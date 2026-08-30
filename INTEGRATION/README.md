# Harmony Suite / JMAC

The main enterprise system for JMAC — one identity, one login, one source of
truth for people and branches, with business subsystems built inside it.

```text
Harmony Suite / JMAC   (parent enterprise system)
├── HRMS   recruitment → payroll, plus the employee self-service portal
├── POS    point of sale, run per branch          ← being integrated
└── FMS    finance                                ← not started
```

POS and FMS are **subsystems**, not separate products with their own logins.
Authentication, `profiles`, `employees`, `branches` and all role assignment live
in HRMS/JMAC.

## Repository layout

```text
INTEGRATION/
├── HRMS/    the application. This is the only tree you develop in.
├── POS/     standalone SariSwift POS — READ-ONLY REFERENCE
├── FMS/     standalone finance system — READ-ONLY REFERENCE
└── *.md     handoff, architecture, workflow and migration documents
```

`POS/` and `FMS/` are kept so their behaviour can be read while it is ported.
They are not built, deployed or modified.

## Tech stack

React 19 · TypeScript · Vite · Tailwind CSS v4 · TanStack Query & Table ·
React Router · React Hook Form + Zod · hand-authored shadcn/ui components ·
Supabase (Postgres, Auth, Storage, RLS) · vitest · oxlint

## Local setup

```bash
cd INTEGRATION/HRMS
npm install
npx supabase start     # local stack "harmony-suite" — API :55321, DB :55322
npm run dev            # http://localhost:5173
```

`.env` needs `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` — see
`.env.example`. The **anon** key only; a service-role key must never appear in
frontend code or in this repository's environment files.

Demo accounts and their passwords are listed in `HRMS/DEMO.md`.

## Running the checks

```bash
npm test          # vitest        — 516 tests across 35 files
npm run build     # tsc -b && vite build
npm run lint      # oxlint
```

Database contract tests (each runs in one transaction and rolls back):

```bash
docker exec -i supabase_db_harmony-suite psql -U postgres -d postgres \
  -v ON_ERROR_STOP=1 -f - < supabase/tests/pos_requests_rls.sql
```

There are eleven such suites in `HRMS/supabase/tests/` (364 contract checks),
plus two concurrency harnesses in `HRMS/scripts/`. `AI_WORKFLOW.md` §5 has the
full sequence.

Production: **https://jmac-enterprise.vercel.app** — auto-deploys `main` from
this repository (Root Directory `INTEGRATION/HRMS`), against the hosted Supabase
project `JMAC-Enterprise`.

## Integration status

| Area | State |
|---|---|
| HRMS core modules | built |
| POS access control, branch settings, fees, payment QR | done |
| POS products, categories, inventory, stock movements | done |
| POS till, atomic checkout, sales | done |
| POS transactions and receipt reprints | done |
| POS Manager dashboard and read-only Categories | done (Phase 7A) |
| POS Reports — Manager operational and Administrator financial | done (Phase 7B) |
| POS operational audit logs | done (Phase 7C) |
| POS inventory / product requests | done (Phase 8) |
| Workforce role eligibility — POS | done (Phase 9A) |
| Workforce role eligibility — HRMS (9B) and FMS (9C) | not started |
| **Next phase** | **none approved — see `AI_HANDOFF.md` §13** |
| FMS integration | not started |

Since Phase 9A a POS assignment is refused unless the employee's **job** makes
them eligible: `position_system_roles` records which position may hold which
system role, and the database enforces it on write, on every read, and again
whenever an employee is transferred. Administrators configure this on
`/dashboard/admin/positions` ("System access"), and any existing assignment that
no longer authorizes is listed with its reason on `/dashboard/admin/pos-access`.
Nothing is deleted and no employee record is rewritten to preserve access —
see `ARCHITECTURE.md` §D2d.

Managers open Reports at `/pos/reports` and the POS audit log at
`/pos/audit-logs`; Administrators use the distinct
`/dashboard/admin/pos-reports` and `/dashboard/admin/pos-audit-logs` routes.
Cashiers have neither module.

**Migrations applied: 116.** Migrations are forward-only; an applied migration is
never edited.

## Documents

Read them in this order:

- **`AI_HANDOFF.md`** — start here. Current status, architecture summary, routes,
  permission model, test state, known problems, non-negotiable decisions, and
  the exact next task.
- **`ARCHITECTURE.md`** — the durable technical reference: identity, portals,
  the POS data model, checkout, transactions, the financial visibility boundary,
  RLS and ACL principles, FMS boundaries.
- **`AI_WORKFLOW.md`** — how to work here: phase discipline, migration rules,
  the verification sequence, the clean test baseline, git rules.
- **`POS_TO_HRMS_MIGRATION_CLAUDE(1).md`** — the phase-by-phase migration ledger,
  including where the integrated design deliberately diverges from the
  standalone POS, and why.

`AI_HANDOFF_LEGACY_JMAC_ENTERPRISE.md` is archived history from a *different*
repository and does not describe this workspace.

## Ground rules

- HRMS/JMAC is the parent system. No separate POS or FMS authentication.
- Cost, COGS, margin and profit are never exposed to POS Managers or Cashiers.
- Prices, fees and cost are derived server-side at checkout, never trusted from
  the client.
- Migrations are forward-only.
- No Supabase service-role key in frontend code.
- Trusted audit data is written by the database, never by the browser.
- Approving a stock request never changes inventory. Quantity moves only
  through controlled receiving, which writes the movement ledger.
- Procurement — suppliers, budgets, purchase orders, payments — belongs to FMS
  and must not be built into POS.
- Do not modify `INTEGRATION/POS` or `INTEGRATION/FMS`.
