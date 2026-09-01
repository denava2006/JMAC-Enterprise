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
