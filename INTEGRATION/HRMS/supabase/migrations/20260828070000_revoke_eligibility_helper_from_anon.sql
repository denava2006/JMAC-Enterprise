-- Phase 9A follow-up: close the one routine this phase left with the default
-- PUBLIC EXECUTE grant.
--
-- Found by the post-cutover production smoke test, not by a test -- which is
-- itself the finding. Migration 20260828030000 issued both revokes for
-- is_eligible_for_system_role() and describe_pos_ineligibility(), but not for
-- employment_permits_operational_work(). PostgreSQL grants PUBLIC EXECUTE on
-- every new function by default, so omitting the revoke is not a neutral
-- omission -- it is a grant. That is ACL incident pattern #1/#2/#5 in this
-- project, and this is the sixth new routine it has caught.
--
-- The exposure here is nil: the function is IMMUTABLE, reads no table, is not
-- SECURITY DEFINER, and its body is `select _status = 'active'` -- an anonymous
-- caller must already hold the value it asks about, and learns only a rule that
-- is public in the repository. It is closed anyway, because "harmless this time"
-- is how the previous five incidents were also introduced, and because a
-- routine nothing anonymous needs should not be callable anonymously.
--
-- Behaviour is unchanged for every legitimate caller: is_eligible_for_system_role()
-- is SECURITY DEFINER and calls this as its owner, and `authenticated` keeps
-- EXECUTE.

revoke all on function public.employment_permits_operational_work(public.employment_status)
  from public, anon;

grant execute on function public.employment_permits_operational_work(public.employment_status)
  to authenticated;
