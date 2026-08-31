import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase'
import { useAuth } from '@/contexts/AuthContext'
import type { Tables, TablesUpdate } from '@/lib/database.types'
import type { EmploymentStatus } from '@/lib/enums'
import type { CurrencyCode } from '@/lib/currency'
import { toast } from '@/components/ui/sonner'
import { describeFunctionError } from '@/lib/functionErrors'
import { describeWorkforceError } from '@/lib/workforce'

function friendlyEmployeeError(error: Error): string {
  if (error.message.includes('employees_email_key')) return 'An employee with this email already exists.'
  // A transfer can trip the workforce rules -- a position that does not belong
  // to the chosen department, or an assignment that stops being eligible.
  // describeWorkforceError turns those codes into the database's own sentence.
  return describeWorkforceError(error)
}

const EMPLOYEE_SELECT = `
  *,
  departments (id, name),
  positions (id, title),
  salary_grades (id, grade_name, min_salary, max_salary),
  profiles (id, email, role, status, invited_at, activated_at, last_login_at)
`

export type EmployeeAccount = Pick<
  Tables<'profiles'>,
  'id' | 'email' | 'role' | 'status' | 'invited_at' | 'activated_at' | 'last_login_at'
>

export type Employee = Tables<'employees'> & {
  departments: { id: string; name: string } | null
  positions: { id: string; title: string } | null
  salary_grades: { id: string; grade_name: string; min_salary: number; max_salary: number } | null
  // profiles.employee_id carries a UNIQUE constraint, so PostgREST embeds this
  // as a one-to-one relation (a single row or null), not an array.
  profiles: EmployeeAccount | null
}

const LIST_KEY = ['employees']
const STATS_KEY = ['employee-stats']

export function useEmployees() {
  return useQuery({
    queryKey: LIST_KEY,
    queryFn: async () => {
      // "On Leave" is derived from whether an approved leave covers today.
      // Approving a request flips it via trigger, but a leave *ending* is the
      // passing of a date, which nothing fires on — so the list reconciles
      // before it reads. The update matches zero rows on almost every call.
      await supabase.rpc('sync_employment_statuses')

      const { data, error } = await supabase.from('employees').select(EMPLOYEE_SELECT).order('created_at', { ascending: false })
      if (error) throw error
      return data as unknown as Employee[]
    },
  })
}

export function useEmployeeDetail(employeeId: string | undefined) {
  return useQuery({
    queryKey: [...LIST_KEY, employeeId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('employees')
        .select(EMPLOYEE_SELECT)
        .eq('id', employeeId as string)
        .maybeSingle()
      if (error) throw error
      return data as unknown as Employee | null
    },
    enabled: !!employeeId,
  })
}

// ---- Pending employee records (deployed applicants awaiting Step 2-4 of Create Employee) ----

export interface PendingEmployee {
  applicationId: string
  firstName: string
  middleName: string | null
  lastName: string
  email: string
  phone: string | null
  address: string | null
  deployedAt: string
}

const PENDING_KEY = ['pending-employees']

/** A "pending employee" is never a stored row — it's a deployed application that
 * has no matching employees.application_id yet. Modeling it as a computed view
 * (rather than an early, half-filled employees insert) keeps every other module's
 * assumptions about employees (basic_salary, hire_date, etc. always present)
 * intact, and matches the spec's own "Employee ID is generated after saving". */
export function usePendingEmployees() {
  return useQuery({
    queryKey: PENDING_KEY,
    queryFn: async () => {
      const [deployedRes, linkedRes] = await Promise.all([
        supabase
          .from('applications')
          .select('id, updated_at, applicants(first_name, middle_name, last_name, email, phone, address)')
          .eq('status', 'deployed'),
        supabase.from('employees').select('application_id').not('application_id', 'is', null),
      ])
      if (deployedRes.error) throw deployedRes.error
      if (linkedRes.error) throw linkedRes.error

      const linkedApplicationIds = new Set(linkedRes.data.map((e) => e.application_id))
      return (deployedRes.data ?? [])
        .filter((a) => !linkedApplicationIds.has(a.id))
        .map((a) => ({
          applicationId: a.id,
          firstName: a.applicants?.first_name ?? '',
          middleName: a.applicants?.middle_name ?? null,
          lastName: a.applicants?.last_name ?? '',
          email: a.applicants?.email ?? '',
          phone: a.applicants?.phone ?? null,
          address: a.applicants?.address ?? null,
          deployedAt: a.updated_at,
        })) satisfies PendingEmployee[]
    },
  })
}

/** Powers Step 1 and Step 2's auto-fill when Create Employee is opened from a
 * pending row — Deployment already decided position/department/salary/
 * employment type via the accepted job offer, so Employee Management must
 * reuse those values rather than have HR re-key them and risk the two
 * modules disagreeing on what was actually offered. */
export function useApplicationForEmployeeCreation(applicationId: string | undefined) {
  return useQuery({
    queryKey: ['application-for-employee-creation', applicationId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('applications')
        .select(
          `id,
          applicants (first_name, middle_name, last_name, email, phone, address, province, city, barangay),
          job_postings (department_id, position_id),
          job_offers (employment_type, salary_grade_id, proposed_salary, currency, work_schedule_id, created_at),
          deployment_records (work_schedule_id)`
        )
        .eq('id', applicationId as string)
        .single()
      if (error) throw error

      const latestOffer = [...(data.job_offers ?? [])].sort((a, b) => b.created_at.localeCompare(a.created_at))[0] ?? null
      // Deployment is the later, confirmed decision — it wins over whatever the
      // offer originally proposed if HR changed the shift on the way through.
      const deployment = data.deployment_records as unknown as { work_schedule_id: string | null } | null
      const workScheduleId = deployment?.work_schedule_id ?? latestOffer?.work_schedule_id ?? null
      return { ...data, latestOffer, workScheduleId }
    },
    enabled: !!applicationId,
  })
}

/** "Inactive" = no longer with the company (resigned/terminated/retired) —
 * distinct from On Leave/Contractual/Temporary, which are still-employed states. */
const INACTIVE_STATUSES: EmploymentStatus[] = ['resigned', 'terminated', 'retired']

export function useEmployeeStats() {
  return useQuery({
    queryKey: STATS_KEY,
    queryFn: async () => {
      const [total, active, regular, inactive] = await Promise.all([
        supabase.from('employees').select('*', { count: 'exact', head: true }),
        supabase.from('employees').select('*', { count: 'exact', head: true }).eq('employment_status', 'active'),
        // 'Regular' is an employment TYPE now, not a status — the card still means
        // "how many regular (non part-time) staff", it just reads the right column.
        supabase.from('employees').select('*', { count: 'exact', head: true }).eq('employment_type', 'regular'),
        supabase.from('employees').select('*', { count: 'exact', head: true }).in('employment_status', INACTIVE_STATUSES),
      ])
      return {
        total: total.count ?? 0,
        active: active.count ?? 0,
        regular: regular.count ?? 0,
        inactive: inactive.count ?? 0,
      }
    },
  })
}

function useInvalidateEmployees() {
  const queryClient = useQueryClient()
  return (employeeId?: string) => {
    queryClient.invalidateQueries({ queryKey: LIST_KEY })
    queryClient.invalidateQueries({ queryKey: STATS_KEY })
    queryClient.invalidateQueries({ queryKey: PENDING_KEY })
    if (employeeId) {
      queryClient.invalidateQueries({ queryKey: ['employee-history', employeeId] })
      queryClient.invalidateQueries({ queryKey: ['employee-audit-log', employeeId] })
    }
  }
}

export interface CreateEmployeeInput {
  applicationId?: string
  firstName: string
  middleName?: string
  lastName: string
  gender: string
  birthDate: string
  civilStatus: string
  nationality: string
  phone: string
  email: string
  address: string
  province: string
  city: string
  barangay: string
  departmentId: string
  positionId: string
  employmentType: 'regular' | 'part_time'
  salaryGradeId?: string
  basicSalary: number
  currency: CurrencyCode
  hireDate: string
  employmentStatus: EmploymentStatus
  /** Shift the employee reports on — drives every late/undertime/overtime
   * figure attendance and payroll produce for them. */
  workScheduleId?: string
}

export function useCreateEmployee() {
  const { profile } = useAuth()
  const invalidate = useInvalidateEmployees()
  return useMutation({
    mutationFn: async (input: CreateEmployeeInput) => {
      const { data, error } = await supabase
        .from('employees')
        .insert({
          application_id: input.applicationId || null,
          first_name: input.firstName,
          middle_name: input.middleName || null,
          last_name: input.lastName,
          gender: input.gender,
          birth_date: input.birthDate,
          civil_status: input.civilStatus,
          nationality: input.nationality,
          phone: input.phone,
          email: input.email,
          address: input.address,
          province: input.province,
          city: input.city,
          barangay: input.barangay,
          department_id: input.departmentId,
          position_id: input.positionId,
          employment_type: input.employmentType,
          salary_grade_id: input.salaryGradeId || null,
          basic_salary: input.basicSalary,
          currency: input.currency,
          hire_date: input.hireDate,
          employment_status: input.employmentStatus,
          work_schedule_id: input.workScheduleId || null,
        })
        .select('id, employee_number')
        .single()
      if (error) throw error

      // Employee ID generation/uniqueness is fully automatic (DB sequence
      // default on employees.employee_number) — these two events just record
      // that it happened, matching the spec's flowchart steps 1-4.
      await supabase.from('employee_history').insert([
        { employee_id: data.id, event: 'record_created', actor_id: profile?.id },
        { employee_id: data.id, event: 'employee_id_generated', notes: data.employee_number, actor_id: profile?.id },
        { employee_id: data.id, event: 'department_assigned', actor_id: profile?.id },
        { employee_id: data.id, event: 'position_assigned', actor_id: profile?.id },
      ])
      await supabase.from('audit_logs').insert([
        { actor_id: profile?.id, action: 'Employee Record Saved', table_name: 'employees', record_id: data.id },
        { actor_id: profile?.id, action: 'Employee ID Generated', table_name: 'employees', record_id: data.id, new_data: { employee_number: data.employee_number } },
      ])

      return data
    },
    onSuccess: () => {
      invalidate()
      toast.success('Employee record saved.')
    },
    onError: (error) => toast.error(friendlyEmployeeError(error)),
  })
}

export function useUpdateEmployee() {
  const { profile } = useAuth()
  const invalidate = useInvalidateEmployees()
  return useMutation({
    mutationFn: async ({
      id,
      values,
      notes,
    }: {
      id: string
      values: TablesUpdate<'employees'>
      /** Why this change was made. Recorded against every history row the
       *  change produces, so a transfer explains itself years later instead of
       *  reading as an unexplained department move. */
      notes?: string
    }) => {
      const { error } = await supabase.from('employees').update(values).eq('id', id)
      if (error) throw error

      const historyEvents: { employee_id: string; event: string; actor_id?: string; notes?: string }[] = []
      const auditActions: string[] = []
      if ('department_id' in values) {
        historyEvents.push({ employee_id: id, event: 'department_assigned', actor_id: profile?.id })
        auditActions.push('Department Changed')
      }
      if ('position_id' in values) {
        historyEvents.push({ employee_id: id, event: 'position_assigned', actor_id: profile?.id })
        auditActions.push('Position Changed')
      }
      if ('employment_status' in values) {
        historyEvents.push({ employee_id: id, event: 'status_updated', actor_id: profile?.id })
        auditActions.push('Employment Status Updated')
      }
      const otherKeys = Object.keys(values).filter((k) => !['department_id', 'position_id', 'employment_status'].includes(k))
      if (otherKeys.length > 0 || historyEvents.length === 0) {
        historyEvents.push({ employee_id: id, event: 'information_updated', actor_id: profile?.id })
        auditActions.push('Employee Profile Updated')
      }

      await supabase
        .from('employee_history')
        .insert(historyEvents.map((e) => (notes ? { ...e, notes } : e)))
      await supabase
        .from('audit_logs')
        .insert(auditActions.map((action) => ({ actor_id: profile?.id, action, table_name: 'employees', record_id: id })))
    },
    onSuccess: (_data, { id }) => {
      invalidate(id)
      toast.success('Employee updated')
    },
    onError: (error) => toast.error(friendlyEmployeeError(error)),
  })
}

export function useEmployeeHistory(employeeId: string | undefined) {
  return useQuery({
    queryKey: ['employee-history', employeeId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('employee_history')
        .select('*, actor:profiles(full_name)')
        .eq('employee_id', employeeId as string)
        .order('created_at', { ascending: true })
      if (error) throw error
      return data
    },
    enabled: !!employeeId,
  })
}

export function useEmployeeAuditLog(employeeId: string | undefined) {
  return useQuery({
    queryKey: ['employee-audit-log', employeeId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('audit_logs')
        .select('*, actor:profiles(full_name)')
        .eq('table_name', 'employees')
        .eq('record_id', employeeId as string)
        .order('created_at', { ascending: false })
      if (error) throw error
      return data
    },
    enabled: !!employeeId,
  })
}

// ---- Employee account (create/enable/disable) ----

export function useCreateEmployeeAccount() {
  const invalidate = useInvalidateEmployees()
  return useMutation({
    mutationFn: async ({ employeeId, email, fullName }: { employeeId: string; email: string; fullName: string }) => {
      const { data, error } = await supabase.functions.invoke('create-employee-account', {
        body: { employeeId, email, fullName },
      })
      if (error) throw new Error(await describeFunctionError(error, 'employee account service'))
      if (data?.error) throw new Error(data.error)
      return data as { id: string; email: string; password: string }
    },
    onSuccess: (data, { employeeId }) => {
      invalidate(employeeId)
      toast.success(`Employee account created. They can sign in now with ${data.email} / ${data.password}.`)
    },
    onError: (error) => toast.error(error.message),
  })
}

/** Puts an employee's password back to the documented default.
 *
 * There is no mailbox a reset link could reach on a local stack (see
 * create-employee-account), so "reset" means handing them the default again.
 * The actual change needs the service_role key and happens in the Edge
 * Function; this only reports what to tell them. */
export function useResetEmployeePassword() {
  const invalidate = useInvalidateEmployees()
  return useMutation({
    mutationFn: async ({ employeeId }: { employeeId: string }) => {
      const { data, error } = await supabase.functions.invoke('reset-employee-password', {
        body: { employeeId },
      })
      if (error) throw new Error(await describeFunctionError(error, 'employee account service'))
      if (data?.error) throw new Error(data.error)
      return data as { email: string; password: string }
    },
    onSuccess: (data, { employeeId }) => {
      invalidate(employeeId)
      toast.success(`Password reset. They can sign in with ${data.email} / ${data.password}.`)
    },
    onError: (error) => toast.error(error.message),
  })
}

export function useSetEmployeeAccountStatus() {
  const { profile } = useAuth()
  const invalidate = useInvalidateEmployees()
  return useMutation({
    mutationFn: async ({ profileId, employeeId, status }: { profileId: string; employeeId: string; status: 'active' | 'inactive' }) => {
      const { error } = await supabase.from('profiles').update({ status }).eq('id', profileId)
      if (error) throw error

      await supabase.from('employee_history').insert({
        employee_id: employeeId,
        // Distinct from the 'account_activated' event, which is reserved for the
        // employee's own one-time password-creation moment (see the DB trigger
        // on profiles.activated_at) — this is HR enabling/disabling the login gate.
        event: status === 'active' ? 'account_enabled' : 'account_disabled',
        actor_id: profile?.id,
      })
      await supabase.from('audit_logs').insert({
        actor_id: profile?.id,
        action: status === 'active' ? 'Employee Account Enabled' : 'Employee Account Disabled',
        table_name: 'employees',
        record_id: employeeId,
      })
    },
    onSuccess: (_data, { employeeId, status }) => {
      invalidate(employeeId)
      toast.success(status === 'active' ? 'Account enabled' : 'Account disabled')
    },
    onError: (error) => toast.error(error.message),
  })
}

// ---- Employee documents ----

const ALLOWED_DOCUMENT_FILE_TYPES = [
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'image/jpeg',
  'image/png',
]
const MAX_DOCUMENT_FILE_BYTES = 10 * 1024 * 1024

export function validateEmployeeDocumentFile(file: File): string | null {
  if (!ALLOWED_DOCUMENT_FILE_TYPES.includes(file.type)) {
    return 'Only PDF, DOC, DOCX, JPG, or PNG files are accepted.'
  }
  if (file.size > MAX_DOCUMENT_FILE_BYTES) {
    return 'File is too large — the maximum size is 10 MB.'
  }
  return null
}

async function uploadEmployeeDocumentFile(employeeId: string, file: File): Promise<string> {
  const extension = file.name.split('.').pop()?.toLowerCase() ?? 'pdf'
  const path = `${employeeId}/${crypto.randomUUID()}.${extension}`
  const { error } = await supabase.storage.from('employee-documents').upload(path, file, {
    contentType: file.type,
    upsert: false,
  })
  if (error) throw new Error('Could not upload the document. Please try again.')
  return path
}

export function useEmployeeDocuments(employeeId: string | undefined) {
  return useQuery({
    queryKey: ['employee-documents', employeeId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('employee_documents')
        .select('*, uploader:profiles(full_name)')
        .eq('employee_id', employeeId as string)
        .order('uploaded_at', { ascending: false })
      if (error) throw error
      return data
    },
    enabled: !!employeeId,
  })
}

export function useEmployeeDocumentSignedUrl(path: string | null | undefined) {
  return useQuery({
    queryKey: ['employee-document-signed-url', path],
    queryFn: async () => {
      const { data, error } = await supabase.storage.from('employee-documents').createSignedUrl(path as string, 300)
      if (error) throw error
      return data.signedUrl
    },
    enabled: !!path,
    staleTime: 4 * 60 * 1000,
  })
}

export function useUploadEmployeeDocument() {
  const { profile } = useAuth()
  const queryClient = useQueryClient()
  const invalidate = useInvalidateEmployees()
  return useMutation({
    mutationFn: async ({ employeeId, documentType, file }: { employeeId: string; documentType: string; file: File }) => {
      const path = await uploadEmployeeDocumentFile(employeeId, file)
      const { error } = await supabase.from('employee_documents').insert({
        employee_id: employeeId,
        document_type: documentType,
        file_url: path,
        uploaded_by: profile?.id,
      })
      if (error) throw error

      await supabase.from('employee_history').insert({ employee_id: employeeId, event: 'documents_uploaded', notes: documentType, actor_id: profile?.id })
      await supabase.from('audit_logs').insert({ actor_id: profile?.id, action: 'Document Uploaded', table_name: 'employees', record_id: employeeId })
    },
    onSuccess: (_data, { employeeId }) => {
      queryClient.invalidateQueries({ queryKey: ['employee-documents', employeeId] })
      invalidate(employeeId)
      toast.success('Document uploaded')
    },
    onError: (error) => toast.error(error.message),
  })
}

export function useReplaceEmployeeDocument() {
  const { profile } = useAuth()
  const queryClient = useQueryClient()
  const invalidate = useInvalidateEmployees()
  return useMutation({
    mutationFn: async ({
      documentId,
      employeeId,
      previousPath,
      documentType,
      file,
    }: {
      documentId: string
      employeeId: string
      previousPath: string
      documentType: string
      file: File
    }) => {
      const path = await uploadEmployeeDocumentFile(employeeId, file)
      const { error } = await supabase
        .from('employee_documents')
        .update({ file_url: path, document_type: documentType, uploaded_by: profile?.id, uploaded_at: new Date().toISOString() })
        .eq('id', documentId)
      if (error) throw error

      await supabase.storage.from('employee-documents').remove([previousPath])
      await supabase.from('employee_history').insert({ employee_id: employeeId, event: 'documents_uploaded', notes: `${documentType} (replaced)`, actor_id: profile?.id })
      await supabase.from('audit_logs').insert({ actor_id: profile?.id, action: 'Document Uploaded', table_name: 'employees', record_id: employeeId })
    },
    onSuccess: (_data, { employeeId }) => {
      queryClient.invalidateQueries({ queryKey: ['employee-documents', employeeId] })
      invalidate(employeeId)
      toast.success('Document replaced')
    },
    onError: (error) => toast.error(error.message),
  })
}

export function useDeleteEmployeeDocument() {
  const { profile } = useAuth()
  const queryClient = useQueryClient()
  const invalidate = useInvalidateEmployees()
  return useMutation({
    mutationFn: async ({ documentId, employeeId, path }: { documentId: string; employeeId: string; path: string }) => {
      const { error } = await supabase.from('employee_documents').delete().eq('id', documentId)
      if (error) throw error
      await supabase.storage.from('employee-documents').remove([path])

      await supabase.from('audit_logs').insert({ actor_id: profile?.id, action: 'Document Deleted', table_name: 'employees', record_id: employeeId })
    },
    onSuccess: (_data, { employeeId }) => {
      queryClient.invalidateQueries({ queryKey: ['employee-documents', employeeId] })
      invalidate(employeeId)
      toast.success('Document deleted')
    },
    onError: (error) => toast.error(error.message),
  })
}
