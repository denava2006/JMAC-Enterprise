import { motion, useReducedMotion } from 'framer-motion'
// The rear cluster and the branded front building. The filename is missing an
// "r" as supplied; renaming it is a change to an asset the brief said to use
// as-is, so it is imported the way it is spelled on disk.
import backgroundBuildings from '@/assets/landing/backgound-buildings.webp'
import mainBuilding from '@/assets/landing/main-building-base.webp'
import { Link } from 'react-router-dom'
import {
  ArrowRight,
  Building2,
  GraduationCap,
  Users,
  ShieldCheck,
  UserCog,
  Store,
  Wallet,
  IdCard,
  Network,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { JobPostingCard, JobPostingCardSkeleton, NoOpenPositions } from '@/components/public/JobPostingCard'
import { usePublicOpenJobPostings } from '@/hooks/usePublicCareers'
import { JmacWordmark, ModuleRail } from '@/components/Brand'
import { Reveal, RevealGroup, RevealItem, CARD_HOVER } from '@/components/public/Reveal'
import { BranchShowcase } from '@/components/public/BranchShowcase'

/**
 * What the platform actually consists of.
 *
 * Four workspaces and the thing that ties them together. Multi-branch is listed
 * alongside them but described differently on purpose: it is not a fifth module
 * anybody logs into, it is the property the other four share.
 */
const PLATFORM = [
  {
    icon: UserCog,
    code: 'HRMS',
    title: 'Human Resources',
    description:
      'Recruitment through to deployment, then attendance, leave, schedules and payroll on one employee record.',
  },
  {
    icon: Store,
    code: 'POS',
    title: 'Point of Sale',
    description:
      'Tills, payments and receipts at every branch, with stock and its movements held in one place.',
  },
  {
    icon: Wallet,
    code: 'FMS',
    title: 'Finance',
    description:
      'Budgets, vendors and purchase requests, with procurement running from an approved request to a received delivery.',
  },
  {
    icon: IdCard,
    code: 'ESS',
    title: 'My Workspace',
    description:
      'Every employee sees their own attendance, leave, payslips and requests — whatever else they do here.',
  },
]

/**
 * The public landing page.
 *
 * It does two jobs at once, and the copy has to keep them straight: it
 * introduces JMAC Enterprise as the organisation's internal platform, and it is
 * the public entry point for recruitment. What it must never do is describe
 * JMAC as a company that sells HR software — JMAC runs branches and employs
 * people, and this platform is how it runs them.
 */

const WHY_JOIN = [
  {
    icon: Building2,
    title: 'Real operations',
    description:
      'Branch retail, workforce management, and finance under one roof. The work has customers, stock, and shifts attached to it.',
  },
  {
    icon: GraduationCap,
    title: 'Room to grow',
    description:
      'Defined positions and clear progression, whether you are starting on a till or leading a department.',
  },
  {
    icon: Users,
    title: 'One organisation',
    description:
      'Store teams, HR, and finance work from the same records, so what you do is visible to the people it affects.',
  },
  {
    icon: ShieldCheck,
    title: 'Handled properly',
    description:
      'Employment records, schedules, and pay are managed in one system — not spreadsheets passed between desks.',
  },
]

/** The page's easing, kept in one place now that the scene shares it. */
const EASE = [0.22, 1, 0.36, 1] as const

/**
 * The sky the transparent building layers no longer carry.
 *
 * Sampled from the flat photograph at the points where the cut-out layers are
 * fully transparent, so the recreated gradient meets the buildings' own edge
 * haze instead of sitting behind it as a different blue: rgb(2,23,50) at the
 * bottom left through rgb(3,29,60) top left to rgb(11,69,132) at the top right.
 * These are photographic values rather than brand tokens on purpose -- matching
 * --navy here would put a seam along every roofline.
 */
const SKY =
  'linear-gradient(to top right,' +
  ' #021732 0%,' +
  ' #031d3c 30%,' +
  ' #062b58 62%,' +
  ' #093569 82%,' +
  ' #0b4584 100%)'

/**
 * The layered building scene, and why it is two images rather than three.
 *
 * The three supplied assets share one 1672x941 canvas, which is what makes a
 * shared coordinate system free: every layer is the same object-cover crop at
 * the same object-position, so they stay registered at every viewport without a
 * single per-breakpoint pixel value.
 *
 * The two main-building assets are named base and logo, but the names are the
 * wrong way round: main-building-base carries the JMAC ENTERPRISE signage and
 * main-building-logo is the unbranded facade. That matters less than what
 * measuring them showed. They are not one building in two states -- they differ
 * across 27% of their shared area with a mean channel delta of 27, the rooflines
 * sit about 25px apart, and the facades are lit differently. Crossfading them,
 * fast or slow, would swap one building for another in place. So the scene uses
 * the branded one as the single front building, which is the fallback the brief
 * asks for when alignment is materially off.
 *
 * The late brand beat survives anyway, without a second image: the front
 * building's transform and its opacity run on different clocks. The structure
 * rises from 0.16s while the facade is still a quarter visible, and the opacity
 * ramp does not start until 0.45s, so the signage is the last thing in the hero
 * to resolve. Same effect, no ghost.
 */
const SCENE = {
  background: { y: 40, from: 0.3, delay: 0.06, duration: 1.1 },
  main: { y: 64, from: 0.15, delay: 0.16, duration: 1.3, fadeDelay: 0.45, fadeDuration: 0.9 },
} as const

function HeroSection() {
  const still = useReducedMotion()

  // One shared entrance so the stack arrives as a sequence rather than as five
  // independent animations that happen to overlap.
  const rise = (delay: number) => ({
    initial: { opacity: 0, y: still ? 0 : 16 },
    animate: { opacity: 1, y: 0 },
    transition: { duration: still ? 0.2 : 0.6, delay: still ? 0 : delay, ease: EASE },
  })

  // Every decorative layer is the same crop, so the two of them and the overlay
  // stay aligned by construction rather than by tuning.
  const layer =
    'pointer-events-none absolute inset-0 h-full w-full select-none object-cover object-[80%_center] lg:object-[72%_center]'

  return (
    // The header is sticky rather than fixed, so it takes 65px out of the first
    // screen -- h-16 plus its bottom border. Subtracting exactly that is what
    // stops a strip of the next, light section showing under the hero on a tall
    // monitor. svh rather than vh so a mobile browser's collapsing toolbar does
    // not make the section taller than the screen it is meant to fill; the rule
    // starts at sm anyway, because a phone should stay content-driven. It is a
    // minimum, never a height: on a short laptop the hero grows instead of
    // clipping the rail.
    <section className="relative isolate flex flex-col overflow-hidden bg-primary text-primary-foreground sm:min-h-[calc(100svh-65px)]">
      {/* z-0. Painted from the section's own bg-primary outwards, so the hero is
          navy on the first frame and stays correct while the layers decode --
          there is never a moment where the text sits on nothing. */}
      <div aria-hidden="true" className="absolute inset-0 z-0" style={{ backgroundImage: SKY }} />

      {/* z-10 and z-20. The anchor is what keeps the JMAC ENTERPRISE signage in
          frame: it sits at roughly 68-78% across the canvas and 28-48% down, so
          above 1280 the hero is proportionally wider than the artwork and almost
          all of it shows, while narrower screens crop from the left and 80%
          keeps the sign near the middle of what survives.

          Both layers start below their resting position and rise into it. The
          artwork's own sky is transparent, so a layer sitting 64px low leaves no
          seam at the top -- there is nothing up there to leave a gap in. */}
      <motion.img
        src={backgroundBuildings}
        alt=""
        aria-hidden="true"
        draggable={false}
        decoding="async"
        className={`${layer} z-10`}
        initial={{ y: still ? 0 : SCENE.background.y, opacity: still ? 1 : SCENE.background.from }}
        animate={{ y: 0, opacity: 1 }}
        transition={
          still
            ? { duration: 0 }
            : { duration: SCENE.background.duration, delay: SCENE.background.delay, ease: EASE }
        }
      />

      <motion.img
        src={mainBuilding}
        alt=""
        aria-hidden="true"
        draggable={false}
        decoding="async"
        fetchPriority="high"
        className={`${layer} z-20`}
        initial={{ y: still ? 0 : SCENE.main.y, opacity: still ? 1 : SCENE.main.from }}
        animate={{ y: 0, opacity: 1 }}
        transition={
          still
            ? { duration: 0 }
            : {
                // Two clocks on one layer: the building rises from 0.16s, and
                // the facade -- the signage with it -- only starts resolving at
                // 0.45s, so the brand is the last thing to arrive.
                y: { duration: SCENE.main.duration, delay: SCENE.main.delay, ease: EASE },
                opacity: {
                  duration: SCENE.main.fadeDuration,
                  delay: SCENE.main.fadeDelay,
                  ease: EASE,
                },
              }
        }
      />

      {/* Desktop. This photograph is a night shot, and its own sky measures
          rgb(4,31,63) -- darker than --navy at rgb(15,42,67). So the overlay is
          not here to rescue contrast, which is already 16:1 against white on
          the left. It is here to settle the left third to brand navy and then
          get out of the way: by 72%, where the signage is, it is down to a
          quarter, which leaves the lettering at about 178 rather than the 136
          a heavier wash would have left. Text runs out at roughly 54% of the
          width on every desktop size, because the content sits in a centred
          max-w-6xl column -- that is what the 62% stop is measuring against.

          The second gradient is a floor for the module rail. The brightest
          part of the photograph is the lit windows at the bottom right, which
          is exactly where the rail's last labels sit. */}
      <div
        aria-hidden="true"
        className="absolute inset-0 z-30 hidden sm:block"
        style={{
          backgroundImage:
            'linear-gradient(0deg,' +
            ' color-mix(in srgb, var(--navy) 82%, transparent) 0%,' +
            ' color-mix(in srgb, var(--navy) 30%, transparent) 18%,' +
            ' transparent 34%),' +
            'linear-gradient(90deg,' +
            ' color-mix(in srgb, var(--navy) 88%, transparent) 0%,' +
            ' color-mix(in srgb, var(--navy) 84%, transparent) 32%,' +
            ' color-mix(in srgb, var(--navy) 62%, transparent) 54%,' +
            ' color-mix(in srgb, var(--navy) 26%, transparent) 72%,' +
            ' color-mix(in srgb, var(--navy-2) 14%, transparent) 100%)',
        }}
      />

      {/* Mobile: the text takes the full width, so a left-to-right gradient
          would have nothing to fade into, and at this width the crop puts the
          building itself behind the copy rather than beside it. A vertical
          wash instead -- lighter than the old one, because this image is
          already navy and 86% was dimming architecture that was never bright
          to begin with. The signage does not survive at this size, and that is
          the right trade: the words come first. */}
      <div
        aria-hidden="true"
        className="absolute inset-0 z-30 sm:hidden"
        style={{
          backgroundImage:
            'linear-gradient(180deg,' +
            ' color-mix(in srgb, var(--navy) 90%, transparent) 0%,' +
            ' color-mix(in srgb, var(--navy) 86%, transparent) 55%,' +
            ' color-mix(in srgb, var(--navy) 82%, transparent) 100%)',
        }}
      />

      {/* flex-1 so the container takes the height the section was given, and
          justify-between so the extra goes into the gap between the copy and
          the rail rather than into padding under everything. The gap is the
          floor, which is what the rail's old top margin was; free space is
          distributed above it. Nothing here grows to fill the screen -- the
          building and the space around it carry the scale. */}
      <div className="relative z-40 mx-auto flex w-full max-w-6xl flex-1 flex-col justify-between gap-14 px-4 pb-20 pt-16 sm:gap-20 sm:px-6 sm:pb-24 sm:pt-20">
        {/* Left-aligned rather than centred. A centred stack over a
            right-weighted photograph fights it: the text lands on the glass and
            neither reads. Held to ~640px so the lines stay comfortable and the
            building keeps the right of the frame. */}
        <div className="flex max-w-[40rem] flex-col items-start gap-6 text-left">
          {/* The mark, at the size of a mark -- but a step down from the
              centred version, where it had the full width to itself. Here it
              introduces the headline rather than competing with it. */}
          <motion.div {...rise(0.15)}>
            <JmacWordmark
              layout="stacked"
              className="text-[2.25rem] sm:text-[2.75rem] lg:text-[3.25rem]"
            />
          </motion.div>

          <motion.h1
            {...rise(0.25)}
            className="font-display text-2xl font-bold leading-[1.2] tracking-[-0.015em] text-primary-foreground/95 sm:text-3xl lg:text-[2.25rem]"
          >
            One unified enterprise platform connecting workforce, branch operations, point of sale,
            employee self-service, and finance.
          </motion.h1>

          <motion.p
            {...rise(0.35)}
            className="text-base leading-relaxed text-primary-foreground/75 sm:text-lg"
          >
            Every department works in its own secured workspace, on one enterprise identity and one set
            of records.
          </motion.p>

          <motion.div {...rise(0.45)} className="mt-1 flex flex-col gap-3 sm:flex-row">
            <Button asChild size="lg" variant="accent">
              <Link to="/careers">
                Explore Careers
                <ArrowRight className="h-4 w-4" />
              </Link>
            </Button>
            <Button
              asChild
              size="lg"
              variant="outline"
              className="border-white/40 bg-transparent text-white hover:bg-white/10"
            >
              <Link to="/login">Employee Login</Link>
            </Button>
          </motion.div>
        </div>

        {/* The thesis, stated structurally rather than claimed in prose. It
            keeps the full width -- it is the base of the section, and pinning
            it to the text column would leave the right half empty below the
            building. */}
        <motion.div {...rise(0.6)}>
          <ModuleRail tone="dark" />
        </motion.div>
      </div>
    </section>
  )
}

/**
 * The platform, laid out plainly.
 *
 * The page previously asserted "one system, connected operations" and left the
 * reader to take it on faith. This names the four workspaces and says what each
 * one is for, which is the same claim with evidence attached.
 */
function PlatformSection() {
  return (
    <section className="mx-auto max-w-6xl px-4 py-20 sm:px-6 sm:py-24">
      <Reveal className="mx-auto max-w-2xl text-center">
        <p className="font-mono text-xs uppercase tracking-[0.2em] text-accent">The platform</p>
        <h2 className="mt-3 font-display text-3xl font-bold tracking-[-0.015em] text-foreground sm:text-4xl">
          Four workspaces, one organisation
        </h2>
        <p className="mt-4 text-muted-foreground">
          Each is a separate workspace with its own responsibilities and its own access. They share one
          identity, one employee record and one organisational structure.
        </p>
      </Reveal>

      <RevealGroup className="mt-12 grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
        {PLATFORM.map((module) => (
          <RevealItem key={module.code} className="h-full">
            <Card className={`h-full ${CARD_HOVER}`}>
              <CardContent className="flex h-full flex-col gap-3 p-6">
                <div className="flex items-center justify-between">
                  <span className="flex h-11 w-11 items-center justify-center rounded-lg bg-accent/10 text-accent">
                    <module.icon className="h-5 w-5" />
                  </span>
                  <span className="font-mono text-xs tracking-[0.16em] text-muted-foreground">
                    {module.code}
                  </span>
                </div>
                <h3 className="font-display text-lg font-semibold text-foreground">{module.title}</h3>
                <p className="text-sm leading-relaxed text-muted-foreground">{module.description}</p>
              </CardContent>
            </Card>
          </RevealItem>
        ))}
      </RevealGroup>

      {/* Multi-branch, set apart because it is not a fifth module. */}
      <Reveal delay={0.1} className="mt-6">
        <Card className={CARD_HOVER}>
          <CardContent className="flex flex-col gap-4 p-6 sm:flex-row sm:items-center">
            <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-secondary/10 text-secondary">
              <Network className="h-5 w-5" />
            </span>
            <div className="min-w-0 flex-1">
              <h3 className="font-display text-lg font-semibold text-foreground">
                Multi-branch operations
              </h3>
              <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
                Not a fifth module — the property the other four share. Staff are assigned to the branch
                they work at, stock and takings belong to that branch, and what somebody may do follows
                them from one to the next.
              </p>
            </div>
            <Button asChild variant="outline" className="shrink-0 active:scale-[0.98]">
              <a href="#branches">
                See our branches
                <ArrowRight className="h-4 w-4" />
              </a>
            </Button>
          </CardContent>
        </Card>
      </Reveal>
    </section>
  )
}

function WhyJoinSection() {
  return (
    <section className="border-t border-border bg-muted/40 py-20 sm:py-24">
      <div className="mx-auto max-w-6xl px-4 sm:px-6">
        <motion.div
          initial={{ opacity: 0, y: 12 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: '-80px' }}
          transition={{ duration: 0.4 }}
          className="mx-auto max-w-2xl text-center"
        >
          <h2 className="font-display text-3xl font-bold tracking-[-0.015em] text-foreground sm:text-4xl">
            Why work with JMAC
          </h2>
          <p className="mt-3 text-muted-foreground">What the job actually looks like here.</p>
        </motion.div>

        <div className="mt-12 grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
          {WHY_JOIN.map((item, index) => (
            <motion.div
              key={item.title}
              initial={{ opacity: 0, y: 16 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true, margin: '-40px' }}
              transition={{ duration: 0.35, delay: index * 0.05 }}
            >
              <Card className={`h-full ${CARD_HOVER}`}>
                <CardContent className="flex flex-col gap-3 p-5">
                  <div className="flex h-11 w-11 items-center justify-center rounded-lg bg-accent/10 text-accent">
                    <item.icon className="h-5 w-5" />
                  </div>
                  <h3 className="font-display text-base font-semibold text-foreground">{item.title}</h3>
                  <p className="text-sm text-muted-foreground">{item.description}</p>
                </CardContent>
              </Card>
            </motion.div>
          ))}
        </div>
      </div>
    </section>
  )
}

function FeaturedCareersSection() {
  const { data, isLoading, isError } = usePublicOpenJobPostings()
  const featured = data?.slice(0, 3) ?? []

  return (
    <section className="mx-auto max-w-6xl px-4 py-20 sm:px-6 sm:py-24">
      <div className="flex flex-col items-center gap-2 text-center">
        <h2 className="font-display text-3xl font-bold tracking-[-0.015em] text-foreground sm:text-4xl">
          Featured careers
        </h2>
        <p className="max-w-xl text-muted-foreground">
          A few of the current openings across JMAC — see them all on the Careers page.
        </p>
      </div>

      <div className="mt-10">
        {isLoading ? (
          <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {Array.from({ length: 3 }).map((_, i) => (
              <JobPostingCardSkeleton key={i} />
            ))}
          </div>
        ) : isError ? (
          <p className="text-center text-sm text-muted-foreground">Couldn't load open positions right now.</p>
        ) : featured.length === 0 ? (
          <NoOpenPositions />
        ) : (
          <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {featured.map((posting, index) => (
              <JobPostingCard key={posting.id} posting={posting} index={index} />
            ))}
          </div>
        )}
      </div>

      <div className="mt-10 flex justify-center">
        <Button asChild variant="outline">
          <Link to="/careers">
            Browse all careers
            <ArrowRight className="h-4 w-4" />
          </Link>
        </Button>
      </div>
    </section>
  )
}

function AboutSection() {
  return (
    <section id="about" className="border-t border-border bg-muted/40 py-20 sm:py-24">
      <div className="mx-auto max-w-3xl px-4 text-center sm:px-6">
        <motion.div
          initial={{ opacity: 0, y: 12 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: '-80px' }}
          transition={{ duration: 0.4 }}
        >
          <h2 className="font-display text-3xl font-bold tracking-[-0.015em] text-foreground sm:text-4xl">
            About JMAC Enterprise
          </h2>
          <p className="mt-4 text-muted-foreground">
            JMAC Enterprise is the central business platform of JMAC. It connects workforce management, branch
            operations, point-of-sale activities, and financial processes while keeping responsibilities separated
            through role-based access.
          </p>
          <p className="mt-4 text-muted-foreground">
            The platform gives employees, managers, administrators, cashiers, HR teams, and finance personnel
            access to the tools relevant to their work through one secure system.
          </p>
          {/* This used to say Finance was "being brought in next". It is in, so
              the note now says what is actually true of it -- procurement runs
              end to end, and accounting does not exist yet. Being specific about
              the edge is cheaper than being caught claiming the whole thing. */}
          <div className="mx-auto mt-8 flex max-w-lg items-start gap-2.5 rounded-lg border border-border bg-card px-4 py-3 text-left">
            <span className="mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full bg-accent" aria-hidden="true" />
            <p className="font-mono text-xs leading-relaxed text-muted-foreground">
              Human Resources, Point of Sale and Finance are all in service. Finance covers budgets,
              vendors, requests and procurement through to receiving; supplier payment and accounting
              are the next stage of its work.
            </p>
          </div>
        </motion.div>
      </div>
    </section>
  )
}

export default function HomePage() {
  return (
    <div>
      <HeroSection />
      <PlatformSection />
      <BranchShowcase />
      <WhyJoinSection />
      <FeaturedCareersSection />
      {/* About is the last thing the page says, and then the footer. There is
          no closing call to action: Careers, Track Application and Login are in
          the header on every page and again in the footer directly below, so a
          band repeating them would be the third ask on one screen. */}
      <AboutSection />
    </div>
  )
}
