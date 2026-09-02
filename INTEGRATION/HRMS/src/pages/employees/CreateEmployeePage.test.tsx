/** Create Employee — the submit boundary.
 *
 * Production logs showed three Finance onboardings that never produced a single
 * request. That is the failure mode this file exists to make impossible: a Save
 * button that looks live, does nothing, and says nothing.
 *
 * Two things are locked down here. A valid form of each Finance role reaches
 * the creation mutation exactly once — Finance must not be a special case, and
 * the Finance department and its three positions arrived after this form was
 * written. And every gate that can stop a submit now tells the person which
 * field stopped it, on the step where that field lives.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

const createEmployee = vi.fn()
const createAccount = vi.fn()
const uploadDocument = vi.fn()
const navigate = vi.fn()
const errorToast = vi.fn()

const FINANCE_DEPT = 'dept-finance'
const OPS_DEPT = 'dept-ops'

const POSITIONS = [
  { id: 'pos-fin-staff', title: 'Finance Staff', department_id: FINANCE_DEPT },
  { id: 'pos-fin-manager', title: 'Finance Manager', department_id: FINANCE_DEPT },
  { id: 'pos-accountant', title: 'Accountant', department_id: FINANCE_DEPT },
  { id: 'pos-cashier', title: 'Cashier', department_id: OPS_DEPT },
]

/** Radix's Select cannot be driven in jsdom, and this file is testing the
 *  form's submit path rather than Radix. A native select with the same props
 *  contract lets a test set a value the way a person would. */
vi.mock('@/components/ui/select', () => {
  type Node = React.ReactElement<{ children?: React.ReactNode; value?: string }>
  const collect = (children: React.ReactNode, out: React.ReactNode[] = []): React.ReactNode[] => {
    React.Children.forEach(children, (child) => {
      if (!React.isValidElement(child)) return
      const node = child as Node
      if (node.props && 'value' in node.props && typeof node.props.value === 'string') out.push(node)
      else if (node.props?.children) collect(node.props.children, out)
    })
    return out
  }
  return {
    Select: ({
      value,
      onValueChange,
      disabled,
      children,
    }: {
      value?: string
      onValueChange?: (v: string) => void
      disabled?: boolean
      children?: React.ReactNode
    }) => (
      <select
        value={value ?? ''}
        disabled={disabled}
        onChange={(e) => onValueChange?.(e.target.value)}
      >
        <option value="" />
        {collect(children).map((node, i) => {
          const item = node as Node
          return (
            <option key={i} value={item.props.value}>
              {String(item.props.children)}
            </option>
          )
        })}
      </select>
    ),
    SelectTrigger: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
    SelectValue: () => null,
    SelectContent: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
    SelectItem: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
  }
})

/** AddressFields owns a province/city/barangay cascade backed by its own
 *  queries. This file is not testing that cascade, so it stands in as four
 *  plain inputs over the same value/onChange contract. */
vi.mock('@/components/AddressFields', () => ({
  EMPTY_ADDRESS: { province: '', city: '', barangay: '', street: '' },
  formatAddress: (v: Record<string, string>) =>
    [v.street, v.barangay, v.city, v.province].filter(Boolean).join(', '),
  AddressFields: ({
    value,
    onChange,
  }: {
    value: { province: string; city: string; barangay: string; street: string }
    onChange: (next: { province: string; city: string; barangay: string; street: string }) => void
  }) => (
    <div>
      {(['province', 'city', 'barangay', 'street'] as const).map((part) => (
        <div key={part}>
          <label htmlFor={'addr-' + part}>{part}</label>
          <input
            id={'addr-' + part}
            value={value[part]}
            onChange={(e) => onChange({ ...value, [part]: e.target.value })}
          />
        </div>
      ))}
    </div>
  ),
}))

vi.mock('react-router-dom', () => ({
  useNavigate: () => navigate,
  useSearchParams: () => [new URLSearchParams(), vi.fn()],
  Link: ({ children }: { children?: React.ReactNode }) => <a href="#">{children}</a>,
}))

vi.mock('@/components/ui/sonner', () => ({
  toast: { error: errorToast, success: vi.fn() },
}))

vi.mock('@/hooks/useDepartments', () => ({
  useDepartments: () => ({
    data: [
      { id: FINANCE_DEPT, name: 'Finance' },
      { id: OPS_DEPT, name: 'Store Operations' },
    ],
  }),
}))

vi.mock('@/hooks/usePositions', () => ({ usePositions: () => ({ data: POSITIONS }) }))

vi.mock('@/hooks/useSalaryGrades', () => ({
  useSalaryGrades: () => ({
    data: [{ id: 'grade-1', name: 'SG-1', employment_type: 'regular', min_salary: 0, max_salary: 100000 }],
  }),
}))

vi.mock('@/hooks/useWorkSchedules', () => ({
  useWorkSchedules: () => ({
    data: [
      {
        id: 'sched-1',
        name: 'Office Hours',
        employment_type: 'regular',
        start_time: '08:00',
        end_time: '17:00',
        working_days: [1, 2, 3, 4, 5],
        break_minutes: 60,
      },
    ],
  }),
}))

vi.mock('@/hooks/useEmployees', () => ({
  useApplicationForEmployeeCreation: () => ({ data: undefined, isLoading: false }),
  useGovernmentIdViewer: () => ({ mutate: vi.fn() }),
  useCreateEmployee: () => ({ mutateAsync: createEmployee, isPending: false }),
  useCreateEmployeeAccount: () => ({ mutateAsync: createAccount, isPending: false }),
  useUploadEmployeeDocument: () => ({ mutateAsync: uploadDocument, isPending: false }),
  validateEmployeeDocumentFile: () => null,
}))

const { default: CreateEmployeePage } = await import('@/pages/employees/CreateEmployeePage')

/** Set whichever select offers this option. Values are unique, so this is
 *  order-independent — no counting comboboxes. */
function choose(optionValue: string) {
  const select = Array.from(document.querySelectorAll('select')).find((el) =>
    Array.from(el.options).some((o) => o.value === optionValue)
  )
  if (!select) throw new Error(`No select offers "${optionValue}"`)
  fireEvent.change(select, { target: { value: optionValue } })
}

/** By id rather than by label text: the ids are the field names the schema
 *  uses, so a test breaks when a field is renamed rather than when its wording
 *  changes ("Contact Number" is the phone field). */
function type(fieldId: string, value: string) {
  const field = document.getElementById(fieldId)
  if (!field) throw new Error(`No field with id "${fieldId}"`)
  fireEvent.change(field, { target: { value } })
}

function clickButton(name: string | RegExp) {
  fireEvent.click(screen.getByRole('button', { name }))
}

/** goNext validates before it advances, so the step change lands a microtask
 *  later. Two Next clicks in the same tick would both act on the same step. */
async function clickNext() {
  clickButton(/next/i)
  await act(async () => {})
}

/** Step 1 — everything the schema requires about the person. */
function fillPersonalInformation() {
  type('firstName', 'ZZ')
  type('lastName', 'Finance Tester')
  choose('Female')
  type('birthDate', '1995-04-01')
  choose('Single')
  type('nationality', 'Filipino')
  type('phone', '09171234567')
  type('email', 'zz.finance@jmac-test.invalid')
  type('addr-province', 'Metro Manila')
  type('addr-city', 'Quezon City')
  type('addr-barangay', 'Barangay Holy Spirit')
  type('addr-street', '12 Sample Street')
}

/** Step 2 — the job, for a given Finance position. */
function fillEmployment(positionId: string) {
  choose(FINANCE_DEPT)
  choose(positionId)
  choose('regular')
  choose('grade-1')
  type('basicSalary', '30000')
  choose('sched-1')
  // employmentStatus has no control: a new hire is active, and the Review step
  // shows it rather than asking.
}

beforeEach(() => {
  createEmployee.mockResolvedValue({ id: 'emp-created', employee_number: 'EMP-2026-0006' })
  createAccount.mockResolvedValue({ id: 'user-1', email: 'zz.finance@jmac-test.invalid' })
})

afterEach(() => {
  cleanup()
  createEmployee.mockReset()
  createAccount.mockReset()
  uploadDocument.mockReset()
  navigate.mockReset()
  errorToast.mockReset()
})

describe('a valid Finance employee reaches the creation mutation', () => {
  it.each([
    ['Finance Staff', 'pos-fin-staff'],
    ['Finance Manager', 'pos-fin-manager'],
    ['Accountant', 'pos-accountant'],
  ])('%s', async (_label, positionId) => {
    render(<CreateEmployeePage />)

    fillPersonalInformation()
    await clickNext()

    fillEmployment(positionId)
    await clickNext()
    await clickNext()

    clickButton(/create employee/i)

    await waitFor(() => expect(createEmployee).toHaveBeenCalledTimes(1))
    expect(createEmployee.mock.calls[0][0]).toMatchObject({
      departmentId: FINANCE_DEPT,
      positionId,
      employmentStatus: 'active',
      workScheduleId: 'sched-1',
    })
    // No validation complaint on a form that is actually valid.
    expect(errorToast).not.toHaveBeenCalled()
  })

  it('creates the employee exactly once even if Save is pressed twice', async () => {
    render(<CreateEmployeePage />)
    fillPersonalInformation()
    await clickNext()
    fillEmployment('pos-fin-staff')
    await clickNext()
    await clickNext()

    clickButton(/create employee/i)
    clickButton(/create employee/i)

    await waitFor(() => expect(createEmployee).toHaveBeenCalledTimes(1))
  })

  it('does not create a second employee when the invitation fails', async () => {
    // The record was saved; only the setup email failed. Pressing Save again
    // used to produce a duplicate person.
    createAccount.mockRejectedValue(new Error('SMTP unavailable'))
    render(<CreateEmployeePage />)
    fillPersonalInformation()
    await clickNext()
    fillEmployment('pos-fin-staff')
    await clickNext()
    await clickNext()

    clickButton(/create employee/i)
    await waitFor(() => expect(errorToast).toHaveBeenCalled())

    expect(createEmployee).toHaveBeenCalledTimes(1)
    // Said plainly, and the person is taken to the record that does exist.
    expect(String(errorToast.mock.calls[0][0])).toMatch(/saved/i)
    expect(navigate).toHaveBeenCalledWith('/dashboard/employees/emp-created')
  })
})

describe('nothing fails silently', () => {
  it('names the missing field instead of doing nothing when Next is pressed', async () => {
    render(<CreateEmployeePage />)

    await clickNext()

    await waitFor(() => expect(errorToast).toHaveBeenCalled())
    expect(String(errorToast.mock.calls[0][0])).toMatch(/first name/i)
    expect(createEmployee).not.toHaveBeenCalled()
  })

  it('reports the first missing employment field, not a generic complaint', async () => {
    render(<CreateEmployeePage />)
    fillPersonalInformation()
    await clickNext()

    await clickNext()

    await waitFor(() => expect(errorToast).toHaveBeenCalled())
    expect(String(errorToast.mock.calls[0][0])).toMatch(/department/i)
  })

  it('refuses an under-age hire with the reason, not silence', async () => {
    render(<CreateEmployeePage />)
    fillPersonalInformation()
    type('birthDate', new Date().toISOString().slice(0, 10))

    await clickNext()

    await waitFor(() => expect(errorToast).toHaveBeenCalled())
    expect(String(errorToast.mock.calls[0][0])).toMatch(/18 years old/i)
  })

  it('lets a failed creation be retried, and does create on the retry', async () => {
    // The opposite risk to the invitation case: nothing was written, so the
    // resume guard must NOT skip creation the second time.
    createEmployee.mockRejectedValueOnce(new Error('network down'))
    render(<CreateEmployeePage />)
    fillPersonalInformation()
    await clickNext()
    fillEmployment('pos-fin-staff')
    await clickNext()
    await clickNext()

    clickButton(/create employee/i)
    await act(async () => {})
    expect(navigate).not.toHaveBeenCalled()

    clickButton(/create employee/i)
    await waitFor(() => expect(createEmployee).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/dashboard/employees/emp-created'))
  })
})
