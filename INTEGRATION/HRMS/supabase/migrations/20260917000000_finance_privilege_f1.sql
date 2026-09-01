-- FMS F1 — finance authorization, on the workforce that already exists.
--
-- Finance people are employees. They are hired into a position, they have
-- attendance and payslips, and they hold a finance privilege on top. That is
-- the same shape HR and POS already use, so this adds no second identity, no
-- second profile table and no separate finance login -- the standalone FMS's
-- auth stack stays what it is, a reference implementation nobody runs.
--
-- Two decisions are enforced here rather than described:
--
--   Exactly one active finance role per person. Finance Staff validates,
--   Finance Manager approves, the Accountant pays and posts. One person holding
--   two of those carries a payment from validation to disbursement with nobody
--   else in the room, which is the control the three-stage chain exists to
--   provide. A partial unique index makes the alternative impossible rather
--   than merely discouraged.
--
--   The Administrator is not an operational finance role. They grant and revoke
--   finance privilege and read the audit trail; they do not validate, approve,
--   pay or post. Modelling them as all three roles at once would rebuild inside
--   one account exactly the combination the index forbids for everyone else.

-- --------------------------------------------------------------- the roles
-- profiles.role gains the three finance values because has_*_privilege requires
-- the profile and the grant to AGREE: an account demoted to 'employee' stops
-- authorizing even while its grant row survives. Without the enum values that
-- safety property cannot exist for finance.
alter type public.user_role add value if not exists 'finance_staff';
alter type public.user_role add value if not exists 'finance_manager';
alter type public.user_role add value if not exists 'accountant';

-- Alone in this migration on purpose. Postgres will not let a new enum value be
-- USED in the transaction that adds it, so the grant table, its checks and the
-- functions that compare against these values all live in the next migration.
-- Splitting them is not tidiness; running them together fails.
