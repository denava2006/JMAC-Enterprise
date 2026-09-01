import * as React from 'react'
import { Search, ChevronLeft, ChevronRight } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/select'
import { JobPostingCard, JobPostingCardSkeleton, NoOpenPositions } from '@/components/public/JobPostingCard'
import { usePublicOpenJobPostings, departmentsFromPostings } from '@/hooks/usePublicCareers'
import { EMPLOYMENT_TYPE_SHORT_LABEL, type EmploymentType } from '@/lib/jobPostingLabels'

const PAGE_SIZE = 9
const ALL = 'all'

export default function CareersPage() {
  const { data: postings, isLoading, isError } = usePublicOpenJobPostings()

  // Derived from the postings on screen rather than fetched. The filter used to
  // load the entire departments table anonymously, which put the company's org
  // structure in front of anyone who opened the page -- and every department
  // worth filtering by is one that already has a visible posting.
  const departments = React.useMemo(() => departmentsFromPostings(postings), [postings])

  const [search, setSearch] = React.useState('')
  const [departmentFilter, setDepartmentFilter] = React.useState(ALL)
  const [employmentTypeFilter, setEmploymentTypeFilter] = React.useState(ALL)
  const [pageIndex, setPageIndex] = React.useState(0)

  const filtered = React.useMemo(() => {
    if (!postings) return []
    const term = search.trim().toLowerCase()
    return postings.filter((p) => {
      if (departmentFilter !== ALL && p.department_name !== departmentFilter) return false
      if (employmentTypeFilter !== ALL && p.employment_type !== employmentTypeFilter) return false
      if (!term) return true
      return (
        (p.department_name ?? '').toLowerCase().includes(term) ||
        (p.position_title ?? '').toLowerCase().includes(term)
      )
    })
  }, [postings, search, departmentFilter, employmentTypeFilter])

  React.useEffect(() => setPageIndex(0), [search, departmentFilter, employmentTypeFilter])

  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE))
  const page = filtered.slice(pageIndex * PAGE_SIZE, pageIndex * PAGE_SIZE + PAGE_SIZE)

  const clearFilters = () => {
    setSearch('')
    setDepartmentFilter(ALL)
    setEmploymentTypeFilter(ALL)
  }

  return (
    <div className="mx-auto max-w-6xl px-4 py-16 sm:px-6">
      <div className="text-center">
        <h1 className="font-display text-3xl font-bold text-foreground sm:text-4xl">Open Positions</h1>
        <p className="mx-auto mt-3 max-w-xl text-muted-foreground">
          Browse current openings across JMAC. Find a role that fits and apply in minutes.
        </p>
      </div>

      <div className="mt-10 flex flex-col gap-3 sm:flex-row sm:items-center">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by department or position..."
            className="pl-9"
            aria-label="Search job postings"
          />
        </div>
        <Select value={departmentFilter} onValueChange={setDepartmentFilter}>
          <SelectTrigger className="sm:w-48">
            <SelectValue placeholder="Department" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All departments</SelectItem>
            {departments.map((name) => (
              <SelectItem key={name} value={name}>
                {name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={employmentTypeFilter} onValueChange={setEmploymentTypeFilter}>
          <SelectTrigger className="sm:w-48">
            <SelectValue placeholder="Employment type" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All types</SelectItem>
            {(Object.entries(EMPLOYMENT_TYPE_SHORT_LABEL) as [EmploymentType, string][]).map(([value, label]) => (
              <SelectItem key={value} value={value}>
                {label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="mt-10">
        {isError ? (
          <div className="flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-border py-20 text-center">
            <p className="font-medium text-foreground">Couldn't load job postings</p>
            <p className="text-sm text-muted-foreground">Please refresh the page or try again shortly.</p>
          </div>
        ) : isLoading ? (
          <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {Array.from({ length: 6 }).map((_, i) => (
              <JobPostingCardSkeleton key={i} />
            ))}
          </div>
        ) : postings && postings.length === 0 ? (
          <NoOpenPositions />
        ) : filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-border py-20 text-center">
            <p className="font-display text-lg font-semibold text-foreground">No matching positions</p>
            <p className="max-w-sm text-sm text-muted-foreground">
              Try a different search term or clear your filters to see all open roles.
            </p>
            <Button variant="outline" onClick={clearFilters}>
              Clear filters
            </Button>
          </div>
        ) : (
          <>
            <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
              {page.map((posting, index) => (
                <JobPostingCard key={posting.id} posting={posting} index={index} />
              ))}
            </div>

            {pageCount > 1 && (
              <div className="mt-8 flex items-center justify-between text-sm text-muted-foreground">
                <span>
                  Page {pageIndex + 1} of {pageCount}
                </span>
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setPageIndex((p) => Math.max(0, p - 1))}
                    disabled={pageIndex === 0}
                  >
                    <ChevronLeft className="h-4 w-4" />
                    Previous
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setPageIndex((p) => Math.min(pageCount - 1, p + 1))}
                    disabled={pageIndex >= pageCount - 1}
                  >
                    Next
                    <ChevronRight className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}
