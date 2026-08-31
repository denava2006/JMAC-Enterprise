import * as React from 'react'
import { Link, Outlet, useLocation } from 'react-router-dom'
import { motion, AnimatePresence } from 'framer-motion'
import { Menu, X, MapPin } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { JmacWordmark, MODULES } from '@/components/Brand'

const NAV_LINKS = [
  { label: 'Home', to: '/' },
  { label: 'Careers', to: '/careers' },
  { label: 'Track Application', to: '/track' },
]

function Logo() {
  return (
    <Link
      to="/"
      className="flex items-center text-foreground transition-opacity hover:opacity-80"
      aria-label="JMAC Enterprise — home"
    >
      <JmacWordmark className="text-base" />
    </Link>
  )
}

function SiteHeader() {
  const location = useLocation()
  const [mobileOpen, setMobileOpen] = React.useState(false)

  React.useEffect(() => setMobileOpen(false), [location.pathname])

  return (
    <header className="sticky top-0 z-40 border-b border-border bg-card/90 backdrop-blur-sm">
      <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-4 sm:px-6">
        <Logo />

        <nav className="hidden items-center gap-1 md:flex">
          {NAV_LINKS.map((link) => (
            <Link
              key={link.to}
              to={link.to}
              className={cn(
                'rounded-md px-3 py-2 text-sm font-medium transition-colors hover:bg-muted',
                location.pathname === link.to ? 'text-secondary' : 'text-foreground'
              )}
            >
              {link.label}
            </Link>
          ))}
        </nav>

        <div className="hidden items-center gap-2 md:flex">
          <Button asChild variant="outline">
            <Link to="/login">Login</Link>
          </Button>
        </div>

        <button
          type="button"
          className="flex h-10 w-10 items-center justify-center rounded-md text-foreground md:hidden"
          onClick={() => setMobileOpen((v) => !v)}
          aria-label={mobileOpen ? 'Close menu' : 'Open menu'}
          aria-expanded={mobileOpen}
        >
          {mobileOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
        </button>
      </div>

      <AnimatePresence>
        {mobileOpen && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2, ease: 'easeOut' }}
            className="overflow-hidden border-t border-border bg-card md:hidden"
          >
            <nav className="flex flex-col gap-1 px-4 py-3">
              {NAV_LINKS.map((link) => (
                <Link
                  key={link.to}
                  to={link.to}
                  className="rounded-md px-3 py-2 text-sm font-medium text-foreground hover:bg-muted"
                >
                  {link.label}
                </Link>
              ))}
              <Button asChild variant="outline" className="mt-1">
                <Link to="/login">Login</Link>
              </Button>
            </nav>
          </motion.div>
        )}
      </AnimatePresence>
    </header>
  )
}

function SiteFooter() {
  return (
    <footer className="border-t border-border bg-primary text-primary-foreground">
      <div className="mx-auto grid max-w-6xl gap-8 px-4 py-12 sm:px-6 md:grid-cols-3">
        <div>
          <JmacWordmark className="text-base" />
          <p className="mt-3 max-w-xs text-sm text-primary-foreground/70">
            One integrated platform for people, operations, sales, and finance.
          </p>
          <ul className="mt-4 flex flex-wrap gap-x-3 gap-y-1.5 font-mono text-[11px] tracking-[0.14em] text-primary-foreground/55">
            {MODULES.map((m) => (
              <li key={m.code} className={m.status === 'planned' ? 'opacity-60' : undefined}>
                {m.code}
                {m.status === 'planned' && <span className="ml-1 normal-case tracking-normal">(planned)</span>}
              </li>
            ))}
          </ul>
        </div>

        <div>
          <h3 className="text-sm font-semibold uppercase tracking-wide text-primary-foreground/60">Quick links</h3>
          <ul className="mt-3 flex flex-col gap-2 text-sm">
            <li>
              <Link to="/" className="text-primary-foreground/80 hover:text-white">
                Home
              </Link>
            </li>
            <li>
              <Link to="/careers" className="text-primary-foreground/80 hover:text-white">
                Careers
              </Link>
            </li>
            <li>
              <Link to="/login" className="text-primary-foreground/80 hover:text-white">
                Login
              </Link>
            </li>
          </ul>
        </div>

        <div>
          <h3 className="text-sm font-semibold uppercase tracking-wide text-primary-foreground/60">Applicants</h3>
          <ul className="mt-3 flex flex-col gap-2.5 text-sm text-primary-foreground/80">
            <li>
              <Link to="/careers" className="hover:text-white">
                Browse open roles
              </Link>
            </li>
            <li>
              <Link to="/track" className="hover:text-white">
                Check an application you already sent
              </Link>
            </li>
            <li className="flex items-center gap-2 pt-1 text-primary-foreground/70">
              <MapPin className="h-4 w-4 shrink-0" />
              Philippines
            </li>
          </ul>
        </div>
      </div>

      <div className="border-t border-white/10 py-4">
        <p className="mx-auto max-w-6xl px-4 text-center text-xs text-primary-foreground/50 sm:px-6">
          © {new Date().getFullYear()} JMAC Enterprise. All rights reserved.
        </p>
      </div>
    </footer>
  )
}

export function PublicLayout() {
  const location = useLocation()

  React.useEffect(() => {
    window.scrollTo({ top: 0, behavior: 'instant' as ScrollBehavior })
  }, [location.pathname])

  return (
    <div className="flex min-h-dvh flex-col bg-background">
      <SiteHeader />
      <motion.main
        key={location.pathname}
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.25, ease: 'easeOut' }}
        className="flex-1"
      >
        <Outlet />
      </motion.main>
      <SiteFooter />
    </div>
  )
}
