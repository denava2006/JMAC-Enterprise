import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { BUILD } from '@/lib/buildInfo'

/**
 * A one-line answer to "which build, which environment, which database".
 *
 * Deliberately small and quiet: it sits at the foot of the sidebar, reads as a
 * caption rather than a control, and is safe to have on screen during a
 * presentation. The detail lives behind a click.
 *
 * PROD is stated plainly rather than styled as an alarm — the point is that a
 * screenshot answers the question, and that anything OTHER than PROD is
 * immediately obvious.
 */
export function BuildStamp() {
  const nonProduction = BUILD.environment !== 'PROD'

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label="Build and environment details"
          className={
            nonProduction
              ? 'w-full rounded-md border border-warning/50 bg-warning/10 px-2 py-1 text-left font-mono text-[10px] leading-tight text-warning transition-colors hover:bg-warning/15'
              : 'w-full rounded-md px-2 py-1 text-left font-mono text-[10px] leading-tight text-muted-foreground/70 transition-colors hover:bg-muted hover:text-muted-foreground'
          }
        >
          {BUILD.short}
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72">
        <div className="flex flex-col gap-2">
          <p className="text-sm font-semibold text-foreground">JMAC Enterprise</p>
          <dl className="flex flex-col gap-1.5 font-mono text-xs">
            <Row label="Environment" value={BUILD.environment} />
            <Row label="Build" value={BUILD.commit} />
            <Row label="Supabase" value={BUILD.supabase} />
            <Row label="Origin" value={BUILD.origin} />
            <Row label="Built" value={BUILD.builtAt} />
          </dl>
          {nonProduction && (
            <p className="text-xs text-warning">
              This is not the production build. Anything done here will not appear in production.
            </p>
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="shrink-0 text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-all text-right text-foreground">{value}</dd>
    </div>
  )
}
