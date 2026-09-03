import { LogOut, User } from 'lucide-react'
import { useLocation, useNavigate } from 'react-router-dom'
import { useAuth } from '@/contexts/AuthContext'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { CalendarWidget } from '@/components/layout/CalendarWidget'
import { ClockWidget } from '@/components/layout/ClockWidget'
import { useMyEmployeeRecord } from '@/hooks/useEmployeePortal'
import { availablePortals, portalForPath } from '@/lib/portals'
import { roleBadge } from '@/lib/roleBadge'

/**
 * Two letters for the avatar.
 *
 * Null-safe because an account can genuinely have no full_name yet -- an
 * invited user who has not completed their profile -- and the previous version
 * called .split on it and took the whole header down with a TypeError. An
 * account with no name at all falls back to the person icon.
 */
function initials(name: string | null | undefined) {
  return (name ?? '')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((p) => p[0])
    .slice(0, 2)
    .join('')
    .toUpperCase()
}


export function Navbar() {
  const { profile, posAccess, signOut } = useAuth()
  const { data: myEmployee } = useMyEmployeeRecord()
  const navigate = useNavigate()
  const { pathname } = useLocation()
  const isEmployee = profile?.role === 'employee'

  // Only shown to accounts that actually hold more than one portal -- a
  // switcher offering a single destination is just a menu item that does
  // nothing. It lists only what this account may reach, so it can never be the
  // route into a portal the guards would refuse.
  const portals = availablePortals(profile?.role, posAccess, !!profile?.employee_id)
  const currentPortal = portalForPath(pathname)
  const badge = roleBadge(profile?.role, posAccess)

  return (
    // The page title used to sit here, duplicating the heading every page
    // already renders below it. Only the account/clock cluster remains.
    <header className="flex h-16 shrink-0 items-center justify-end border-b border-border bg-card px-6 print:hidden">
      <div className="flex items-center gap-3">
        <CalendarWidget />
        <ClockWidget />
        <div className="h-8 w-px bg-border" />

        <DropdownMenu>
          <DropdownMenuTrigger className="flex items-center gap-2.5 rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2">
            {/*
              One role indicator, and it is the badge.

              This block used to say it three times over: the name was rendered
              through a helper that prefixed the role to it ("HR Staff Chan"),
              the line under it repeated the role in full ("HR Staff"), and then
              the badge said it a third time ("HRS"). The name is now just the
              name, and the full wording lives on the badge's tooltip and its
              accessible label, plus the account menu below.

              The second line survives only for employees, and only because
              position and department are their actual job -- not another way of
              writing the role. A Cashier reads "Cashier · Operations" there and
              POSC on the badge, which are two different facts.
            */}
            <div className="hidden text-right leading-tight sm:block">
              <p className="text-sm font-medium text-foreground">
                {profile?.full_name || profile?.email}
              </p>
              {isEmployee && myEmployee && (
                <p className="text-xs text-muted-foreground">
                  {[myEmployee.positions?.title, myEmployee.departments?.name]
                    .filter(Boolean)
                    .join(' · ')}
                </p>
              )}
            </div>
            {/* Which hat you are wearing, at a glance -- the thing you cannot
                tell from a name and an avatar when one person holds several
                portals. Display only: it reports authorization, never grants
                it. The title carries the full wording for anyone who does not
                already know the abbreviations. */}
            {badge && (
              <span
                title={badge.full}
                aria-label={`Signed in as ${badge.full}`}
                className="hidden rounded-md border border-border bg-muted px-1.5 py-0.5 text-[10px] font-semibold tracking-wide text-muted-foreground sm:inline"
              >
                {badge.short}
              </span>
            )}
            <Avatar>
              <AvatarFallback>
                {initials(profile?.full_name || profile?.email) || <User className="h-4 w-4" />}
              </AvatarFallback>
            </Avatar>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {/* The one place the role is spelled out. The top bar shows the
                abbreviation; anybody who does not recognise it opens this. */}
            <DropdownMenuLabel>
              <span className="block truncate">{profile?.email}</span>
              {badge && (
                <span className="mt-0.5 block text-xs font-normal text-muted-foreground">
                  {badge.full}
                </span>
              )}
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            {portals.length > 1 && (
              <>
                <DropdownMenuLabel>Switch workspace</DropdownMenuLabel>
                {portals.map((portal) => (
                  <DropdownMenuItem
                    key={portal.key}
                    disabled={portal.key === currentPortal}
                    onClick={() => navigate(portal.path)}
                  >
                    {portal.label}
                  </DropdownMenuItem>
                ))}
                <DropdownMenuSeparator />
              </>
            )}
            <DropdownMenuItem destructive onClick={() => void signOut()}>
              <LogOut className="h-4 w-4" />
              Sign out
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  )
}
