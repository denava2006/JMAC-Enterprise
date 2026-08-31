// Give an existing employee HR privilege.
//
// The previous version of this function took a full name, an email and a role
// from the browser and created a standalone HR login with a fixed password
// (HrStaff123 / HrManager123). Three things were wrong with that, and Phase 9B
// fixes all three:
//
//   1. The account had no workforce identity. It was an HR Manager because a
//      column said so -- no employee, no department, no position, nothing that
//      could ever make the access wrong.
//   2. The role came from the client. Whatever the screen offered, the request
//      body decided.
//   3. Everyone shared a password, and the browser was told what it was.
//
// Now the Administrator picks an EMPLOYEE. Name and email are read from that
// employee's record, the role is re-checked against what their position
// actually confers, and no password is ever chosen, stored or returned. An
// employee who already has a self-service login keeps it -- the same auth user
// and the same profile are upgraded in place, because one person having two
// accounts is the thing this must not do.

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

const HR_ROLES = ['hr_staff', 'hr_manager']

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY')!
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

    const authHeader = req.headers.get('Authorization')
    if (!authHeader) return json({ error: 'Missing authorization header.' }, 401)

    // The caller's own client, so RLS and auth apply to them as usual.
    const callerClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
      // Without this, supabase-js manages its own session and substitutes its
      // own token on rpc()/from() calls, so the caller's JWT never reaches
      // PostgREST -- auth.uid() comes back null and every is_admin() check
      // inside a SECURITY DEFINER function fails for a genuine Administrator.
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    })
    const { data: { user }, error: userError } = await callerClient.auth.getUser()
    if (userError || !user) return json({ error: 'Not authenticated.' }, 401)

    const { data: callerProfile } = await callerClient
      .from('profiles').select('role, status').eq('id', user.id).single()

    // Granting HR privilege stays Administrator-only. Creating an *employee's*
    // login is ordinary HR work; deciding who administers people is not.
    if (!callerProfile || callerProfile.role !== 'admin' || callerProfile.status !== 'active') {
      return json({ error: 'Only an active Administrator can grant HR privilege.' }, 403)
    }

    const body = await req.json().catch(() => null)
    const employeeId: string | undefined = body?.employeeId
    const requestedRole: string | undefined = body?.hrRole

    if (!employeeId || !requestedRole) {
      return json({ error: 'employeeId and hrRole are both required.' }, 400)
    }
    if (!HR_ROLES.includes(requestedRole)) {
      return json({ error: 'hrRole must be hr_staff or hr_manager.' }, 400)
    }

    // Elevated client -- service_role key, server-side only, never sent to the
    // browser.
    const adminClient = createClient(supabaseUrl, serviceRoleKey)

    // Identity comes from the employee record, never from the request body.
    const { data: employee, error: employeeError } = await adminClient
      .from('employees')
      .select('id, first_name, last_name, email, employment_status')
      .eq('id', employeeId)
      .single()
    if (employeeError || !employee) return json({ error: 'Employee record not found.' }, 404)

    const fullName = `${employee.first_name} ${employee.last_name}`.trim()

    // Check eligibility BEFORE provisioning anything.
    //
    // The grant re-checks it too, but by then an account would already exist:
    // asking for a role an employee cannot hold would leave a stray login
    // behind for somebody who was never eligible for anything. Eligibility is a
    // property of the JOB, so it can be answered before there is a profile at
    // all -- get_hr_account_candidates lists exactly the employees whose
    // position confers the requested role, which is also what the screen shows.
    const { data: candidates, error: candidateError } = await callerClient
      .rpc('get_hr_account_candidates', { _hr_role: requestedRole })
    if (candidateError) {
      console.error('get_hr_account_candidates failed:', candidateError.message)
      return json({ error: 'Could not check eligibility.' }, 400)
    }
    const candidate = (candidates ?? []).find(
      (c: { employee_id: string }) => c.employee_id === employeeId
    )
    if (!candidate) {
      return json({
        error:
          'That employee is not eligible for this HR role, or already holds HR privilege. ' +
          'Eligibility comes from their position’s System access.',
      }, 400)
    }

    // Does this employee already have an account?
    const { data: existingProfile } = await adminClient
      .from('profiles').select('id, role, status').eq('employee_id', employeeId).maybeSingle()

    let profileId = existingProfile?.id ?? null
    let created = false

    if (!profileId) {
      // No login yet. Invite rather than assign a password: the employee sets
      // their own, and nothing reusable is ever transmitted or stored.
      const { data: invited, error: inviteError } = await adminClient.auth.admin.inviteUserByEmail(
        employee.email,
        { data: { full_name: fullName } }
      )

      if (inviteError || !invited?.user) {
        // Almost always email delivery: a project with no custom SMTP cannot
        // send to arbitrary addresses. Say so rather than blaming the request.
        console.error('inviteUserByEmail failed:', inviteError?.message)
        return json({
          error:
            'Could not send the setup email. Check that this project has an SMTP sender configured, then try again.',
        }, 502)
      }

      profileId = invited.user.id
      created = true

      // The auth trigger creates the profile, but its column defaults are
      // role='hr_staff' and status='inactive' -- neither of which this flow
      // wants. Set both explicitly: the account starts as an ordinary active
      // employee, and grant_hr_privilege below is what raises it to an HR role.
      // Leaving status at its default would make the grant fail with "the
      // account is deactivated", which is how this was found.
      const { error: linkError } = await adminClient
        .from('profiles')
        .update({
          employee_id: employeeId,
          full_name: fullName,
          role: 'employee',
          status: 'active',
          invited_at: new Date().toISOString(),
        })
        .eq('id', profileId)
      if (linkError) {
        console.error('profile link failed:', linkError.message)
        return json({ error: 'The account was created but could not be linked. Contact the administrator.' }, 500)
      }
    }

    // The grant itself. grant_hr_privilege re-checks eligibility against the
    // employee's CURRENT position and writes profiles.role and the grant
    // together, so nothing here can talk it into a role the job does not
    // confer -- whatever this function was asked for.
    // Called as the CALLER, not as service_role. grant_hr_privilege authorizes
    // with is_admin(), which reads auth.uid() -- and the service_role key
    // carries no user, so it would be refused as "not an Administrator" no
    // matter who asked. The caller is the Administrator we verified above, and
    // the RPC re-checks that itself.
    const { error: grantError } = await callerClient.rpc('grant_hr_privilege', {
      _profile_id: profileId,
      _hr_role: requestedRole,
    })

    if (grantError) {
      const message = grantError.message ?? ''
      if (message.includes('HR_GRANT_NOT_ELIGIBLE')) {
        return json({ error: message.split('HR_GRANT_NOT_ELIGIBLE:')[1]?.trim() ?? message }, 400)
      }
      if (message.includes('HR_GRANT_EXISTS')) {
        return json({ error: 'That employee already holds HR privilege.' }, 400)
      }
      console.error('grant_hr_privilege failed:', message)
      return json({ error: 'Could not grant HR privilege.' }, 400)
    }

    // Deliberately no password in this response, ever.
    return json({
      profileId,
      employeeId,
      email: employee.email,
      fullName,
      hrRole: requestedRole,
      accountCreated: created,
      setupRequired: created,
    })
  } catch (err) {
    console.error('create-hr-account unhandled:', err instanceof Error ? err.message : err)
    return json({ error: 'Could not complete that request.' }, 500)
  }
})
