import { Landmark } from 'lucide-react'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { useAuth } from '@/contexts/AuthContext'
import { ROLE_LABEL } from '@/lib/roles'
import { firstName } from '@/lib/displayName'

/**
 * The Finance portal, before it has anything in it.
 *
 * F1 established who may reach Finance; nothing that finance people actually do
 * exists yet. This page says that plainly rather than showing empty dashboard
 * cards for budgets and payments that have not been built -- a screen promising
 * data it will never load is worse than one admitting the room is empty.
 *
 * It uses the same shell, card, badge and type scale as every other portal,
 * because "Finance looks like JMAC" is easier to keep true from the first
 * screen than to retrofit onto the tenth.
 */
export default function FinanceHomePage() {
  const { profile } = useAuth()

  return (
    <div className="flex flex-col gap-5">
      <div>
        <h1 className="font-display text-2xl font-semibold text-foreground">Finance</h1>
        <p className="text-sm text-muted-foreground">
          Budgets, requests, payments and accounting for JMAC Enterprise.
        </p>
      </div>

      <Card>
        <CardContent className="flex flex-col items-center gap-3 py-14 text-center">
          <span
            aria-hidden="true"
            className="flex h-12 w-12 items-center justify-center rounded-full bg-muted text-muted-foreground"
          >
            <Landmark className="h-6 w-6" />
          </span>
          <div className="flex flex-col items-center gap-1.5">
            <p className="font-medium text-foreground">
              Welcome, {firstName(profile?.full_name)}. Your finance access is set up.
            </p>
            {profile?.role && (
              <Badge variant="secondary">{ROLE_LABEL[profile.role]}</Badge>
            )}
          </div>
          <p className="max-w-md text-sm text-muted-foreground">
            The finance modules are being built. Budgets, purchase requests, reimbursements,
            payments and reports will appear here as each one is released.
          </p>
          <p className="text-xs text-muted-foreground">
            Your own attendance, leave and payslips are in My Workspace.
          </p>
        </CardContent>
      </Card>
    </div>
  )
}
