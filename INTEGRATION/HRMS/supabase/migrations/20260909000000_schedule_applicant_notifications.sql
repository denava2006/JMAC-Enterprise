-- Deliver applicant notifications on a schedule instead of on request.
--
-- The outbox has been queuing correctly for some time, but
-- send-applicant-notifications only ever ran when somebody invoked it. An
-- applicant whose application moved on a Friday heard nothing until a person
-- happened to trigger the worker. Queuing reliably and delivering manually is
-- not a working notification system.
--
-- This reuses the pattern the POS expiry sweep established rather than
-- inventing a second one: pg_cron calls the function over pg_net, carrying a
-- token that the database generated into Vault. The token is never typed by a
-- person, never pasted into a terminal, never in this file, and never in the
-- repository -- both sides read it from Vault, and the function compares it in
-- constant time.
--
-- It also closes a hole. Until now the worker relied on Supabase's default JWT
-- verification, which the PUBLIC anon key satisfies -- so anyone who read the
-- frontend bundle could make JMAC send its queued mail. A dedicated token means
-- only the scheduler can, and if it ever leaked the worst it could do is
-- deliver mail that was already queued and addressed.
--
-- Nothing about retries changes. The worker already claims a row with a
-- compare-and-set (`update ... where status in ('pending','failed')`, skip if
-- it matched nothing), already counts attempts against a maximum of 5, and
-- already backs off 1/5/30/120/480 minutes. Two overlapping cron runs and a
-- manual retry can race safely; exactly one of them moves the row.

-- ---------------------------------------------------------------- the token
create or replace function public.applicant_notify_token()
returns text
language sql
stable
security definer
set search_path = ''
as $fn$
  select decrypted_secret from vault.decrypted_secrets
   where name = 'applicant_notify_token';
$fn$;

revoke all on function public.applicant_notify_token() from public, anon, authenticated;
grant execute on function public.applicant_notify_token() to service_role;

comment on function public.applicant_notify_token() is
  'Shared secret proving a delivery run came from pg_cron. Service-role only.';

-- Generated here, so no human and no file ever holds it. Guarded because a
-- local stack may not have the same Vault state, and re-running must not mint
-- a second secret with the same name.
do $$
begin
  if to_regclass('vault.secrets') is null then
    raise notice 'vault is not installed; skipping token creation';
    return;
  end if;

  if exists (select 1 from vault.secrets where name = 'applicant_notify_token') then
    raise notice 'applicant_notify_token already exists; leaving it alone';
    return;
  end if;

  perform vault.create_secret(
    encode(extensions.gen_random_bytes(32), 'hex'),
    'applicant_notify_token',
    'Shared secret proving an applicant-notification delivery run came from pg_cron');
end $$;

-- --------------------------------------------------------------- the schedule
-- Every five minutes. Applicants do not need second-level delivery, and a
-- status change reaching an inbox within five minutes reads as immediate --
-- while keeping invocation volume to a few hundred a day rather than tens of
-- thousands. The worker exits immediately when nothing is due.
do $$
declare
  _url text := 'https://joffopwzqmlqpsrbivfq.supabase.co/functions/v1/send-applicant-notifications';
begin
  if to_regclass('cron.job') is null then
    -- Local stacks do not run pg_cron. The function and token still exist, so
    -- the worker can be exercised directly by the test suite.
    raise notice 'pg_cron is not installed; skipping schedule';
    return;
  end if;

  perform cron.unschedule('applicant-notification-delivery')
   where exists (select 1 from cron.job where jobname = 'applicant-notification-delivery');

  perform cron.schedule(
    'applicant-notification-delivery',
    '*/5 * * * *',
    format($job$
      select net.http_post(
        url := %L,
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'x-jmac-notify-token', public.applicant_notify_token()
        ),
        body := '{}'::jsonb,
        timeout_milliseconds := 30000
      );
    $job$, _url)
  );
end $$;
