import { Reveal } from '@/components/public/Reveal'
import { BranchExplorer } from '@/components/public/BranchExplorer'
import { usePublicBranches } from '@/hooks/usePublicBranches'

/**
 * Where JMAC operates, read from the record rather than retyped here.
 *
 * Open a branch in the back office, give it coordinates and a photograph, mark
 * it for the landing page, and it appears here on the next load. There is no
 * array in this file to remember to edit, and there never was -- what changed is
 * that publication is now an explicit decision rather than a side effect of
 * being operationally active, so a warehouse or an unopened site can exist
 * without becoming a public address.
 *
 * The query reads public_branch_locations, a view carrying name, address,
 * coordinates, image and ordering for branches that are active AND published.
 * The branches table itself stays closed to anonymous visitors, so nothing
 * operational can reach this page even by mistake.
 *
 * The cards-plus-map arrangement this replaced described the same places twice
 * and got worse with every branch added. BranchExplorer shows one location at a
 * time against a map holding all of them, from a single selection.
 */
export function BranchShowcase() {
  const { data: branches = [], isLoading, isError } = usePublicBranches()

  // Nothing published, nothing loading, nothing broken: the section has no
  // subject, so it does not take up a screen saying so.
  if (!isLoading && !isError && branches.length === 0) return null

  return (
    <section id="branches" className="border-t border-border bg-muted/30 py-20 sm:py-24">
      <div className="mx-auto max-w-6xl px-4 sm:px-6">
        <Reveal className="mx-auto max-w-2xl text-center">
          {/* The label stays -- it is JMAC's section convention across the
              landing page. Its colour does not: the brand accent on mist is
              2.83:1, and this is 12px text, not a rule or an icon. teal-ink is
              the same hue at 5.81:1. */}
          <p className="font-mono text-xs uppercase tracking-[0.2em] text-teal-ink">Branches</p>
          <h2 className="mt-3 font-display text-3xl font-bold tracking-[-0.015em] text-foreground sm:text-4xl">
            One platform, every location
          </h2>
          <p className="mt-4 text-muted-foreground">
            Each branch runs its own till, stock and staffing while reporting into the same enterprise
            records. Adding a location does not mean adding a system.
          </p>
        </Reveal>

        <BranchExplorer branches={branches} isLoading={isLoading} isError={isError} />
      </div>
    </section>
  )
}
