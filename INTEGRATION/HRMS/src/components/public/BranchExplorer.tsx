import * as React from 'react'
import { ArrowLeft, ArrowRight } from 'lucide-react'
import { BranchMap } from '@/components/admin/BranchMap'
import { Skeleton } from '@/components/ui/skeleton'
import { branchImageUrl, type PublicBranch } from '@/hooks/usePublicBranches'
import { cn } from '@/lib/utils'

/**
 * One business, several addresses.
 *
 * The section it replaces was a grid of identical cards with a map bolted
 * underneath -- two things describing the same places and agreeing only by
 * accident, and a layout that got worse with every branch added. This shows one
 * location at a time, large, with the map beside it holding every pin so the
 * spread is still legible while the detail is specific.
 *
 * ONE SELECTION, and everything is downstream of it. The photograph, the name,
 * the address, the counter, the progress rule, the emphasised pin and where the
 * map is looking all read `selectedId`. There is no second piece of state for
 * the map to drift out of step with, which is the failure the old card-plus-map
 * arrangement had structurally.
 *
 * The composition is two panels of equal height in dialogue -- image and live
 * map -- over a plinth carrying the identity and the controls. Not a carousel
 * of cards with arrows added: the photograph and the map ARE the visual
 * interest, and everything else is set quietly around them.
 */

/** Prev and next wrap. With three or four locations a visitor who overshoots
 *  should not hit a dead control; the counter tells them where they are. */
function step(index: number, by: number, count: number) {
  return (index + by + count) % count
}

/**
 * Which way the content should arrive from.
 *
 * The arrows have a direction and it is worth expressing; a map pin and a jump
 * from the progress rule do not, so they get the neutral fade rather than a
 * guess. One value of state, set beside the selection that causes it -- not an
 * architecture.
 */
type Direction = 'next' | 'previous' | 'none'

const ENTER: Record<Direction, string> = {
  next: 'motion-safe:animate-[branch-in-next_240ms_ease-out]',
  previous: 'motion-safe:animate-[branch-in-previous_240ms_ease-out]',
  none: 'motion-safe:animate-[branch-in_200ms_ease-out]',
}

export function BranchExplorer({
  branches,
  isLoading,
  isError,
}: {
  branches: PublicBranch[]
  isLoading: boolean
  isError: boolean
}) {
  const [selectedId, setSelectedId] = React.useState<string | null>(null)
  const [direction, setDirection] = React.useState<Direction>('none')

  /** Selecting from the map or the progress rule: no direction to express. */
  const select = React.useCallback((id: string) => {
    setDirection('none')
    setSelectedId(id)
  }, [])

  // The first branch, once there is one -- and re-anchored if the list changes
  // underneath the selection rather than leaving a pointer to a branch that is
  // no longer published.
  React.useEffect(() => {
    if (branches.length === 0) {
      if (selectedId !== null) setSelectedId(null)
      return
    }
    if (!selectedId || !branches.some((b) => b.id === selectedId)) {
      setSelectedId(branches[0].id)
    }
  }, [branches, selectedId])

  const index = Math.max(
    0,
    branches.findIndex((b) => b.id === selectedId),
  )
  const selected = branches[index]
  const many = branches.length > 1

  const go = React.useCallback(
    (by: number) => {
      if (branches.length === 0) return
      setDirection(by > 0 ? 'next' : 'previous')
      setSelectedId(branches[step(index, by, branches.length)].id)
    },
    [branches, index],
  )

  if (isLoading) return <ExplorerSkeleton />

  if (isError) {
    // Public-safe. A visitor can do nothing with a Postgres error and it is not
    // theirs to read; what they can do is ask us.
    return (
      <div className="mt-14 border-t border-border pt-14 text-center">
        <p className="text-sm font-medium text-foreground">
          Our locations are temporarily unavailable.
        </p>
        <p className="mt-1 text-sm text-muted-foreground">
          Please refresh the page, or get in touch and we will point you to your nearest branch.
        </p>
      </div>
    )
  }

  // Nothing published is not an error and not an empty frame with broken
  // arrows. The section's own heading has already been rendered by the caller,
  // which is the right amount to say.
  if (!selected) {
    return (
      <div className="mt-14 border-t border-border pt-14 text-center">
        <p className="text-sm text-muted-foreground">
          Locations will appear here as branches open.
        </p>
      </div>
    )
  }

  return (
    <div className="mt-14">
      {/* THE ROW OWNS THE HEIGHT. Both panels are sized from here and neither
          carries a height of its own at this breakpoint, which is the only way
          their top and bottom edges can be the same two lines. The photograph
          stays the wider of the two -- 1.4fr against 1fr, about 58/41 -- because
          the image is the subject and the map is the context.

          Below lg the row stops being a row: each panel takes its own sensible
          height stacked, and forcing a shared one there would only make both
          of them the wrong shape. */}
      <div className="grid gap-3 lg:h-[clamp(420px,29vw,470px)] lg:grid-cols-[1.4fr_1fr]">
        <BranchMedia branch={selected} branches={branches} direction={direction} />

        {/* min-h-0 so the grid track, not the content, decides. Without it a
            grid item refuses to shrink below its content and the row height
            becomes a negotiation rather than an instruction. */}
        <div className="min-h-0 lg:h-full">
          {/* One map instance for the life of the section. Selecting a branch
              updates its state; it is never torn down and rebuilt, which is
              what makes the movement between locations continuous rather than
              a flash of grey tiles. */}
          <BranchMap
            branches={branches}
            caption={false}
            selectedId={selected.id}
            onSelect={select}
            className="h-[260px] min-h-0 sm:h-[320px] lg:h-full"
          />
        </div>
      </div>

      {/* The plinth. A hairline, then identity on the left and movement on the
          right -- the two things a visitor wants from this section, given the
          full width rather than squeezed into a card. */}
      <div className="mt-6 border-t border-border pt-6">
        <div className="flex flex-col gap-6 sm:flex-row sm:items-end sm:justify-between">
          {/* Name and address move together, keyed on the branch. One block,
              not two animations that could drift a frame apart, and never
              per-word, which would read as a marketing slider rather than a
              location changing. */}
          <div key={selected.id} className={cn('min-w-0', ENTER[direction])}>
            <h3 className="font-display text-2xl font-semibold tracking-[-0.015em] text-foreground sm:text-3xl">
              {selected.name}
            </h3>
            {selected.address ? (
              <p className="mt-1.5 max-w-prose text-sm leading-relaxed text-muted-foreground">
                {selected.address}
              </p>
            ) : (
              <p className="mt-1.5 text-sm text-muted-foreground">
                Address available on request.
              </p>
            )}
          </div>

          {many && (
            <BranchNavigation
              index={index}
              count={branches.length}
              branches={branches}
              onGo={go}
              onSelect={select}
            />
          )}
        </div>
      </div>
    </div>
  )
}

/**
 * The photograph.
 *
 * 16:9 on its own row at small sizes and full height of the pair on large ones,
 * so the image and the map read as one object rather than two stacked widgets.
 */
function BranchMedia({
  branch,
  branches,
  direction,
}: {
  branch: PublicBranch
  branches: PublicBranch[]
  direction: Direction
}) {
  const url = branchImageUrl(branch.image_path)
  const index = branches.findIndex((b) => b.id === branch.id)

  /**
   * The last photograph that actually finished decoding.
   *
   * This is what removes the flash. Keying an image element on its src unmounts
   * the old one and mounts a new one with nothing to paint until the bytes
   * arrive, so the panel blinks to its background mid-transition. Holding the
   * previous image underneath and fading the new one in over it means there is
   * never a frame with no photograph in it.
   *
   * Compared by url rather than by a boolean, so a slow load that resolves
   * after the visitor has already moved on cannot mark the wrong image ready.
   */
  const [painted, setPainted] = React.useState<string | null>(null)
  const ready = painted === url

  // The neighbours, so an arrow press shows a photograph rather than a gap that
  // fills a moment later. Two images, not the whole set.
  const neighbours = React.useMemo(() => {
    if (branches.length < 2) return []
    const at = (i: number) => branches[(i + branches.length) % branches.length]
    return [at(index + 1), at(index - 1)]
      .map((b) => branchImageUrl(b.image_path))
      .filter((u): u is string => !!u && u !== url)
  }, [branches, index, url])

  return (
    // Same radius, same border, same clipping as the map beside it: two panels
    // of one object rather than two components that happen to be adjacent.
    <figure className="relative min-h-0 overflow-hidden rounded-lg border border-border bg-muted lg:h-full">
      {/* The box never changes size, so nothing around it moves while the
          photograph does. */}
      <div className="relative aspect-[16/9] w-full lg:aspect-auto lg:h-full">
        {/* The outgoing photograph, held still underneath while the incoming
            one fades in over it. Decorative and already described by the image
            above it, so it is hidden from assistive tech. It disappears the
            moment `painted` catches up, by which point it is fully covered. */}
        {painted && painted !== url && (
          <img
            src={painted}
            alt=""
            aria-hidden="true"
            className="absolute inset-0 h-full w-full object-cover"
          />
        )}

        {url ? (
          <img
            // Keyed so a new branch gets a fresh element to fade in, while the
            // outgoing one is held below by `painted` until this replaces it.
            key={url}
            src={url}
            alt={`${branch.name} location`}
            // The first thing in the section a visitor looks at, so it is not
            // deferred; the neighbours below are the ones that wait.
            loading="eager"
            decoding="async"
            onLoad={() => setPainted(url)}
            className={cn(
              'absolute inset-0 h-full w-full object-cover',
              // The crossfade itself, plus a scale so small it registers as
              // settling rather than as a zoom.
              'motion-safe:transition-[opacity,transform] motion-safe:duration-[260ms] motion-safe:ease-out',
              ready ? 'opacity-100 motion-safe:scale-100' : 'opacity-0 motion-safe:scale-[1.01]',
              // Reduced motion gets the swap with no transition at all -- but
              // it must still become visible, so opacity is forced on.
              'motion-reduce:opacity-100 motion-reduce:transition-none',
            )}
          />
        ) : (
          <div key={branch.id} className={cn('absolute inset-0', ENTER[direction])}>
            <BranchImageFallback name={branch.name} />
          </div>
        )}
      </div>

      {neighbours.map((src) => (
        <link key={src} rel="preload" as="image" href={src} />
      ))}
    </figure>
  )
}

/**
 * No photograph yet.
 *
 * Deliberate rather than absent: a flat navy field with the wordmark set small
 * and a rule, which reads as a branch whose picture has not been taken rather
 * than as a broken page. No stock photograph stands in -- a generic office
 * interior would be a claim about a place nobody has seen.
 */
function BranchImageFallback({ name }: { name: string }) {
  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-3 bg-primary px-6 py-6 text-center">
      {/* JMAC stays set as a wordmark -- four letters, tracked, which is what
          uppercase is for. */}
      <p className="font-display text-sm font-semibold tracking-[0.18em] text-primary-foreground">
        JMAC
      </p>
      <span aria-hidden className="h-px w-10 bg-primary-foreground/30" />
      {/* The line under it is a sentence about a specific branch, not a label,
          and it was set in caps: 36 characters with their word shapes flattened
          at 11px. Sentence case, and the tracking that went with the caps comes
          off too. */}
      {/* 12px, not 11. It was 11 when it was a tracked all-caps label; as a
          sentence it is body text and reads at body size. */}
      <p className="font-mono text-xs text-primary-foreground/75">
        {name} · photograph to follow
      </p>
    </div>
  )
}

/**
 * Where you are, and how to move.
 *
 * The counter is set in mono because it is a measurement, and the progress is a
 * row of thin rules rather than dots -- squarer, quieter, and it reads as a plan
 * of a row of buildings rather than as a slideshow.
 */
function BranchNavigation({
  index,
  count,
  branches,
  onGo,
  onSelect,
}: {
  index: number
  count: number
  branches: PublicBranch[]
  onGo: (by: number) => void
  onSelect: (id: string) => void
}) {
  return (
    <div className="flex shrink-0 items-center gap-4">
      <div className="flex items-center gap-2" role="group" aria-label="Browse locations">
        <NavButton label="Previous location" onClick={() => onGo(-1)}>
          <ArrowLeft className="h-4 w-4" />
        </NavButton>
        <NavButton label="Next location" onClick={() => onGo(1)}>
          <ArrowRight className="h-4 w-4" />
        </NavButton>
      </div>

      <div className="flex flex-col items-start gap-2">
        <p className="font-mono text-xs tracking-[0.08em] text-muted-foreground" aria-live="polite">
          <span className="text-foreground">{String(index + 1).padStart(2, '0')}</span>
          {' / '}
          {String(count).padStart(2, '0')} locations
        </p>
        <div className="flex items-center gap-1">
          {branches.map((branch, i) => (
            <button
              key={branch.id}
              type="button"
              onClick={() => onSelect(branch.id)}
              aria-label={`Show ${branch.name}`}
              aria-current={i === index ? 'true' : undefined}
              className={cn(
                'h-0.5 w-6 rounded-full transition-colors',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
                i === index ? 'bg-accent' : 'bg-border hover:bg-muted-foreground/50',
              )}
            />
          ))}
        </div>
      </div>
    </div>
  )
}

/** Square, bordered, quiet. A pill here would be the one SaaS shape in a
 *  section built out of rules and rectangles. */
function NavButton({
  label,
  onClick,
  children,
}: {
  label: string
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      className={cn(
        'flex h-10 w-10 items-center justify-center rounded-md border border-border bg-card text-foreground',
        'transition-colors hover:border-accent hover:text-accent',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
      )}
    >
      {children}
    </button>
  )
}

function ExplorerSkeleton() {
  return (
    <div className="mt-14">
      {/* The same row, so the skeleton occupies exactly the space the content
          will and nothing jumps when it arrives. */}
      <div className="grid gap-3 lg:h-[clamp(420px,29vw,470px)] lg:grid-cols-[1.4fr_1fr]">
        <Skeleton className="aspect-[16/9] w-full rounded-lg lg:aspect-auto lg:h-full" />
        <Skeleton className="h-[260px] w-full rounded-lg sm:h-[320px] lg:h-full" />
      </div>
      <div className="mt-6 border-t border-border pt-6">
        <Skeleton className="h-8 w-56" />
        <Skeleton className="mt-2 h-4 w-72" />
      </div>
    </div>
  )
}
