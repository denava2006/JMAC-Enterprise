// Resets an employee's login password back to the documented default.
//
// This app runs on a per-deployer local Supabase stack (see README), so there
// is no mailbox a reset link could reach — the same reason create-employee-account
// uses a fixed default password instead of an emailed invite. An employee who
// has forgotten theirs is unblocked by HR handing them the default again in
// person, which is what this does.
//
// Changing another user's password requires the service_role key, so it has to
// happen here rather than in the browser.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

// Kept identical to create-employee-account's default: HR tells people the
// same thing whether the account was just made or just reset.
const DEFAULT_EMPLOYEE_PASSWORD = 'Employee123'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const authHeader = req.headers.get('Authorization')
    if (!authHeader) return json({ error: 'Missing authorization header.' }, 401)

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY')!
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

    // Scoped to the CALLER's own token — used only to find out who they are.
    // Cannot bypass RLS.
    const callerClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
      // Without this, supabase-js manages its own session and substitutes its
      // own token on rpc()/from() calls, so the caller's JWT never reaches
      // PostgREST -- auth.uid() comes back null and every is_admin() check
      // inside a SECURITY DEFINER function fails for a genuine Administrator.
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    })

    const {
      data: { user },
      error: userError,
    } = await callerClient.auth.getUser()
    if (userError || !user) return json({ error: 'Not authenticated.' }, 401)

    const { data: callerProfile, error: profileError } = await callerClient
      .from('profiles')
      .select('role, status')
      .eq('id', user.id)
      .single()

    const callerIsStaff =
      !profileError &&
      callerProfile &&
      ['admin', 'hr_manager', 'hr_staff'].includes(callerProfile.role) &&
      callerProfile.status === 'active'
    if (!callerIsStaff) {
      return json({ error: 'Only active HR staff, HR managers, or administrators can reset a password.' }, 403)
    }

    const body = await req.json().catch(() => null)
    const employeeId: string | undefined = body?.employeeId
    if (!employeeId) return json({ error: 'employeeId is required.' }, 400)

    // Elevated client — service_role key, server-side only, never sent to the browser.
    const adminClient = createClient(supabaseUrl, serviceRoleKey)

    // Resolved from the employee record rather than taken from the request, so
    // a caller can't aim this at an arbitrary auth user id — including an
    // administrator's.
    const { data: profile, error: lookupError } = await adminClient
      .from('profiles')
      .select('id, email, role')
      .eq('employee_id', employeeId)
      .maybeSingle()
    if (lookupError) return json({ error: lookupError.message }, 400)
    if (!profile) return json({ error: 'This employee does not have an account yet.' }, 404)
    if (profile.role !== 'employee') {
      return json({ error: 'This account is not an employee login and cannot be reset here.' }, 403)
    }

    const { error: updateError } = await adminClient.auth.admin.updateUserById(profile.id, {
      password: DEFAULT_EMPLOYEE_PASSWORD,
    })
    if (updateError) return json({ error: updateError.message }, 400)

    // They're back on a password HR knows, so they're back to not being
    // activated — the app will make them choose a new one at their next login.
    // Cleared after the reset, because changing the password stamps it.
    await adminClient.from('profiles').update({ activated_at: null }).eq('id', profile.id)

    await adminClient.from('employee_history').insert({
      employee_id: employeeId,
      event: 'password_reset',
      actor_id: user.id,
    })
    await adminClient.from('audit_logs').insert({
      actor_id: user.id,
      action: 'Employee Password Reset',
      table_name: 'employees',
      record_id: employeeId,
    })

    return json({ email: profile.email, password: DEFAULT_EMPLOYEE_PASSWORD })
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : 'Unexpected error.' }, 500)
  }
})
