-- Close the default PUBLIC EXECUTE on the two helpers added with System Access.
--
-- Found by the post-cutover ACL check, again. `apply_position_system_access`
-- and `create_position_with_access` were revoked in 20260829010000;
-- `assert_entitlement_allowed` and `validate_change_request_system_access` were
-- not, so PostgreSQL's default grant on new functions left them callable by
-- anon. That is the seventh time this project has been caught by that default.
--
-- Neither is exploitable. `assert_entitlement_allowed` is IMMUTABLE, reads no
-- table, is not SECURITY DEFINER, and only tells the caller whether a role name
-- it already supplied is valid -- a rule that is public in this repository.
-- `validate_change_request_system_access` returns trigger, so calling it
-- directly raises "trigger functions can only be called as triggers" whoever
-- calls it. They are closed because a routine nothing anonymous needs should
-- not be callable anonymously, and because the previous five incidents each
-- looked this harmless in isolation.
--
-- The durable fix is in the contract test, not here: its ACL section now
-- enumerates the workforce routines from pg_proc by name and fails when the set
-- changes, so the next routine added to this area is covered the moment it
-- exists rather than the next time someone remembers to look.

revoke all on function public.assert_entitlement_allowed(public.entitlement_system, text)
  from public, anon;
grant execute on function public.assert_entitlement_allowed(public.entitlement_system, text)
  to authenticated;

-- A trigger function needs no EXECUTE grant at all: the trigger runs as the
-- table owner, not as the caller.
revoke all on function public.validate_change_request_system_access()
  from public, anon, authenticated;
