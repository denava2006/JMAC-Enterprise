import { cn } from '@/lib/utils'

/**
 * JMAC Enterprise brand marks — typographic, deliberately.
 *
 * There is no approved JMAC logo asset yet, so the wordmark is set in type
 * rather than drawn. That is a placeholder decision, not a permanent identity:
 * when real artwork exists it replaces the internals here and nothing else
 * changes.
 *
 * The pairing carries the positioning. "JMAC" is the display face at its
 * heaviest with tight tracking — the company. "Enterprise" is the mono face,
 * spaced wide — the system. Read together they say what this actually is: a
 * parent organisation and the platform it runs on, not an HR software vendor.
 *
 * Everything is currentColor, so one component works on the light header, the
 * navy hero and the navy footer without a second variant.
 */

export function JmacWordmark({
  className,
  layout = 'inline',
}: {
  className?: string
  /** `inline` for a header row; `stacked` where the mark is the focal point. */
  layout?: 'inline' | 'stacked'
}) {
  return (
    <span
      className={cn(
        'select-none leading-none text-current',
        layout === 'inline' ? 'inline-flex items-baseline gap-2' : 'inline-flex flex-col gap-1.5',
        className
      )}
    >
      <span className="font-display text-[1.375em] font-extrabold tracking-[-0.03em]">JMAC</span>
      <span
        className={cn(
          'font-mono text-[0.7em] font-medium uppercase tracking-[0.28em] opacity-70',
          // Optical alignment: the wide letter-spacing adds a trailing gap that
          // makes a centred stack look shifted left without this nudge.
          layout === 'stacked' && 'indent-[0.28em]'
        )}
      >
        Enterprise
      </span>
    </span>
  )
}

/**
 * A module either runs or it is on the way. The union is declared rather than
 * inferred so that the day everything is live — today — the 'planned' branches
 * still typecheck and the marker stays available for whatever ships next.
 */
export type ModuleStatus = 'live' | 'planned'

export interface EnterpriseModule {
  code: string
  name: string
  status: ModuleStatus
}

/** The four enterprise modules, in the order work moves through them. */
export const MODULES: readonly EnterpriseModule[] = [
  { code: 'HRMS', name: 'Human Resources', status: 'live' },
  { code: 'POS', name: 'Point of Sale', status: 'live' },
  // Finance stopped being planned when F1–F4 shipped: authorization, master
  // data, the request workflow and procurement through to receiving are all in
  // service. The 'planned' branches below stay because the marker is worth
  // keeping for whatever is genuinely next, not because anything uses it today.
  { code: 'FMS', name: 'Finance', status: 'live' },
  { code: 'ESS', name: 'Employee Self-Service', status: 'live' },
]

/**
 * The module rail — the page's one structural claim.
 *
 * It exists because the honest description of JMAC is not "four features" but
 * "four workspaces on one identity". A row of identical marketing cards would
 * flatten that into a feature list; a rail reads as one structure with four
 * parts, which is what it is.
 *
 * All four are live as of F4. The planned treatment below is kept rather than
 * deleted: it costs a class name, and the next thing to be announced before it
 * ships will want it.
 */
export function ModuleRail({ className, tone = 'dark' }: { className?: string; tone?: 'dark' | 'light' }) {
  const planned = tone === 'dark' ? 'text-white/45' : 'text-muted-foreground'
  const live = tone === 'dark' ? 'text-white' : 'text-foreground'
  const sub = tone === 'dark' ? 'text-white/55' : 'text-muted-foreground'

  return (
    <ul className={cn('grid w-full grid-cols-2 gap-px sm:grid-cols-4', className)} aria-label="Enterprise modules">
      {MODULES.map((m) => (
        <li
          key={m.code}
          className={cn(
            'relative flex flex-col gap-1 px-4 py-3.5 text-left',
            // The hairline rail: one shared rule the cells sit on, drawn per
            // cell so it survives wrapping to two columns on small screens.
            'before:absolute before:inset-x-0 before:top-0 before:h-px',
            m.status === 'planned' ? 'before:opacity-40' : '',
            tone === 'dark' ? 'before:bg-white/25' : 'before:bg-border'
          )}
        >
          <span
            className={cn(
              'font-mono text-sm font-medium tracking-[0.12em]',
              m.status === 'planned' ? planned : live
            )}
          >
            {m.code}
          </span>
          <span className={cn('text-xs leading-snug', sub)}>{m.name}</span>
          {m.status === 'planned' && (
            <span className={cn('font-mono text-[10px] uppercase tracking-[0.18em]', planned)}>Planned</span>
          )}
        </li>
      ))}
    </ul>
  )
}
