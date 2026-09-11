-- Stock request: the "needs changes" state, and the events that describe it.
--
-- Values only. PostgreSQL will not let a new enum label be USED in the same
-- transaction that adds it, so the constraints and functions that reference
-- 'returned' live in the migration after this one. Splitting them is not
-- tidiness, it is the only order that works.
--
-- Why a new status at all, when pending/approved/declined/cancelled exist:
--
--   pending    the branch has asked, nobody has answered
--   approved   Finance accepted the demand; it is now procurement's to fulfil
--   declined   Finance will not procure it -- terminal, and already the
--              "reject" this workflow needed, so nothing new is invented for it
--   cancelled  the branch withdrew it themselves
--
-- None of those says "valid, but the branch must correct something before
-- Finance continues". Reusing `declined` for that would make a terminal state
-- non-terminal and destroy the distinction the POS Manager most needs: whether
-- to fix this request or raise a different one.
alter type public.pos_request_status add value if not exists 'returned';

alter type public.pos_audit_event_type add value if not exists 'stock_request_returned';
alter type public.pos_audit_event_type add value if not exists 'stock_request_resubmitted';
