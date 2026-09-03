import { MapPin, Navigation } from 'lucide-react'
import { Card, CardContent } from '@/components/ui/card'
import { Reveal, RevealGroup, RevealItem, CARD_HOVER } from '@/components/public/Reveal'

/**
 * Where JMAC operates.
 *
 * Deliberately a curated list rather than a live query. The branches table has
 * SELECT policies for `authenticated` only, so an anonymous visitor reading it
 * would get an empty section — and opening branch records to the public web to
 * fill a marketing panel is a security decision, not a layout one. It is not
 * mine to make inside a landing-page refresh.
 *
 * The shape below is the shape the real thing has: name, address, a label, and
 * an optional coordinate pair. When branches are exposed publicly (a narrow
 * view, or an RPC returning name/address/coordinates only) this array is
 * replaced by that query and nothing else on the page changes. The map slot is
 * already here, sized and captioned, waiting for the same BranchMap component
 * the admin Branches page uses.
 */

export interface ShowcaseBranch {
  name: string
  address: string
  role: string
  /** Present once somebody has located the branch. Drives the future map. */
  latitude?: number
  longitude?: number
}

/** Mirrors the live branch records. Kept truthful rather than padded out with
 *  invented locations — two branches is what JMAC has. */
export const SHOWCASE_BRANCHES: ShowcaseBranch[] = [
  {
    name: 'Main Office',
    address: '123 Ayala Avenue, Makati City',
    role: 'Head office · HR, Finance and enterprise administration',
  },
  {
    name: 'Cavite Branch',
    address: 'Aguinaldo Highway, Dasmariñas, Cavite',
    role: 'Retail branch · Point of sale, stock and receiving',
  },
]

export function BranchShowcase() {
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

        <RevealGroup className="mt-12 grid gap-5 sm:grid-cols-2">
          {SHOWCASE_BRANCHES.map((branch) => (
            <RevealItem key={branch.name}>
              <Card className={`h-full ${CARD_HOVER}`}>
                <CardContent className="flex h-full flex-col gap-3 p-6">
                  <div className="flex items-start gap-3">
                    <span className="mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-accent/10 text-accent">
                      <MapPin className="h-5 w-5" />
                    </span>
                    <div className="min-w-0">
                      <h3 className="font-display text-lg font-semibold text-foreground">{branch.name}</h3>
                      <p className="mt-0.5 text-sm text-muted-foreground">{branch.address}</p>
                    </div>
                  </div>
                  <p className="mt-auto border-t border-border pt-3 font-mono text-xs leading-relaxed tracking-[0.02em] text-muted-foreground">
                    {branch.role}
                  </p>
                </CardContent>
              </Card>
            </RevealItem>
          ))}
        </RevealGroup>

        {/* The map slot. Sized and captioned now so the section is composed
            around it, rather than the map being wedged in later and shifting
            everything. Dropping BranchMap in here is the whole change. */}
        <Reveal delay={0.1} className="mt-6">
          <div className="flex items-center gap-3 rounded-xl border border-dashed border-border bg-card/60 px-5 py-4">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
              <Navigation className="h-4 w-4" />
            </span>
            <p className="text-sm text-muted-foreground">
              An interactive branch map is coming to this section — the component already runs on the
              internal Branches page and needs each branch located before it means anything publicly.
            </p>
          </div>
        </Reveal>
      </div>
    </section>
  )
}
