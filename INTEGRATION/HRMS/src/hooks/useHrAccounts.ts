import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase'
import type { Tables } from '@/lib/database.types'
import type { UserRole } from '@/lib/enums'
import { ROLE_LABEL, type CreatableHrRole } from '@/lib/roles'
import { toast } from '@/components/ui/sonner'
import { describeFunctionError } from '@/lib/functionErrors'

export type HrAccount = Tables<'profiles'>

const QUERY_KEY = ['hr_accounts']

export function useHrAccounts() {
  return useQuery({
    queryKey: QUERY_KEY,
    queryFn: async () => {
      // Employee logins (added by the Employee Management module) share this
      // same table but are managed from the Employee Details page, not here.
      const { data, error } = await supabase
        .from('profiles')
        .select('*')
        .in('role', ['admin', 'hr_manager', 'hr_staff'])
        .order('full_name')
      if (error) throw error
      return data
    },
  })
}

interface CreateHrAccountInput {
  email: string
  full_name: string
  role: CreatableHrRole
}

export function useCreateHrAccount() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (input: CreateHrAccountInput) => {
      const { data, error } = await supabase.functions.invoke('create-hr-account', { body: input })
      if (error) throw new Error(await describeFunctionError(error, 'account service'))
      if (data?.error) throw new Error(data.error)
      return data as { id: string; email: string; role: UserRole; password: string }
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: QUERY_KEY })
      toast.success(`${ROLE_LABEL[data.role]} account created. They can sign in now with ${data.email} / ${data.password}.`)
    },
    onError: (error) => toast.error(error.message),
  })
}

export function useUpdateHrAccount() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async ({ id, values }: { id: string; values: { full_name?: string; role?: UserRole } }) => {
      const { error } = await supabase.from('profiles').update(values).eq('id', id)
      if (error) throw error
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: QUERY_KEY })
      toast.success('Account updated')
    },
    onError: (error) => toast.error(error.message),
  })
}

export function useSetAccountStatus() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async ({ id, status }: { id: string; status: 'active' | 'inactive' }) => {
      const { error } = await supabase.from('profiles').update({ status }).eq('id', id)
      if (error) throw error
    },
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: QUERY_KEY })
      toast.success(variables.status === 'active' ? 'Account reactivated' : 'Account deactivated')
    },
    onError: (error) => toast.error(error.message),
  })
}
