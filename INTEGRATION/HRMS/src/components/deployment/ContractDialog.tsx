import * as React from 'react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { usePrepareContract, type JobOfferRecord } from '@/hooks/useDeployment'
import { useSystemSettings } from '@/hooks/useSystemSettings'
import { EMPLOYMENT_TYPE_LABEL } from '@/lib/jobPostingLabels'
import { formatMoney } from '@/lib/currency'
import { generateCompanyPolicies, generateTermsAndConditions } from '@/lib/contractTemplates'

function SummaryField({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="text-sm text-foreground">{value}</p>
    </div>
  )
}

export function ContractDialog({
  open,
  onOpenChange,
  applicationId,
  applicantName,
  positionTitle,
  departmentName,
  offer,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  applicationId: string
  applicantName: string
  positionTitle: string
  departmentName: string
  offer: JobOfferRecord
}) {
  const prepareContract = usePrepareContract()
  const { data: settings } = useSystemSettings()

  const [additionalNotes, setAdditionalNotes] = React.useState('')

  React.useEffect(() => {
    if (open) setAdditionalNotes('')
  }, [open])

  // Policies and terms are generated from the offer rather than retyped per
  // contract — the standard clauses are identical every time, and hand-entering
  // them was how a contract ended up saying "fasf".
  const templateContext = {
    companyName: settings?.company_name || 'JMAC Enterprise',
    employeeName: applicantName,
    positionTitle,
    departmentName,
    employmentType: EMPLOYMENT_TYPE_LABEL[offer.employment_type],
    salary: formatMoney(offer.proposed_salary),
    startDate: offer.start_date ?? '—',
    workingDays: offer.working_days ?? '—',
    workingHours: offer.working_hours ?? '—',
  }
  const companyPolicies = generateCompanyPolicies(templateContext)
  const terms = generateTermsAndConditions(templateContext)

  const onSubmit = () => {
    prepareContract.mutate(
      {
        applicationId,
        offerId: offer.id,
        startDate: offer.start_date,
        companyPolicies,
        terms,
        additionalNotes: additionalNotes.trim() || undefined,
      },
      { onSuccess: () => onOpenChange(false) }
    )
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[85vh] max-w-lg flex-col gap-0 p-0">
        <DialogHeader className="p-6 pb-4">
          <DialogTitle>Prepare Employment Contract</DialogTitle>
          <DialogDescription>Auto-populated from the accepted job offer — review and add terms below.</DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4 overflow-y-auto px-6 py-1">
          <div className="rounded-lg border border-border bg-muted/30 p-3">
            <div className="grid grid-cols-2 gap-3">
              <SummaryField label="Applicant" value={applicantName} />
              <SummaryField label="Position" value={positionTitle} />
              <SummaryField label="Department" value={departmentName} />
              <SummaryField label="Employment Type" value={EMPLOYMENT_TYPE_LABEL[offer.employment_type]} />
              <SummaryField label="Salary" value={formatMoney(offer.proposed_salary)} />
              <SummaryField label="Start Date" value={offer.start_date ?? '—'} />
              <SummaryField label="Working Hours" value={offer.working_hours ?? '—'} />
              <SummaryField label="Working Days" value={offer.working_days ?? '—'} />
            </div>
          </div>

          <div className="rounded-lg border border-border p-3">
            <p className="text-sm font-medium text-foreground">Standard clauses included</p>
            <p className="mt-1 text-xs text-muted-foreground">
              Company Policies (7 sections) and Terms &amp; Conditions (10 sections) are generated from this offer and
              appear in full on the printed contract.
            </p>
            <details className="mt-2">
              <summary className="cursor-pointer text-xs font-medium text-secondary">Preview clauses</summary>
              <div className="mt-2 max-h-48 overflow-y-auto rounded-md bg-muted/40 p-2">
                <pre className="whitespace-pre-wrap font-sans text-[11px] leading-relaxed text-muted-foreground">
                  {terms}
                  {'\n\n'}
                  {companyPolicies}
                </pre>
              </div>
            </details>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="contract_additional_notes">Additional Notes</Label>
            <Textarea
              id="contract_additional_notes"
              value={additionalNotes}
              onChange={(e) => setAdditionalNotes(e.target.value)}
              rows={2}
              placeholder="Optional"
            />
          </div>
        </div>

        <DialogFooter className="p-6 pt-4">
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="button" loading={prepareContract.isPending} onClick={onSubmit}>
            Prepare Contract
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
