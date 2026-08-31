import * as React from 'react'
import { motion } from 'framer-motion'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { Link, useNavigate } from 'react-router-dom'
import { AlertCircle, CheckCircle2, Eye, EyeOff } from 'lucide-react'
import { supabase } from '@/lib/supabase'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Card, CardContent, CardHeader } from '@/components/ui/card'
import { AuthWaves } from '@/components/AuthWaves'
import { JmacWordmark } from '@/components/Brand'
import { describeRecoveryError, readRecoveryError } from '@/lib/passwordRecovery'

const schema = z
  .object({
    password: z.string().min(8, 'Use at least 8 characters'),
    confirm: z.string().min(1, 'Confirm your new password'),
  })
  .refine((v) => v.password === v.confirm, {
    path: ['confirm'],
    message: 'Those passwords do not match',
  })
type Values = z.infer<typeof schema>

/**
 * Where a recovery link lands.
 *
 * Supabase turns the link into a real session before this renders, so setting
 * the password is an ordinary authenticated `updateUser` -- there is no
 * home-grown token to validate, store or expire, which is exactly why this
 * does not build one.
 *
 * A link that was already used, or has expired, arrives with its error in the
 * URL *fragment*. That is read on mount, because the session will simply be
 * absent and "no session" on its own does not explain itself to the reader.
 */
export default function ResetPasswordPage() {
  const navigate = useNavigate()
  const [ready, setReady] = React.useState(false)
  const [linkError, setLinkError] = React.useState<string | null>(null)
  const [formError, setFormError] = React.useState<string | null>(null)
  const [done, setDone] = React.useState(false)
  const [showPassword, setShowPassword] = React.useState(false)

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<Values>({ resolver: zodResolver(schema) })

  React.useEffect(() => {
    const fromLink = describeRecoveryError(readRecoveryError(window.location.hash))
    if (fromLink) {
      setLinkError(fromLink)
      setReady(true)
      return
    }

    // The client exchanges the link for a session on load; give it that tick
    // before deciding there is nothing here.
    const { data: sub } = supabase.auth.onAuthStateChange((event) => {
      if (event === 'PASSWORD_RECOVERY' || event === 'SIGNED_IN') {
        setLinkError(null)
        setReady(true)
      }
    })
    supabase.auth.getSession().then(({ data }) => {
      if (data.session) {
        setLinkError(null)
      } else {
        setLinkError('This password reset link is invalid or has expired.')
      }
      setReady(true)
    })
    return () => sub.subscription.unsubscribe()
  }, [])

  const onSubmit = async (values: Values) => {
    setFormError(null)
    const { error } = await supabase.auth.updateUser({ password: values.password })
    if (error) {
      setFormError(error.message)
      return
    }
    // Sign out so the new password is actually used to get back in, rather than
    // leaving the recovery session standing.
    await supabase.auth.signOut()
    setDone(true)
    setTimeout(() => navigate('/login', { replace: true }), 2500)
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
        <Card className="shadow-lg">
          <CardHeader className="items-center pb-5 text-center">
            <JmacWordmark layout="stacked" className="mb-3 text-xl text-foreground" />
            <h1 className="text-base font-semibold text-foreground">
              {done
                ? 'Password updated successfully.'
                : linkError
                  ? 'Link no longer valid'
                  : 'Create a new password'}
            </h1>
          </CardHeader>

          <CardContent>
            {!ready ? (
              <p className="text-center text-sm text-muted-foreground">Checking your link…</p>
            ) : done ? (
              <div className="flex flex-col items-center gap-3 text-center">
                <div className="flex h-11 w-11 items-center justify-center rounded-full bg-accent/10 text-accent">
                  <CheckCircle2 className="h-5 w-5" />
                </div>
                <p className="text-sm text-muted-foreground">
                  Sign in with your new password. Taking you back to login…
                </p>
              </div>
            ) : linkError ? (
              <div className="flex flex-col gap-3">
                <div
                  role="alert"
                  className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
                >
                  <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                  <span>{linkError}</span>
                </div>
                <Button asChild variant="outline" className="w-full">
                  <Link to="/forgot-password">Request a new reset link</Link>
                </Button>
              </div>
            ) : (
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
                  <Label htmlFor="password">New password</Label>
                  <div className="relative">
                    <Input
                      id="password"
                      type={showPassword ? 'text' : 'password'}
                      autoComplete="new-password"
                      invalid={!!errors.password}
                      {...register('password')}
                    />
                    <button
                      type="button"
                      onClick={() => setShowPassword((v) => !v)}
                      aria-label={showPassword ? 'Hide password' : 'Show password'}
                      className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                    >
                      {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                    </button>
                  </div>
                  {errors.password && <p className="text-xs text-destructive">{errors.password.message}</p>}
                </div>

                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="confirm">Confirm new password</Label>
                  <Input
                    id="confirm"
                    type={showPassword ? 'text' : 'password'}
                    autoComplete="new-password"
                    invalid={!!errors.confirm}
                    {...register('confirm')}
                  />
                  {errors.confirm && <p className="text-xs text-destructive">{errors.confirm.message}</p>}
                </div>

                <Button type="submit" className="mt-1 w-full" loading={isSubmitting}>
                  Update password
                </Button>
              </form>
            )}
          </CardContent>
        </Card>
      </motion.div>
    </div>
  )
}
