import type { ReactNode } from 'react'
import { History, Plus } from 'lucide-react'
import { Link, NavLink, useSearchParams } from 'react-router-dom'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

/**
 * One header for the whole Inventory surface.
 *
 * Stock and Requests used to build their own, and each showed only its own
 * action -- History on Stock, New stock request on Stock Requests -- so both the tab strip
 * and the buttons moved when you switched tabs. On Stock the tab strip was also
 * nested inside the same justify-between row as the buttons, so it slid
 * sideways as the button label changed length.
 *
 * Now both views render this, both actions are always present in the same
 * place, and the tabs sit on their own row that shares a rule with them.
 *
 * The actions stay meaningful rather than merely symmetrical: whichever view
 * does not own an action links to the one that does, so there is still exactly
 * one implementation of history and one of the request dialog.
 */

const TABS = [
  { to: '/pos/stock', label: 'Stock' },
  { to: '/pos/requests', label: 'Stock Requests' },
] as const

interface Props {
  description: string
  branchPicker?: ReactNode
  /** Stock owns the movement history, so it passes a toggle. */
  historyOpen?: boolean
  onToggleHistory?: () => void
  /** Requests owns the compose dialog, so it passes an opener. */
  onNewRequest?: () => void
  newRequestDisabled?: boolean
  /** An Administrator reaches these through the back office instead. */
  showTabs?: boolean
  branchId?: string
}

export function PosInventoryHeader({
  description,
  branchPicker,
  historyOpen,
  onToggleHistory,
  onNewRequest,
  newRequestDisabled,
  showTabs = true,
  branchId,
}: Props) {
  const [params] = useSearchParams()
  const branch = branchId ?? params.get('branch') ?? ''
  const query = branch ? `?branch=${branch}` : ''

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="font-display text-xl font-semibold text-foreground">Inventory</h2>
          <p className="text-sm text-muted-foreground">{description}</p>
        </div>
        {branchPicker}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border">
        <div className="flex items-center gap-1" role="tablist">
          {showTabs &&
            TABS.map((tab) => (
              <NavLink
                key={tab.to}
                to={`${tab.to}${query}`}
                role="tab"
                end
                className={({ isActive }) =>
                  cn(
                    '-mb-px border-b-2 px-4 py-2 text-sm font-medium transition-colors',
                    isActive
                      ? 'border-primary text-foreground'
                      : 'border-transparent text-muted-foreground hover:text-foreground'
                  )
                }
              >
                {tab.label}
              </NavLink>
            ))}
        </div>

        <div className="flex items-center gap-2 pb-2">
          {onToggleHistory ? (
            <Button type="button" variant="outline" size="sm" onClick={onToggleHistory}>
              <History className="h-4 w-4" />
              {historyOpen ? 'Hide history' : 'History'}
            </Button>
          ) : (
            // Movement history lives on Stock. Linking rather than building a
            // second one keeps one implementation, as it should.
            <Button asChild variant="outline" size="sm">
              <Link to={`/pos/stock${query}${query ? '&' : '?'}history=1`}>
                <History className="h-4 w-4" />
                History
              </Link>
            </Button>
          )}

          {onNewRequest ? (
            <Button size="sm" onClick={onNewRequest} disabled={newRequestDisabled}>
              <Plus className="h-4 w-4" />
              New stock request
            </Button>
          ) : (
            <Button asChild size="sm">
              <Link to={`/pos/requests${query}${query ? '&' : '?'}new=1`}>
                <Plus className="h-4 w-4" />
                New stock request
              </Link>
            </Button>
          )}
        </div>
      </div>
    </div>
  )
}
