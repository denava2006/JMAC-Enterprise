import { MapPin } from 'lucide-react'
import { Card, CardContent } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { Reveal, RevealGroup, RevealItem, CARD_HOVER } from '@/components/public/Reveal'
import { BranchMap } from '@/components/admin/BranchMap'
import { usePublicBranches } from '@/hooks/usePublicBranches'

/**
 * Where JMAC operates, read from the record rather than retyped here.
 *
 * The cards and the map come from one query. Keeping a hardcoded list beside a
 * live map is how the two end up disagreeing, and the one that is wrong is
 * always the one nobody is looking at. Open a branch in the back office, give
 * it coordinates, and it appears here on the next load; archive it and it
 * leaves. There is no second place to remember to edit.
 *
 * The query reads public_branch_locations, a view carrying name, address and
 * coordinates for active branches only. The branches table itself stays closed
 * to anonymous visitors, so nothing operational can reach this page even by
 * mistake.
 */
export function BranchShowcase() {
  const { data: branches = [], isLoading, isError } = usePublicBranches()

  const located = branches.filter((b) => b.latitude != null && b.longitude != null)

  return (
    <section id="branches" className="border-t border-border bg-muted/30 py-20 sm:py-24">
      <div className="mx-auto max-w-6xl px-4 sm:px-6">
        <Reveal className="mx-auto max-w-2xl text-center">
          <p className="font-mono text-xs uppercase tracking-[0.2em] text-accent">Branches</p>
          <h2 className="mt-3 font-display text-3xl font-bold tracking-[-0.015em] text-foreground sm:text-4xl">
            One platform, every location
          </h2>
          <p className="mt-4 text-muted-foreground">
            Each branch runs its own till, stock and staffing while reporting into the same enterprise
            records. Adding a location does not mean adding a system.
          </p>
        </Reveal>

        {isLoading ? (
          <div className="mt-12 flex flex-col gap-5">
            <div className="grid gap-5 sm:grid-cols-2">
              <Skeleton className="h-32 w-full rounded-xl" />
              <Skeleton className="h-32 w-full rounded-xl" />
            </div>
            <Skeleton className="h-[280px] w-full rounded-lg sm:h-[400px]" />
          </div>
        ) : isError ? (
          /* Public-safe: it says the section could not load and stops there.
             A visitor can do nothing with a Postgres error, and it is not
             theirs to read. */
          <Reveal className="mt-12">
            <Card>
              <CardContent className="py-12 text-center">
                <p className="text-sm font-medium text-foreground">
                  Our locations could not be loaded just now.
                </p>
                <p className="mt-1 text-sm text-muted-foreground">
                  Please refresh the page, or get in touch and we will point you to your nearest
                  branch.
                </p>
              </CardContent>
            </Card>
          </Reveal>
        ) : branches.length === 0 ? (
          <Reveal className="mt-12">
            <Card>
              <CardContent className="py-12 text-center">
                <p className="text-sm text-muted-foreground">
                  Locations will appear here as branches are added.
                </p>
              </CardContent>
            </Card>
          </Reveal>
        ) : (
          <>
            <RevealGroup className="mt-12 grid gap-5 sm:grid-cols-2">
              {branches.map((branch) => {
                const mapped = branch.latitude != null && branch.longitude != null
                return (
                  <RevealItem key={branch.id}>
                    <Card className={`h-full ${CARD_HOVER}`}>
                      <CardContent className="flex h-full flex-col gap-3 p-6">
                        <div className="flex items-start gap-3">
                          <span className="mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-accent/10 text-accent">
                            <MapPin className="h-5 w-5" />
                          </span>
                          <div className="min-w-0">
                            <h3 className="font-display text-lg font-semibold text-foreground">
                              {branch.name}
                            </h3>
                            {branch.address && (
                              <p className="mt-0.5 text-sm text-muted-foreground">{branch.address}</p>
                            )}
                          </div>
                        </div>
                        {/* A branch with no coordinates still gets a card. It is
                            listed, it is simply not pinned -- which is the
                            honest rendering of "nobody has located it yet"
                            rather than quietly dropping a real location. */}
                        {!mapped && (
                          <p className="mt-auto border-t border-border pt-3 font-mono text-xs tracking-[0.02em] text-muted-foreground">
                            Location not mapped yet
                          </p>
                        )}
                      </CardContent>
                    </Card>
                  </RevealItem>
                )
              })}
            </RevealGroup>

            <Reveal delay={0.1} className="mt-6">
              <BranchMap branches={branches} variant="public" caption={false} />
              <p className="mt-2 text-center text-xs text-muted-foreground">
                {located.length === 0
                  ? 'None of our branches are pinned yet — the addresses above are the ones to use.'
                  : located.length === branches.length
                    ? 'Select a pin for the address. Scroll-zoom is off; use the buttons or Ctrl and the wheel.'
                    : `${located.length} of ${branches.length} locations pinned.`}
              </p>
            </Reveal>
          </>
        )}
      </div>
    </section>
  )
}
