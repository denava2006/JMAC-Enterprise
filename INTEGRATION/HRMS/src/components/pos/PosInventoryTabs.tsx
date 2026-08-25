import { NavLink, useSearchParams } from 'react-router-dom'
import { cn } from '@/lib/utils'

/**
 * Stock and Requests, as one Inventory surface.
 *
 * They are two routes rather than a `?tab=` toggle, so deep links, the back
 * button and bookmarks all work — but they share a tab strip so they read as
 * one section. The manager sidebar was already seven items before Phase 8;
 * requests are *about* stock, so they belong beside it rather than adding an
 * eighth top-level entry.
 *
 * The `?branch=` selection carries across, because a manager looking at one
 * branch's stock and then its requests means the same branch.
 */
const TABS = [
  { to: '/pos/stock', label: 'Stock' },
  { to: '/pos/requests', label: 'Requests' },
] as const

export function PosInventoryTabs() {
  const [params] = useSearchParams()
  const branch = params.get('branch')
  const suffix = branch ? `?branch=${branch}` : ''

  return (
    <div className="flex items-center gap-1 border-b border-border" role="tablist">
      {TABS.map((tab) => (
        <NavLink
          key={tab.to}
          to={`${tab.to}${suffix}`}
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
  )
}
