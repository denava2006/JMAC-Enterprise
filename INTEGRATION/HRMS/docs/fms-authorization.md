# Finance authorization — the role matrix

Who may do what in the Finance Management System, per module. This document is
written **before** the mutations it describes, so that the policies implement a
decision rather than the decision being read back out of whatever the policies
happened to allow.

Every cell here is enforced in the database. Navigation hides what a person
cannot do; it is never what stops them.

## The four actors

| Role | What the role is for |
| --- | --- |
| **Finance Staff** | Prepares and validates. Meets suppliers, keeps the vendor list and the expense taxonomy current, draws allocations against a ceiling somebody else set. |
| **Finance Manager** | Budget authority. Sets and closes ceilings, and owns the taxonomy decisions that change how history reads. |
| **Accountant** | Owns the ledger. The chart of accounts is their instrument; nobody else edits it. |
| **Administrator** | Enterprise, security and configuration authority. Explicit read for oversight. **No routine amount-setting anywhere.** |

Everyone else — employees, HR staff, POS staff, `anon` — has no access to any
Finance table. Finance access is finance access; holding it grants no HR data
and no till, and holding HR or POS grants no Finance.

## The matrix

Legend: **R** read · **C** create · **E** edit · **A** archive / close.
A blank cell is a denial enforced by RLS, not an omission.

### `finance_categories` — the expense and income taxonomy

| | Read | Create | Edit | Archive |
| --- | :-: | :-: | :-: | :-: |
| Finance Staff | R | C | E | |
| Finance Manager | R | C | E | A |
| Accountant | R | | | |
| Administrator | R | | | |

Archiving a category changes how past classifications read, so it is a Manager
decision. The Accountant reads the taxonomy to post against it and does not
shape it.

### `vendors` — suppliers

| | Read | Create | Edit | Archive |
| --- | :-: | :-: | :-: | :-: |
| Finance Staff | R | C | E | |
| Finance Manager | R | C | E | A |
| Accountant | R | | | |
| Administrator | R | | | |

Finance Staff meet the suppliers and check their documents, so they maintain the
list. Retiring a supplier the company has transacted with is a Manager decision.

### `vendor_categories` — what each vendor supplies

| | Read | Create | Edit | Archive |
| --- | :-: | :-: | :-: | :-: |
| Finance Staff | R | C | — | A |
| Finance Manager | R | C | — | A |
| Accountant | R | | | |
| Administrator | R | | | |

A link row has nothing to edit: it exists or it does not, so create and remove
are the only operations. This is the standalone vendor/category relationship,
preserved because it is what lets a later request form offer only the suppliers
that serve the category being charged.

### `finance_accounts` — the chart of accounts

| | Read | Create | Edit | Archive |
| --- | :-: | :-: | :-: | :-: |
| Finance Staff | R | | | |
| Finance Manager | R | | | |
| Accountant | R | C | E | A |
| Administrator | R | | | |

Deliberately the narrowest module. Opening a bank account is a management
decision; *recording* it in the chart is accounting, and the person who posts to
an account should not also be able to invent one silently — so the chart has a
single owner and every other role reads it.

### `budgets` — approved ceilings

| | Read | Create | Edit | Archive |
| --- | :-: | :-: | :-: | :-: |
| Finance Staff | R | | | |
| Finance Manager | R | C | E | A |
| Accountant | R | | | |
| Administrator | R | | | |

This is the rule the standalone system got wrong. Its `rbac.ts` reads:

```
canManageBudgets   -> finance_manager, administrator
canAllocateBudget  -> finance_manager, finance_staff, administrator
```

and its RLS grants `has_role('administrator', ...)` write access on every
finance table. The Administrator is not a finance officer in JMAC, and an
account that can both grant finance privilege and set the ceilings those
officers work under is not oversight — it is the absence of it.

### `budget_allocations` — portions drawn against a ceiling

| | Read | Create | Edit | Release |
| --- | :-: | :-: | :-: | :-: |
| Finance Staff | R | C | E (own, while active) | |
| Finance Manager | R | C | E | A |
| Accountant | R | | | |
| Administrator | R | | | |

"Finance Staff — allocation and operational activity as explicitly approved by
policy" is exactly this row: Staff may draw against a ceiling a Manager set, and
correct their own draw while it is still active. Releasing an allocation returns
money to the ceiling, so it belongs to the same authority that set the ceiling.

An allocation is never deleted. Released is a status, because who committed what
against which budget, and when, is the point of having a budget.

## Two invariants the database holds, not the UI

1. **Active allocations never exceed the ceiling.** Enforced by a trigger on
   `budget_allocations`, so it holds no matter which client writes.
2. **One active finance role per person** (from F1, unchanged). A person cannot
   validate and approve the same money, so no one holds two of these roles.

## Four numbers a budget has, and where each comes from

The standalone system's useful distinction, preserved — with the honest note
that two of the four have no source yet.

| Number | Meaning | Source |
| --- | --- | --- |
| **Ceiling** (`amount`) | What was approved | Set by the Finance Manager — **F2** |
| **Allocated** | Portioned out to owners and purposes | Sum of active `budget_allocations` — **F2** |
| **Reserved** | Committed by approved requests not yet paid | The request pipeline — **a later phase** |
| **Spent** | Actually disbursed | The payment pipeline — **a later phase** |

`unallocated = ceiling − allocated` is answerable today.
`remaining = ceiling − spent − reserved` is what an approver may still commit,
and reads as the full ceiling until the phases that supply those two numbers
exist. `budget_status` reports all of them so the distinction is visible from
the first screen rather than retrofitted onto it.

---

# F3 — the request workflow

Master data said what money *is*. This says how money *moves*: an employee asks,
Finance Staff validate, the Finance Manager approves, the Accountant pays. The
one-active-role rule from F1 exists for exactly this chain — one person holding
two of these roles carries a payment from validation to disbursement with nobody
else in the room.

## What the standalone system got wrong here

Its entire approval chain lived in the UI. The database policy was:

```sql
create policy requests_update on requests
  for update to authenticated
  using (requester_id = auth.uid() or is_reviewer())
  with check (requester_id = auth.uid() or is_reviewer());
```

with `is_reviewer()` meaning "everyone except plain employees". Three holes
follow directly, and none is theoretical:

1. **No state machine.** Any reviewer could set any request to any status. The
   Accountant could mark a request `completed` that no one had approved; Finance
   Staff could send their own request straight to payment.
2. **The requester could edit an approved request.** `requester_id = auth.uid()`
   holds at every status, so ₱5,000 could be approved and then edited to
   ₱500,000 before the Accountant paid it.
3. **The requester could delete it**, taking the approval history with it.

None of that is ported. In JMAC a status change is not an UPDATE anyone may
write — it is a function that checks who is asking, what the request's current
status is, and whether that transition exists at all.

## Statuses

Named for the act that is pending rather than the actor who performs it, so a
role rename never silently changes what a status means.

| Status | Meaning |
| --- | --- |
| `draft` | The requester is still preparing it. Nothing is committed. |
| `pending_validation` | Submitted. Finance Staff check the documents and the budget. |
| `pending_approval` | Validated. The Finance Manager decides. |
| `pending_payment` | Approved. **Budget is reserved from here.** The Accountant pays. |
| `completed` | Paid and recorded. The reservation becomes spend. |
| `returned` | Sent back for revision. Editable again. |
| `rejected` | Refused. Terminal. |
| `cancelled` | Withdrawn by the requester before anyone acted. Terminal. |

## Transitions

Every row is a permitted move. Anything not listed is refused by the database,
including moves a role would otherwise seem senior enough to make.

| Actor | From | To | Act |
| --- | --- | --- | --- |
| Requester | `draft` | `pending_validation` | submit |
| Requester | `returned` | `pending_validation` | resubmit |
| Requester | `draft`, `returned` | `cancelled` | withdraw |
| Finance Staff | `pending_validation` | `pending_approval` | validate |
| Finance Staff | `pending_validation` | `returned` | return for revision |
| Finance Staff | `pending_validation` | `rejected` | reject |
| Finance Manager | `pending_approval` | `pending_payment` | approve — **reserves budget** |
| Finance Manager | `pending_approval` | `returned` | return for revision |
| Finance Manager | `pending_approval` | `rejected` | reject |
| Accountant | `pending_payment` | `completed` | pay and record — **reservation becomes spend** |
| Accountant | `pending_payment` | `returned` | return — documents wrong; **releases the reservation** |

The Administrator appears nowhere in this table. They read requests and the
approval history for oversight and move nothing, because an account that grants
finance privilege must not also be able to move money through the chain those
officers staff.

Finance Staff cannot validate their own request, the Finance Manager cannot
approve their own, and the Accountant cannot pay their own — a finance officer
raising a request is a requester like anyone else, and the next step belongs to
somebody else.

## What may be edited, and when

| Field group | Editable at |
| --- | --- |
| Title, description, justification, needed-by | `draft`, `returned` — by the requester |
| **Amount, type, vendor, category, budget** | `draft`, `returned` **only** |
| Payment account and reference | at completion, by the Accountant |
| Status | Never by UPDATE — only through the transition function |

Once a request leaves `draft`/`returned` its financial substance is frozen. What
was approved is what gets paid.

## Records

| | Read | Create | Edit | Transition |
| --- | :-: | :-: | :-: | :-: |
| Own requests (any employee) | R | C | E (draft/returned) | submit, resubmit, cancel |
| Finance Staff | all | C (own) | — | validate, return, reject |
| Finance Manager | all | C (own) | — | approve, return, reject |
| Accountant | all | C (own) | payment fields at completion | pay, return |
| Administrator | all | | | **none** |

`request_approvals` is append-only for everyone. It is the record of who decided
what, and a record that can be edited is not one.

## Budgets stop being hypothetical

F2 shipped `budget_status` with `reserved` and `spent` reading zero and a comment
naming the phase that would supply them. This is that phase:

- **reserved** — the sum of requests at `pending_payment` against the budget.
- **spent** — the sum of requests at `completed`.

Both derived from the requests table rather than stored, so they cannot drift and
double deduction is impossible: at completion a request leaves `reserved` and
enters `spent` in the same instant, and `remaining` does not move.

## Still not F3

Supplier invoices, accounts payable, a general payments ledger, purchase orders,
the stock-demand and receiving bridges, POS sales posting, PayMongo
reconciliation, payroll accounting and journal entries. The Accountant records
*which account a request was paid from and under what reference* — that is the
end of this chain, not the beginning of a ledger.
