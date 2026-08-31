import * as React from 'react'
import { motion } from 'framer-motion'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { Link } from 'react-router-dom'
import { ArrowLeft, MailCheck } from 'lucide-react'
import { supabase } from '@/lib/supabase'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Card, CardContent, CardHeader } from '@/components/ui/card'
import { AuthWaves } from '@/components/AuthWaves'
import { JmacWordmark } from '@/components/Brand'
import { RESET_PASSWORD_PATH } from '@/lib/passwordRecovery'

const schema = z.object({
  email: z.string().min(1, 'Email is required').email('Enter a valid email address'),
})
type Values = z.infer<typeof schema>

/**
 * Ask for a password reset link.
 *
 * This replaces the old answer to a forgotten password, which was for HR to
 * reset the account to a documented default and read it out. Nothing reusable
 * is handed to anyone now: Supabase mails a single-use recovery link, and the
 * person chooses their own password at the other end.
 *
 * The response is identical whether or not the address belongs to an account.
 * Saying "no account with that email" would turn this form into a way to find
 * out who works here.
 */
export default function ForgotPasswordPage() {
  const [sent, setSent] = React.useState(false)
  const {
    register,
    handleSubmit,
    getValues,
    formState: { errors, isSubmitting },
  } = useForm<Values>({ resolver: zodResolver(schema) })

  const onSubmit = async (values: Values) => {
    // The link must come back to THIS origin -- localhost in development, the
    // Vercel domain in production -- so it is derived rather than configured.
    await supabase.auth.resetPasswordForEmail(values.email.trim(), {
      redirectTo: `${window.location.origin}${RESET_PASSWORD_PATH}`,
    })
    // Deliberately not checking the error: a failure here would distinguish a
    // known address from an unknown one.
    setSent(true)
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
          to="/login"
          className="group mb-4 inline-flex items-center gap-1.5 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4 transition-transform group-hover:-translate-x-0.5" />
          Back to sign in
        </Link>

        <Card className="shadow-lg">
          <CardHeader className="items-center pb-5 text-center">
            <JmacWordmark layout="stacked" className="mb-3 text-xl text-foreground" />
            <h1 className="text-base font-semibold text-foreground">
              {sent ? 'Check your email' : 'Reset your password'}
            </h1>
          </CardHeader>

          <CardContent>
            {sent ? (
              <div className="flex flex-col items-center gap-3 text-center">
                <div className="flex h-11 w-11 items-center justify-center rounded-full bg-accent/10 text-accent">
                  <MailCheck className="h-5 w-5" />
                </div>
                <p className="text-sm text-muted-foreground">
                  If <span className="font-medium text-foreground">{getValues('email')}</span> has an account, a
                  link to set a new password is on its way. It can be used once, and expires shortly.
                </p>
                <Button asChild variant="outline" className="mt-1 w-full">
                  <Link to="/login">Back to sign in</Link>
                </Button>
              </div>
            ) : (
              <form className="flex flex-col gap-4" onSubmit={handleSubmit(onSubmit)} noValidate>
                <p className="text-sm text-muted-foreground">
                  Enter the email address your account uses. We&apos;ll send a link to set a new password.
                </p>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="email">Email</Label>
                  <Input
                    id="email"
                    type="email"
                    autoComplete="username"
                    placeholder="you@company.com"
                    invalid={!!errors.email}
                    {...register('email')}
                  />
                  {errors.email && <p className="text-xs text-destructive">{errors.email.message}</p>}
                </div>
                <Button type="submit" className="mt-1 w-full" loading={isSubmitting}>
                  Send reset link
                </Button>
              </form>
            )}
          </CardContent>
        </Card>

        <p className="mt-6 text-center text-xs text-muted-foreground">
          JMAC Enterprise — your administrator can help if you no longer have access to that address.
        </p>
      </motion.div>
    </div>
  )
}
