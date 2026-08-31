// Creates an employee login for JMAC Enterprise.
//
// This has to be an Edge Function because creating an auth user needs the
// service_role key, which must never reach the browser. Any active Admin, HR
// Manager or HR Staff may call it; the resulting profile is role='employee'
// and linked to a specific employees row.
//
// Phase 9B removed the shared password. Until then every account was created
// on 'Employee123' and the browser was told so, which meant one publicly
// documented credential opened any freshly created account until its owner got
// round to changing it. Now the employee is invited: Supabase mails a one-time
// link, they choose a password nobody else ever knows, and nothing reusable is
// returned to the caller.
//
// The cost is a real dependency: this needs a working email sender. A project
// with no custom SMTP cannot deliver to arbitrary addresses, and the function
// says so plainly rather than silently falling back to a shared secret.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

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

    // Scoped to the CALLER's own token — used only to find out who they are
    // and confirm they're active HR staff/admin. Cannot bypass RLS.
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

    // Creating an employee's login is ordinary HR work — every HR role does it,
    // unlike create-hr-account (creating an HR Staff/Manager login), which
    // stays Administrator-only.
    const callerIsStaff =
      !profileError &&
      callerProfile &&
      ['admin', 'hr_manager', 'hr_staff'].includes(callerProfile.role) &&
      callerProfile.status === 'active'
    if (!callerIsStaff) {
      return json({ error: 'Only active HR staff, HR managers, or administrators can create employee accounts.' }, 403)
    }

    const body = await req.json().catch(() => null)
    const employeeId: string | undefined = body?.employeeId
    const email: string | undefined = body?.email
    const fullName: string | undefined = body?.fullName

    if (!employeeId || !email || !fullName) {
      return json({ error: 'employeeId, email, and fullName are all required.' }, 400)
    }

    // Elevated client — service_role key, server-side only, never sent to the browser.
    const adminClient = createClient(supabaseUrl, serviceRoleKey)

    const { data: employeeRow, error: employeeError } = await adminClient
      .from('employees')
      .select('id')
      .eq('id', employeeId)
      .single()
    if (employeeError || !employeeRow) return json({ error: 'Employee record not found.' }, 404)

    const { data: existingProfile, error: existingProfileError } = await adminClient
      .from('profiles')
      .select('id')
      .eq('employee_id', employeeId)
      .maybeSingle()
    if (existingProfileError) return json({ error: existingProfileError.message }, 400)

    // With a fixed default password there's no "pending activation" state left
    // to resend for — every account this function creates is fully usable the
    // moment it's created, so a second call for the same employee is always
    // a duplicate, not a resend.
    if (existingProfile) {
      return json({ error: 'This employee already has an account.' }, 400)
    }

    // Invite rather than assign: no password is chosen here, so none can leak
    // here either.
    const { data: created, error: createError } = await adminClient.auth.admin.inviteUserByEmail(
      email,
      { data: { full_name: fullName } }
    )

    if (createError || !created?.user) {
      console.error('inviteUserByEmail failed:', createError?.message)
      return json({
        error:
          'Could not send the setup email. Check that this project has an SMTP sender configured, then try again.',
      }, 502)
    }

    // handle_new_user() already created a `profiles` row — overwrite it for an
    // employee login.
    //
    // activated_at is deliberately NOT stamped. "Activated" means the employee
    // has set a password only they know, and the stamp comes from the password
    // change itself, so it now marks something real: until they follow the
    // invite there is no password at all.
    const now = new Date().toISOString()
    const { error: updateError } = await adminClient
      .from('profiles')
      .update({
        full_name: fullName,
        role: 'employee',
        status: 'active',
        employee_id: employeeId,
        created_by: user.id,
        invited_at: now,
      })
      .eq('id', created.user.id)

    if (updateError) return json({ error: updateError.message }, 400)

    await adminClient.from('employee_history').insert({
      employee_id: employeeId,
      event: 'account_created',
      actor_id: user.id,
    })
    await adminClient.from('audit_logs').insert({
      actor_id: user.id,
      action: 'Employee Account Created',
      table_name: 'employees',
      record_id: employeeId,
    })

    // No password in the response, because none exists to return.
    return json({
      id: created.user.id,
      email: created.user.email,
      setupRequired: true,
      invited: true,
    })
  } catch (err) {
    console.error('create-employee-account unhandled:', err instanceof Error ? err.message : err)
    return json({ error: 'Could not create that account.' }, 500)
  }
})
