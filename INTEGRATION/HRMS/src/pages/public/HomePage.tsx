import { motion } from 'framer-motion'
import { Link } from 'react-router-dom'
import { ArrowRight, Building2, GraduationCap, Users, ShieldCheck } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { JobPostingCard, JobPostingCardSkeleton, NoOpenPositions } from '@/components/public/JobPostingCard'
import { usePublicOpenJobPostings } from '@/hooks/usePublicCareers'
import { ModuleRail } from '@/components/Brand'

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

function HeroSection() {
  return (
    <section className="relative overflow-hidden bg-primary text-primary-foreground">
      {/* One soft wash for depth. A second blob on the opposite corner is the
          reflexive choice here and adds nothing the first does not. */}
      <div
        className="pointer-events-none absolute -right-32 -top-40 h-[28rem] w-[28rem] rounded-full bg-secondary/25 blur-3xl"
        aria-hidden="true"
      />
      <div className="relative mx-auto max-w-6xl px-4 pb-6 pt-24 sm:px-6 sm:pb-8 sm:pt-28">
        <div className="flex flex-col items-center gap-6 text-center">
          <motion.span
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.4 }}
            className="font-mono text-[11px] font-medium uppercase tracking-[0.24em] text-primary-foreground/60"
          >
            JMAC Enterprise
          </motion.span>

          <motion.h1
            initial={{ opacity: 0, y: 14 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5, delay: 0.05 }}
            className="max-w-4xl font-display text-4xl font-extrabold leading-[1.1] tracking-[-0.02em] sm:text-5xl lg:text-6xl"
          >
            Connecting people, operations, sales, and finance in one unified system.
          </motion.h1>

          <motion.p
            initial={{ opacity: 0, y: 14 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5, delay: 0.1 }}
            className="max-w-2xl text-base text-primary-foreground/75 sm:text-lg"
          >
            Manage your workforce, business operations, point of sale, and financial workflows through one secure
            enterprise platform.
          </motion.p>

          <motion.div
            initial={{ opacity: 0, y: 14 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5, delay: 0.15 }}
            className="flex flex-col gap-3 sm:flex-row"
          >
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
              className="border-white/30 bg-transparent text-white hover:bg-white/10"
            >
              <Link to="/login">Employee Login</Link>
            </Button>
          </motion.div>
        </div>

        {/* The thesis, stated structurally rather than claimed in prose. */}
        <motion.div
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, delay: 0.25 }}
          className="mt-16 sm:mt-20"
        >
          <ModuleRail tone="dark" />
        </motion.div>
      </div>
    </section>
  )
}

function CompanyIntroSection() {
  const facts = [
    { concept: 'Integrated Systems', detail: 'HRMS · POS · FMS' },
    { concept: 'Unified Identity', detail: 'One Account' },
    { concept: 'Operations', detail: 'Multi-Branch' },
    { concept: 'Access Control', detail: 'Role-Based' },
  ]

  return (
    <section className="mx-auto max-w-6xl px-4 py-20 sm:px-6">
      <div className="grid gap-10 md:grid-cols-2 md:items-start">
        <motion.div
          initial={{ opacity: 0, x: -16 }}
          whileInView={{ opacity: 1, x: 0 }}
          viewport={{ once: true, margin: '-80px' }}
          transition={{ duration: 0.4 }}
        >
          <h2 className="font-display text-2xl font-bold tracking-[-0.01em] text-foreground sm:text-3xl">
            One system. Connected operations.
          </h2>
          <p className="mt-4 text-muted-foreground">
            JMAC Enterprise brings together the core functions of the organization into a single platform. Human
            Resources manages the workforce, Point of Sale supports branch operations and sales, and Finance
            connects purchasing, budgeting, and financial management.
          </p>
          <p className="mt-4 text-muted-foreground">
            Each department works in its own secured workspace while sharing one enterprise identity and
            organizational structure.
          </p>
        </motion.div>

        <motion.div
          initial={{ opacity: 0, x: 16 }}
          whileInView={{ opacity: 1, x: 0 }}
          viewport={{ once: true, margin: '-80px' }}
          transition={{ duration: 0.4, delay: 0.1 }}
          className="grid grid-cols-2 gap-4"
        >
          {facts.map((fact) => (
            <Card key={fact.concept}>
              <CardContent className="flex flex-col gap-1.5 p-5">
                <p className="font-display text-base font-bold leading-tight text-foreground">{fact.concept}</p>
                <p className="font-mono text-xs tracking-[0.08em] text-muted-foreground">{fact.detail}</p>
              </CardContent>
            </Card>
          ))}
        </motion.div>
      </div>
    </section>
  )
}

function WhyJoinSection() {
  return (
    <section className="bg-muted/40 py-20">
      <div className="mx-auto max-w-6xl px-4 sm:px-6">
        <motion.div
          initial={{ opacity: 0, y: 12 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: '-80px' }}
          transition={{ duration: 0.4 }}
          className="mx-auto max-w-2xl text-center"
        >
          <h2 className="font-display text-2xl font-bold tracking-[-0.01em] text-foreground sm:text-3xl">
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
              <Card className="h-full">
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
    <section className="mx-auto max-w-6xl px-4 py-20 sm:px-6">
      <div className="flex flex-col items-center gap-2 text-center">
        <h2 className="font-display text-2xl font-bold tracking-[-0.01em] text-foreground sm:text-3xl">
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
    <section id="about" className="bg-muted/40 py-20">
      <div className="mx-auto max-w-3xl px-4 text-center sm:px-6">
        <motion.div
          initial={{ opacity: 0, y: 12 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: '-80px' }}
          transition={{ duration: 0.4 }}
        >
          <h2 className="font-display text-2xl font-bold tracking-[-0.01em] text-foreground sm:text-3xl">
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
          {/* Finance is in the platform's scope, not yet in its software. Saying
              so here is cheaper than being caught claiming otherwise, and it
              matches the "planned" marker on the module rail. */}
          <div className="mx-auto mt-8 flex max-w-md items-start gap-2.5 rounded-lg border border-border bg-card px-4 py-3 text-left">
            <span className="mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full bg-accent" aria-hidden="true" />
            <p className="font-mono text-xs leading-relaxed text-muted-foreground">
              Human Resources and Point of Sale are in service today. Finance is part of the platform's scope and
              is being brought in next.
            </p>
          </div>
        </motion.div>
      </div>
    </section>
  )
}

function ContactSection() {
  return (
    <section id="contact" className="mx-auto max-w-6xl px-4 py-20 sm:px-6">
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={{ once: true, margin: '-80px' }}
        transition={{ duration: 0.4 }}
        className="mx-auto flex max-w-2xl flex-col items-center gap-4 text-center"
      >
        <h2 className="font-display text-2xl font-bold tracking-[-0.01em] text-foreground sm:text-3xl">
          Looking for a role at JMAC?
        </h2>
        <p className="text-muted-foreground">
          Applications are handled through this site. Apply from any open position, then use your reference number
          to follow where it stands.
        </p>
        <div className="mt-2 flex flex-col gap-3 sm:flex-row">
          <Button asChild size="lg">
            <Link to="/careers">
              See open positions
              <ArrowRight className="h-4 w-4" />
            </Link>
          </Button>
          <Button asChild size="lg" variant="outline">
            <Link to="/track">Track an application</Link>
          </Button>
        </div>
      </motion.div>
    </section>
  )
}

export default function HomePage() {
  return (
    <div>
      <HeroSection />
      <CompanyIntroSection />
      <WhyJoinSection />
      <FeaturedCareersSection />
      <AboutSection />
      <ContactSection />
    </div>
  )
}
