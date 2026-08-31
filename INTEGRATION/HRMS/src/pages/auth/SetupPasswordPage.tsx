import * as React from 'react'
import { motion } from 'framer-motion'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { Link, useNavigate } from 'react-router-dom'
import { AlertCircle, CheckCircle2, Eye, EyeOff, Loader2 } from 'lucide-react'
import { supabase } from '@/lib/supabase'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Card, CardContent, CardHeader } from '@/components/ui/card'
import { AuthWaves } from '@/components/AuthWaves'
import { JmacWordmark } from '@/components/Brand'
import { useAuth } from '@/contexts/AuthContext'
import { needsPasswordSetup } from '@/lib/passwordSetup'

const passwordSchema = z
  .object({
    password: z
      .string()
      .min(8, 'Must be at least 8 characters')
      .regex(/[a-z]/, 'Must include a lowercase letter')
      .regex(/[A-Z]/, 'Must include an uppercase letter')
      .regex(/[0-9]/, 'Must include a number')
      .regex(/[^a-zA-Z0-9]/, 'Must include a special character'),
    confirmPassword: z.string().min(1, 'Please confirm your password'),
  })
  .refine((v) => v.password === v.confirmPassword, {
    message: 'Passwords do not match',
    path: ['confirmPassword'],
  })
type PasswordFormValues = z.infer<typeof passwordSchema>

type PageState = 'checking' | 'ready' | 'invalid' | 'success'

const REDIRECT_SECONDS = 2

function AuthCardShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="relative flex min-h-dvh items-center justify-center overflow-hidden bg-background px-4">
      <AuthWaves />
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5, ease: 'easeOut' }}
        className="relative z-10 w-full max-w-sm"
      >
        <Card className="shadow-lg">{children}</Card>
      </motion.div>
    </div>
  )
}

function BrandHeader({ title, description }: { title: string; description: string }) {
  return (
    <CardHeader className="items-center pb-2 text-center">
      <JmacWordmark layout="stacked" className="mb-4 text-xl text-foreground" />
      <h1 className="font-display text-2xl font-bold text-foreground">{title}</h1>
      <p className="text-sm text-muted-foreground">{description}</p>
    </CardHeader>
  )
}

function InvalidInviteState({ message }: { message: string }) {
  return (
    <>
      <CardHeader className="items-center pb-2 text-center">
        <div className="mb-2 flex h-11 w-11 items-center justify-center rounded-xl bg-destructive/10 text-destructive">
          <AlertCircle className="h-5 w-5" />
        </div>
        <h1 className="font-display text-2xl font-bold text-foreground">Invitation problem</h1>
        <p className="text-sm text-muted-foreground">{message}</p>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        <Button asChild>
          <Link to="/login">Back to Login</Link>
        </Button>
        <Button asChild variant="outline">
          <Link to="/">Back to Home</Link>
        </Button>
      </CardContent>
    </>
  )
}

function SuccessState() {
  const navigate = useNavigate()
  const [secondsLeft, setSecondsLeft] = React.useState(REDIRECT_SECONDS)

  React.useEffect(() => {
    if (secondsLeft <= 0) {
      navigate('/login', { replace: true })
      return
    }
    const timer = setTimeout(() => setSecondsLeft((s) => s - 1), 1000)
    return () => clearTimeout(timer)
  }, [secondsLeft, navigate])

  return (
    <CardHeader className="items-center pb-6 pt-2 text-center">
      <motion.div
        initial={{ opacity: 0, scale: 0.9 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ duration: 0.35, ease: 'easeOut' }}
        className="mb-2 flex h-14 w-14 items-center justify-center rounded-full bg-success/10 text-success"
      >
        <CheckCircle2 className="h-7 w-7" />
      </motion.div>
      <h1 className="font-display text-2xl font-bold text-foreground">Password created</h1>
      <p className="text-sm text-muted-foreground">
        Sign in again with your new password. Redirecting in {secondsLeft} second{secondsLeft === 1 ? '' : 's'}…
      </p>
    </CardHeader>
  )
}

function CheckingState() {
  return (
    <CardHeader className="items-center gap-3 py-10 text-center">
      <Loader2 className="h-6 w-6 animate-spin text-secondary" aria-hidden="true" />
      <p className="text-sm text-muted-foreground">Validating your invitation…</p>
    </CardHeader>
  )
}

function SetupPasswordForm({ firstLogin }: { firstLogin: boolean }) {
  const [showPassword, setShowPassword] = React.useState(false)
  const [showConfirm, setShowConfirm] = React.useState(false)
  const [submitError, setSubmitError] = React.useState<string | null>(null)
  const [activated, setActivated] = React.useState(false)

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<PasswordFormValues>({ resolver: zodResolver(passwordSchema) })

  const onSubmit = async (values: PasswordFormValues) => {
    setSubmitError(null)
    const { data, error } = await supabase.auth.updateUser({ password: values.password })
    if (error) {
      setSubmitError(
        /session|expired|token/i.test(error.message)
          ? 'Your session has expired. Please request a new invitation.'
          : 'We couldn’t set your password. Please try again.'
      )
      return
    }
    // activated_at is stamped by a trigger on auth.users when the password
    // actually changes — the client is deliberately not trusted to say so, and
    // is no longer permitted to write it. See
    // 20260731130000_employees_must_set_own_password.sql.
    void data
    await supabase.auth.signOut()
    setActivated(true)
  }

  if (activated) return <SuccessState />

  return (
    <>
      <BrandHeader
        title="Welcome to JMAC Enterprise"
        description={
          firstLogin
            ? 'You signed in with the password HR gave you. Choose your own before continuing.'
            : 'Your account has been created. Create a secure password to activate it.'
        }
      />
      <CardContent>
        <form className="flex flex-col gap-4" onSubmit={handleSubmit(onSubmit)} noValidate>
          {submitError && (
            <div
              role="alert"
              className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
            >
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>{submitError}</span>
            </div>
          )}

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="password">New Password</Label>
            <div className="relative">
              <Input
                id="password"
                type={showPassword ? 'text' : 'password'}
                autoComplete="new-password"
                placeholder="********"
                invalid={!!errors.password}
                aria-describedby="password-hint"
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
            {errors.password ? (
              <p className="text-xs text-destructive">{errors.password.message}</p>
            ) : (
              <p id="password-hint" className="text-xs text-muted-foreground">
                At least 8 characters, with an uppercase letter, a lowercase letter, a number, and a special character.
              </p>
            )}
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="confirmPassword">Confirm Password</Label>
            <div className="relative">
              <Input
                id="confirmPassword"
                type={showConfirm ? 'text' : 'password'}
                autoComplete="new-password"
                placeholder="********"
                invalid={!!errors.confirmPassword}
                className="pr-10"
                {...register('confirmPassword')}
              />
              <button
                type="button"
                onClick={() => setShowConfirm((v) => !v)}
                className="absolute right-0 top-0 flex h-10 w-10 items-center justify-center text-muted-foreground hover:text-foreground"
                aria-label={showConfirm ? 'Hide password' : 'Show password'}
                tabIndex={-1}
              >
                {showConfirm ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            </div>
            {errors.confirmPassword && <p className="text-xs text-destructive">{errors.confirmPassword.message}</p>}
          </div>

          <Button type="submit" className="mt-2 w-full" loading={isSubmitting}>
            {isSubmitting ? 'Creating password…' : 'Create Password'}
          </Button>
        </form>
      </CardContent>
    </>
  )
}

export default function SetupPasswordPage() {
  const { profile } = useAuth()
  // Signed in already and simply hasn't chosen a password yet — as opposed to
  // arriving on an invitation link with no session of their own.
  const firstLogin = needsPasswordSetup(profile)
  const [state, setState] = React.useState<PageState>(firstLogin ? 'ready' : 'checking')
  const [errorMessage, setErrorMessage] = React.useState(
    'This invitation link is invalid or missing. Please use the link from your invitation email.'
  )

  React.useEffect(() => {
    if (firstLogin) return
    const hashParams = new URLSearchParams(window.location.hash.replace(/^#/, ''))
    const errorCode = hashParams.get('error_code')

    if (errorCode) {
      setErrorMessage(
        errorCode === 'otp_expired'
          ? 'This invitation link has expired. Ask your administrator to send a new one.'
          : 'This invitation link is invalid or has already been used.'
      )
      setState('invalid')
      window.history.replaceState(null, '', window.location.pathname)
      return
    }

    supabase.auth.getSession().then(({ data, error }) => {
      if (error || !data.session) {
        setState('invalid')
      } else {
        setState('ready')
      }
    })
  }, [firstLogin])

  return (
    <AuthCardShell>
      {state === 'checking' && <CheckingState />}
      {state === 'invalid' && <InvalidInviteState message={errorMessage} />}
      {state === 'ready' && <SetupPasswordForm firstLogin={firstLogin} />}
    </AuthCardShell>
  )
}
