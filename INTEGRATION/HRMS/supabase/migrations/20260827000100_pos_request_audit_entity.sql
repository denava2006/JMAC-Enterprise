-- Phase 8, part 1b: the audit entity type for inventory requests.
--
-- Separate from 20260827010000 for the same reason as 20260827000000: a new
-- enum value cannot be used in the transaction that adds it, and the Supabase
-- CLI runs each migration file in one transaction.
--
-- Ordered between the event-type migration and the table migration so that
-- 20260827010000 can reference it.

alter type public.pos_audit_entity_type add value 'inventory_request';
