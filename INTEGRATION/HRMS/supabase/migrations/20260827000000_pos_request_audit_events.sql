-- Phase 8, part 1 of 2: the audit event types for inventory requests.
--
-- This migration adds enum values and does NOTHING else, on purpose.
-- PostgreSQL refuses to *use* a newly added enum value inside the transaction
-- that added it:
--
--     unsafe use of new value "..." of enum type pos_audit_event_type
--
-- and the Supabase CLI runs each migration file in one transaction. So the
-- values have to be committed here before 20260827010000 can reference them in
-- pos_audit_is_manager_visible() or write a row carrying one.
--
-- All four are manager-visible. Unlike assignment_granted -- which is HR-adjacent
-- administration a branch manager has no claim on -- these describe the
-- manager's own request at their own branch. A decision they cannot see is not a
-- decision.

alter type public.pos_audit_event_type add value 'stock_request_created';
alter type public.pos_audit_event_type add value 'stock_request_cancelled';
alter type public.pos_audit_event_type add value 'stock_request_approved';
alter type public.pos_audit_event_type add value 'stock_request_declined';
