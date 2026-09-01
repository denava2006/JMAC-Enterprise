import { motion } from 'framer-motion'
import { Link } from 'react-router-dom'
import { Building2, Users, CalendarClock, ArrowRight } from 'lucide-react'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { employmentTypeShortLabel } from '@/lib/jobPostingLabels'
import type { PublicJobPosting } from '@/hooks/usePublicCareers'

function formatClosingDate(closingDate: string | null) {
  if (!closingDate) return 'Open until filled'
  return new Date(closingDate + 'T00:00:00').toLocaleDateString('en-PH', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  })
}

export function JobPostingCard({ posting, index = 0 }: { posting: PublicJobPosting; index?: number }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 16 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: '-40px' }}
      transition={{ duration: 0.35, delay: Math.min(index, 6) * 0.05, ease: 'easeOut' }}
      className="h-full"
    >
      <Card className="flex h-full flex-col transition-shadow hover:shadow-md">
        <CardContent className="flex flex-1 flex-col gap-4 p-5">
          <div className="flex flex-col gap-2">
            <div className="flex flex-wrap items-center gap-1.5">
              {posting.department_name && <Badge variant="secondary">{posting.department_name}</Badge>}
              <Badge variant="outline">{employmentTypeShortLabel(posting.employment_type)}</Badge>
            </div>
            <h3 className="font-display text-lg font-semibold leading-snug text-foreground">
              <Link to={`/careers/${posting.id}`} className="hover:text-secondary hover:underline">
                {posting.position_title ?? 'Open Position'}
              </Link>
            </h3>
          </div>

          <p className="line-clamp-3 flex-1 text-sm text-muted-foreground">{posting.description}</p>

          <div className="flex flex-col gap-1.5 border-t border-border pt-3 text-xs text-muted-foreground">
            <span className="flex items-center gap-1.5">
              <Users className="h-3.5 w-3.5" />
              {posting.vacancies} {posting.vacancies === 1 ? 'vacancy' : 'vacancies'}
            </span>
            <span className="flex items-center gap-1.5">
              <CalendarClock className="h-3.5 w-3.5" />
              Closes {formatClosingDate(posting.closing_date)}
            </span>
          </div>

          <Button asChild className="mt-1 w-full group">
            <Link to={`/careers/${posting.id}`}>
              Apply Now
              <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
            </Link>
          </Button>
        </CardContent>
      </Card>
    </motion.div>
  )
}

export function JobPostingCardSkeleton() {
  return (
    <Card className="flex h-full flex-col">
      <CardContent className="flex flex-1 flex-col gap-4 p-5">
        <div className="flex flex-col gap-2">
          <div className="flex gap-1.5">
            <div className="h-5 w-20 animate-pulse rounded-full bg-muted" />
            <div className="h-5 w-16 animate-pulse rounded-full bg-muted" />
          </div>
          <div className="h-5 w-3/4 animate-pulse rounded bg-muted" />
          <div className="h-4 w-1/2 animate-pulse rounded bg-muted" />
        </div>
        <div className="flex flex-1 flex-col gap-2">
          <div className="h-3.5 w-full animate-pulse rounded bg-muted" />
          <div className="h-3.5 w-full animate-pulse rounded bg-muted" />
          <div className="h-3.5 w-2/3 animate-pulse rounded bg-muted" />
        </div>
        <div className="h-10 w-full animate-pulse rounded-md bg-muted" />
      </CardContent>
    </Card>
  )
}

function BuildingIllustration() {
  return (
    <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-muted text-muted-foreground">
      <Building2 className="h-8 w-8" />
    </div>
  )
}

export function NoOpenPositions() {
  return (
    <div className="flex flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-border py-20 text-center">
      <BuildingIllustration />
      <p className="font-display text-lg font-semibold text-foreground">No Open Positions Available</p>
      <p className="max-w-sm text-sm text-muted-foreground">
        We don't have any open roles right now, but new opportunities are posted regularly — check back soon.
      </p>
      <Button asChild variant="outline" className="mt-2">
        <Link to="/">Return Home</Link>
      </Button>
    </div>
  )
}
