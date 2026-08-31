import * as React from 'react'
import { motion } from 'framer-motion'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { Link, Navigate, useNavigate } from 'react-router-dom'
import { Eye, EyeOff, AlertCircle, ArrowLeft } from 'lucide-react'
import { useAuth } from '@/contexts/AuthContext'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Card, CardContent, CardHeader } from '@/components/ui/card'
import { AuthWaves } from '@/components/AuthWaves'
import { JmacWordmark } from '@/components/Brand'

const loginSchema = z.object({
  email: z.string().min(1, 'Email is required').email('Enter a valid email address'),
  password: z.string().min(1, 'Password is required'),
})

type LoginFormValues = z.infer<typeof loginSchema>

export default function LoginPage() {
  const { session, profile, signIn } = useAuth()
  const navigate = useNavigate()
  const [showPassword, setShowPassword] = React.useState(false)
  const [formError, setFormError] = React.useState<string | null>(null)

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<LoginFormValues>({ resolver: zodResolver(loginSchema) })

  // Already signed in — send them straight past the login form.
  //
  // Always /home, never a remembered path. Honouring one meant the route the
  // *previous* user was on decided where the *next* one landed: sign out on
  // /pos, and the HR Staff who signs in next was sent to a till they have no
  // access to. /home derives the portal from the account that is signed in now.
  if (session && profile) {
    return <Navigate to="/home" replace />
  }

  const onSubmit = async (values: LoginFormValues) => {
    setFormError(null)
    // "Authentication Success?" branch lives inside signIn().
    const { error } = await signIn(values.email, values.password)
    if (error) {
      setFormError(error)
      return
    }
    // /home, not /dashboard: the portal is decided there, once this account's
    // profile and POS access have actually loaded.
    navigate('/home', { replace: true })
  }

  return (
    <div className="relative flex min-h-dvh items-center justify-center overflow-hidden bg-background px-4">
      <AuthWaves />

      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5, ease: 'easeOut' }}
        className="relative z-10 w-full max-w-sm"
      >
        <Link
          to="/"
          className="group mb-4 inline-flex items-center gap-1.5 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4 transition-transform group-hover:-translate-x-0.5" />
          Back to Home
        </Link>

        <Card className="shadow-lg">
          <CardHeader className="items-center pb-5 text-center">
            {/* Role-neutral by design. This one form serves Administrators, HR,
                employees, POS managers, cashiers and -- later -- finance, so it
                must not describe itself as any one workspace. Where the account
                goes is decided at /home, after the profile loads. */}
            <JmacWordmark layout="stacked" className="mb-3 text-xl text-foreground" />
            <h1 className="text-base font-semibold text-foreground">Sign in to JMAC Enterprise</h1>
          </CardHeader>

          <CardContent>
            <form className="flex flex-col gap-4" onSubmit={handleSubmit(onSubmit)} noValidate>
              {formError && (
                <div
                  role="alert"
                  className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
                >
                  <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                  <span>{formError}</span>
                </div>
              )}

              <div className="flex flex-col gap-1.5">
                <Label htmlFor="email">Email</Label>
                <Input
                  id="email"
                  type="email"
                  autoComplete="username"
                  placeholder="you@company.com"
                  invalid={!!errors.email}
                  aria-describedby={errors.email ? 'email-error' : undefined}
                  {...register('email')}
                />
                {errors.email && (
                  <p id="email-error" className="text-xs text-destructive">
                    {errors.email.message}
                  </p>
                )}
              </div>

              <div className="flex flex-col gap-1.5">
                <Label htmlFor="password">Password</Label>
                <div className="relative">
                  <Input
                    id="password"
                    type={showPassword ? 'text' : 'password'}
                    autoComplete="current-password"
                    placeholder="********"
                    invalid={!!errors.password}
                    aria-describedby={errors.password ? 'password-error' : undefined}
                    className="pr-10"
                    {...register('password')}
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword((v) => !v)}
                    className="absolute right-0 top-0 flex h-10 w-10 items-center justify-center text-muted-foreground hover:text-foreground"
                    aria-label={showPassword ? 'Hide password' : 'Show password'}
                    tabIndex={-1}
                  >
                    {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </button>
                </div>
                {errors.password && (
                  <p id="password-error" className="text-xs text-destructive">
                    {errors.password.message}
                  </p>
                )}
              </div>

              <Button type="submit" className="mt-2 w-full" loading={isSubmitting}>
                {isSubmitting ? 'Signing in\u2026' : 'Sign in'}
              </Button>
            </form>
          </CardContent>
        </Card>

        <p className="mt-6 text-center text-xs text-muted-foreground">
          JMAC Enterprise — use the account provided by your administrator.
        </p>
      </motion.div>
    </div>
  )
}
