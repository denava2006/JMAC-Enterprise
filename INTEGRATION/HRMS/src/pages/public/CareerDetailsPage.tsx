import { Link, useParams } from 'react-router-dom'
import { motion } from 'framer-motion'
import { ArrowLeft, Users, CalendarClock, Briefcase, Lock } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { employmentTypeLabel } from '@/lib/jobPostingLabels'
import { usePublicJobPosting, isAcceptingApplications, isPastClosingDate } from '@/hooks/usePublicCareers'

function formatDate(date: string | null) {
  if (!date) return 'Open until filled'
  return new Date(date + 'T00:00:00').toLocaleDateString('en-PH', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  })
}

function DetailsSkeleton() {
  return (
    <div className="mx-auto max-w-3xl px-4 py-16 sm:px-6">
      <Skeleton className="h-5 w-24" />
      <Skeleton className="mt-6 h-9 w-2/3" />
      <div className="mt-3 flex gap-2">
        <Skeleton className="h-6 w-24 rounded-full" />
        <Skeleton className="h-6 w-24 rounded-full" />
      </div>
      <Skeleton className="mt-8 h-40 w-full" />
      <Skeleton className="mt-4 h-24 w-full" />
    </div>
  )
}

function InvalidJobState() {
  return (
    <div className="mx-auto flex max-w-3xl flex-col items-center gap-4 px-4 py-24 text-center sm:px-6">
      <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-muted text-muted-foreground">
        <Briefcase className="h-8 w-8" />
      </div>
      <h1 className="font-display text-2xl font-bold text-foreground">Job posting not found</h1>
      <p className="max-w-md text-muted-foreground">
        This job posting doesn't exist or is no longer available. It may have already been filled or closed.
      </p>
      <Button asChild>
        <Link to="/careers">Browse open positions</Link>
      </Button>
    </div>
  )
}

export default function CareerDetailsPage() {
  const { jobId } = useParams<{ jobId: string }>()
  const { data: posting, isLoading, isError } = usePublicJobPosting(jobId)

  if (isLoading) return <DetailsSkeleton />
  if (isError || !posting) return <InvalidJobState />

  const acceptingApplications = isAcceptingApplications(posting)
  const closingDatePassed = isPastClosingDate(posting.closing_date)

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3 }}
      className="mx-auto max-w-3xl px-4 py-16 sm:px-6"
    >
      <Link
        to="/careers"
        className="inline-flex items-center gap-1.5 text-sm font-medium text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="h-4 w-4" />
        Back to careers
      </Link>

      <div className="mt-6 flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-1.5">
          {posting.department_name && <Badge variant="secondary">{posting.department_name}</Badge>}
          <Badge variant="outline">{employmentTypeLabel(posting.employment_type)}</Badge>
          {!acceptingApplications && <Badge variant="muted">Applications Closed</Badge>}
        </div>
        <h1 className="font-display text-3xl font-bold text-foreground sm:text-4xl">
          {posting.position_title ?? 'Open Position'}
        </h1>
      </div>

      <div className="mt-6 grid grid-cols-2 gap-4 sm:grid-cols-3">
        <Card>
          <CardContent className="flex flex-col gap-1 p-4">
            <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Users className="h-3.5 w-3.5" />
              Vacancies
            </span>
            <span className="font-mono text-lg font-semibold text-foreground">{posting.vacancies}</span>
          </CardContent>
        </Card>
        <Card className="col-span-2 sm:col-span-2">
          <CardContent className="flex flex-col gap-1 p-4">
            <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <CalendarClock className="h-3.5 w-3.5" />
              Closing date
            </span>
            <span className={closingDatePassed ? 'text-lg font-semibold text-destructive' : 'text-lg font-semibold text-foreground'}>
              {formatDate(posting.closing_date)}
            </span>
          </CardContent>
        </Card>
      </div>

      <div className="mt-8 flex flex-col gap-8">
        <div>
          <h2 className="font-display text-lg font-semibold text-foreground">Description</h2>
          <p className="mt-2 whitespace-pre-line text-muted-foreground">{posting.description}</p>
        </div>

        {posting.requirements && (
          <div>
            <h2 className="font-display text-lg font-semibold text-foreground">Requirements</h2>
            <p className="mt-2 whitespace-pre-line text-muted-foreground">{posting.requirements}</p>
          </div>
        )}
      </div>

      <div className="mt-10 border-t border-border pt-8">
        {acceptingApplications ? (
          <Button asChild size="lg" className="w-full sm:w-auto">
            <Link to={`/careers/${posting.id}/apply`}>Apply Now</Link>
          </Button>
        ) : (
          <div className="flex flex-col items-start gap-2">
            <Button size="lg" disabled className="w-full sm:w-auto">
              <Lock className="h-4 w-4" />
              Applications Closed
            </Button>
            <p className="text-sm text-muted-foreground">
              This posting is no longer accepting applications. Check the{' '}
              <Link to="/careers" className="font-medium text-secondary hover:underline">
                careers page
              </Link>{' '}
              for other open roles.
            </p>
          </div>
        )}
      </div>
    </motion.div>
  )
}
