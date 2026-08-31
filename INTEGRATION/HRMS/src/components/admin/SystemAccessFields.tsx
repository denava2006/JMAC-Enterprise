import { cn } from '@/lib/utils'
import {
  NO_ROLE,
  SYSTEM_ACCESS_CHOICES,
  isEmployeeOnly,
  type SystemAccessSelection,
} from '@/lib/workforce'

/**
 * System Access, as offered when a position is created.
 *
 * One role per system, because that is what an ordinary position needs and a
 * radio group makes the "None" default obvious. A position that genuinely
 * needs two roles in one system is still configurable afterwards through the
 * System Access dialog — both write through the same database validator, so
 * neither can accept something the other refuses.
 *
 * Employee Self-Service is shown but not selectable. It is the baseline every
 * employee already has; offering it as a choice would imply a position could
 * withhold it, and would make "no entitlements" ambiguous rather than
 * meaningful.
 */
export function SystemAccessFields({
  value,
  onChange,
  disabled,
}: {
  value: SystemAccessSelection
  onChange: (next: SystemAccessSelection) => void
  disabled?: boolean
}) {
  return (
    <fieldset className="flex flex-col gap-3 rounded-lg border border-border p-3.5" disabled={disabled}>
      <legend className="px-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        System access
      </legend>

      <div className="flex items-start gap-2 rounded-md bg-muted/50 px-3 py-2">
        <span className="mt-px text-accent" aria-hidden="true">
          ✓
        </span>
        <div className="text-xs">
          <p className="font-medium text-foreground">Employee Self-Service</p>
          <p className="text-muted-foreground">Included for every employee.</p>
        </div>
      </div>

      {SYSTEM_ACCESS_CHOICES.map((group) => (
        <div key={group.system} className="flex flex-col gap-1.5">
          <div className="flex items-baseline justify-between">
            <span className="font-mono text-[11px] uppercase tracking-[0.14em] text-muted-foreground">
              {group.system}
            </span>
            <span className="text-xs text-muted-foreground">{group.label}</span>
          </div>

          {group.available ? (
            <div
              role="radiogroup"
              aria-label={`${group.label} role`}
              className="flex flex-wrap gap-1.5"
            >
              {[{ value: NO_ROLE, label: 'None' }, ...group.options].map((option) => {
                const current = value[group.system] ?? null
                const selected = option.value === NO_ROLE ? current === null : current === option.value
                return (
                  <button
                    key={option.value}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    disabled={disabled}
                    onClick={() =>
                      onChange({
                        ...value,
                        [group.system]: option.value === NO_ROLE ? null : option.value,
                      })
                    }
                    className={cn(
                      'rounded-md border px-2.5 py-1 text-xs font-medium transition-colors',
                      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                      'disabled:cursor-not-allowed disabled:opacity-50',
                      selected
                        ? 'border-secondary bg-secondary text-secondary-foreground'
                        : 'border-border bg-card text-foreground hover:bg-muted'
                    )}
                  >
                    {option.label}
                  </button>
                )
              })}
            </div>
          ) : (
            // Finance is in the platform's scope but nothing reads FMS
            // entitlements yet. Offering a control that changes nothing would
            // be a promise the database does not keep.
            <p className="rounded-md border border-dashed border-border px-2.5 py-1.5 text-xs text-muted-foreground">
              Planned — not yet available to configure.
            </p>
          )}
        </div>
      ))}

      <p className="text-xs text-muted-foreground" aria-live="polite">
        {isEmployeeOnly(value)
          ? 'This position will have Employee Self-Service only.'
          : 'Eligibility only. An Administrator still assigns the actual access.'}
      </p>
    </fieldset>
  )
}
