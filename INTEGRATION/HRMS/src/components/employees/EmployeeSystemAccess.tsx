import { Link } from 'react-router-dom'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { usePositionEntitlements } from '@/hooks/useWorkforce'
import { usePosAssignments } from '@/hooks/usePosAccess'
import { useHrAccounts } from '@/hooks/useHrPrivilege'
import { POS_ROLE_LABEL } from '@/lib/posAccess'
import { roleLabel } from '@/lib/workforce'

/**
 * What this employee's position makes them ELIGIBLE for, and what they have
 * actually been GRANTED.
 *
 * These are two different things and the system depends on nobody confusing
 * them. A transfer into POS Manager changes what someone may be given; it does
 * not give it to them. Before this existed, the only way to tell the difference
 * was to open a second screen, so a transfer looked like it had silently failed
 * to do something it was never supposed to do.
 *
 * Nothing here grants anything. It reports state and links to the screen where
 * an Administrator can act, so the grant keeps going through one audited path.
 */

interface Props {
  profileId: string | null
  positionId: string | null
  employmentStatus: string
}

function AccessRow({
  system,
  roleName,
  granted,
  detail,
  grantHref,
  blocked,
}: {
  system: string
  roleName: string
  granted: boolean
  detail?: string
  grantHref: string
  blocked: string | null
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border p-3">
      <div className="flex flex-col gap-1">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-foreground">{roleName}</span>
          <Badge variant="secondary">{system}</Badge>
        </div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
          <span className="text-muted-foreground">
            Eligibility: <span className="font-medium text-foreground">Eligible</span>
          </span>
          <span className="text-muted-foreground">
            Access:{' '}
            {granted ? (
              <span className="font-medium text-foreground">Granted{detail ? ` · ${detail}` : ''}</span>
            ) : (
              <span className="font-medium text-foreground">Not granted</span>
            )}
          </span>
        </div>
      </div>

      {granted ? (
        <Badge variant="success">Active</Badge>
      ) : blocked ? (
        // Eligible on paper, but the workforce state says no. Saying so here
        // saves an Administrator a trip to a screen that would refuse them.
        <span className="text-xs text-muted-foreground">{blocked}</span>
      ) : (
        <Button asChild size="sm" variant="outline">
          <Link to={grantHref}>Grant {system} access</Link>
        </Button>
      )}
    </div>
  )
}

export function EmployeeSystemAccess({ profileId, positionId, employmentStatus }: Props) {
  const { data: entitlements } = usePositionEntitlements()
  const { data: assignments } = usePosAssignments()
  const { data: hrAccounts } = useHrAccounts()

  const entry = (entitlements ?? []).find((e) => e.positionId === positionId)
  const posRoles = entry?.pos ?? []
  const hrmsRoles = entry?.hrms ?? []

  if (!entry || (posRoles.length === 0 && hrmsRoles.length === 0)) {
    return (
      <div className="rounded-lg border border-dashed border-border p-4">
        <p className="text-sm text-muted-foreground">
          This position does not make the employee eligible for POS or HRMS access. Eligibility is
          configured per position under Positions.
        </p>
      </div>
    )
  }

  // No account means nothing can be granted yet, whatever the position allows.
  const blocked =
    !profileId
      ? 'Needs an account first'
      : employmentStatus !== 'active'
        ? 'Employee is not active'
        : null

  const activePos = (assignments ?? []).filter(
    (a) => a.profile_id === profileId && a.status === 'active'
  )
  const hrGrant = (hrAccounts ?? []).find((a) => a.profile_id === profileId)

  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs text-muted-foreground">
        A position decides what someone <em>may</em> be given. It never grants access on its own —
        an Administrator grants it separately, and a transfer out closes it again.
      </p>

      {posRoles.map((role) => {
        const held = activePos.find((a) => a.pos_role === role)
        return (
          <AccessRow
            key={`pos-${role}`}
            system="POS"
            roleName={POS_ROLE_LABEL[role]}
            granted={!!held}
            detail={held?.branch?.name ?? undefined}
            grantHref="/admin/pos-access"
            blocked={blocked}
          />
        )
      })}

      {hrmsRoles.map((role) => (
        <AccessRow
          key={`hrms-${role}`}
          system="HRMS"
          roleName={roleLabel(role)}
          granted={!!hrGrant}
          detail={hrGrant ? roleLabel(hrGrant.hr_role) : undefined}
          grantHref="/admin/accounts"
          blocked={blocked}
        />
      ))}
    </div>
  )
}
