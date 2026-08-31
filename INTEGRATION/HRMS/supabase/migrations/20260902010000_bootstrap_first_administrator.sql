-- Promote the very first account to Administrator, once, deliberately.
--
-- A hosted JMAC needs one Administrator before anyone can do anything: the
-- Administrator is the bootstrap identity that every other privilege descends
-- from, and by design it needs no employee record, no position entitlement and
-- no HR grant (see D2f). But protect_admin_accounts exists precisely to stop a
-- profile being turned into an admin, so bootstrapping needs a sanctioned door
-- rather than a weakened lock.
--
-- This is that door, and it is self-closing:
--
--   * it refuses the moment ANY admin profile exists, so it can only ever
--     create the first one and is inert forever afterwards;
--   * it is granted to no API role -- not anon, not authenticated -- so it is
--     reachable only by a service-role/administrative connection;
--   * it disables exactly ONE trigger, by name, for exactly one statement, and
--     re-enables it before returning. Never DISABLE TRIGGER ALL.
--
-- Because a plpgsql function is atomic, the re-enable cannot be skipped: if the
-- update raises, the whole thing rolls back and the trigger is never left off.
-- The final assertion is belt and braces, and it is the last thing that runs.

create or replace function public.bootstrap_first_administrator(_email text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  _profile_id uuid;
  _existing int;
  _enabled char;
begin
  select count(*) into _existing from public.profiles where role = 'admin';
  if _existing > 0 then
    raise exception
      'ADMIN_ALREADY_EXISTS: this instance already has % Administrator account(s). Bootstrap is for the first one only.',
      _existing;
  end if;

  select id into _profile_id
  from public.profiles
  where lower(email) = lower(trim(_email));

  if _profile_id is null then
    raise exception
      'ADMIN_PROFILE_NOT_FOUND: no account exists for %. Invite the Auth user first, then run this.', _email;
  end if;

  -- Exactly one trigger, by name, for exactly one statement.
  alter table public.profiles disable trigger trg_protect_admin_accounts;

  update public.profiles
     set role = 'admin',
         status = 'active',
         -- The Administrator is deliberately not an employee. Anything the
         -- signup trigger guessed is cleared here.
         employee_id = null
   where id = _profile_id;

  alter table public.profiles enable trigger trg_protect_admin_accounts;

  -- Prove the lock is back on before anyone relies on it.
  select t.tgenabled into _enabled
  from pg_trigger t
  where t.tgrelid = 'public.profiles'::regclass
    and t.tgname = 'trg_protect_admin_accounts';

  if _enabled is null or _enabled = 'D' then
    raise exception 'ADMIN_PROTECTION_NOT_RESTORED: refusing to finish with the guard disabled.';
  end if;

  insert into public.audit_logs (actor_id, action, table_name, record_id, new_data)
  values (null, 'Administrator Bootstrapped', 'profiles', _profile_id,
          jsonb_build_object('email', lower(trim(_email))));

  return _profile_id;
end;
$fn$;

-- Reachable by no API role. This is an operator action, not a feature.
revoke all on function public.bootstrap_first_administrator(text)
  from public, anon, authenticated;

comment on function public.bootstrap_first_administrator(text) is
  'One-time: promotes the first account to Administrator. Refuses once any admin '
  'exists, so it cannot create a second. Granted to no API role.';
