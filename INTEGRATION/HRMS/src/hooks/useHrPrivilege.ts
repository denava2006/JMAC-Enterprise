import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase'
import { toast } from '@/components/ui/sonner'
import { describeFunctionError } from '@/lib/functionErrors'

/**
 * HR privilege, as the Administrator manages it.
 *
 * Every list here comes from a database RPC rather than a filtered query. The
 * candidate list in particular decides who may be given HR authority, and a
 * list narrowed in React is a list that can be widened in React — the RPCs are
 * `is_admin()`-gated and the grant re-checks eligibility regardless of what
 * the client sends.
 */

export const HR_PRIVILEGE_KEY = ['hr-privilege'] as const

/** An employee whose position confers an HR role and who holds no live grant. */
export interface HrCandidate {
  employee_id: string
  profile_id: string | null
  full_name: string
  email: string
  employee_number: string | null
  department_name: string
  position_title: string
  eligible_roles: string[]
  has_account: boolean
  account_role: string | null
}

/** An account that holds, or held, HR privilege. */
export interface HrAccount {
  profile_id: string
  full_name: string | null
  email: string
  account_role: string
  account_status: string
  employee_id: string | null
  department_name: string | null
  position_title: string | null
  employment_status: string | null
  hr_role: string
  grant_status: string
  granted_at: string
  closed_at: string | null
  closed_reason: string | null
  currently_eligible: boolean
  /** All three conditions hold right now. This is the only field that answers
   *  "can they actually do anything", and it is computed in the database. */
  authorizes_now: boolean
  last_login_at: string | null
}

export function useHrCandidates(hrRole?: string) {
  return useQuery({
    queryKey: [...HR_PRIVILEGE_KEY, 'candidates', hrRole ?? 'any'],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('get_hr_account_candidates', {
        _hr_role: hrRole ?? undefined,
      })
      if (error) throw error
      return (data ?? []) as unknown as HrCandidate[]
    },
  })
}

export function useHrAccounts() {
  return useQuery({
    queryKey: [...HR_PRIVILEGE_KEY, 'accounts'],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('get_hr_accounts')
      if (error) throw error
      return (data ?? []) as unknown as HrAccount[]
    },
  })
}

function describeGrantError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error ?? '')
  if (message.includes('HR_GRANT_NOT_ELIGIBLE')) {
    return message.split('HR_GRANT_NOT_ELIGIBLE:')[1]?.trim() || 'That employee is not eligible for this HR role.'
  }
  if (message.includes('HR_GRANT_EXISTS')) return 'That account already holds HR privilege.'
  if (message.includes('HR_GRANT_CLOSED')) {
    return 'That privilege was closed. Grant a new one instead of reopening it.'
  }
  if (message.includes('Only an Administrator')) return message
  return message || 'That change could not be saved.'
}

/**
 * Give an existing account HR privilege.
 *
 * Used when the employee already has a self-service login: the same auth user
 * and the same profile are upgraded, so nobody ends up with two accounts. An
 * employee with no login yet goes through the Edge Function instead, which has
 * to create one.
 */
export function useGrantHrPrivilege() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async ({ profileId, hrRole }: { profileId: string; hrRole: string }) => {
      const { error } = await supabase.rpc('grant_hr_privilege', {
        _profile_id: profileId,
        _hr_role: hrRole,
      })
      if (error) throw new Error(describeGrantError(error))
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: HR_PRIVILEGE_KEY })
      queryClient.invalidateQueries({ queryKey: ['hr-accounts'] })
      toast.success('HR privilege granted.')
    },
    onError: (error) => toast.error(error.message),
  })
}

/** Provision an account AND grant it, for an employee with no login yet. */
export function useCreateHrAccountForEmployee() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async ({ employeeId, hrRole }: { employeeId: string; hrRole: string }) => {
      const { data, error } = await supabase.functions.invoke('create-hr-account', {
        body: { employeeId, hrRole },
      })
      if (error) throw new Error(await describeFunctionError(error, 'account service'))
      if (data?.error) throw new Error(data.error)
      return data as { email: string; accountCreated: boolean }
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: HR_PRIVILEGE_KEY })
      queryClient.invalidateQueries({ queryKey: ['hr-accounts'] })
      toast.success(
        data.accountCreated
          ? `HR privilege granted. A setup link has been emailed to ${data.email}.`
          : 'HR privilege granted.'
      )
    },
    onError: (error) => toast.error(error.message),
  })
}

/** Close it. The login and the employment record are untouched — losing HR
 *  authority is not losing employment, so they keep Employee Self-Service. */
export function useCloseHrPrivilege() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async ({ profileId, reason }: { profileId: string; reason: string }) => {
      const { error } = await supabase.rpc('close_hr_privilege', {
        _profile_id: profileId,
        _reason: reason,
      })
      if (error) throw new Error(describeGrantError(error))
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: HR_PRIVILEGE_KEY })
      queryClient.invalidateQueries({ queryKey: ['hr-accounts'] })
      toast.success('HR privilege closed. The account keeps Employee Self-Service.')
    },
    onError: (error) => toast.error(error.message),
  })
}
