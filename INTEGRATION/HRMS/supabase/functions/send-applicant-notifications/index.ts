// Deliver queued applicant emails through Brevo's transactional API.
//
// This is the second half of the outbox. The first half runs in the database:
// a trigger enqueues a row in the same transaction as the HR decision that
// justifies it. Nothing here can affect that decision -- if Brevo is down, an
// application is still rejected, an interview is still scheduled, and the row
// simply stays pending.
//
// Why Brevo's HTTP API rather than its SMTP relay, which Supabase Auth already
// uses: these are not Auth emails. Reusing resetPasswordForEmail or
// inviteUserByEmail to tell somebody their interview moved would send an
// account-recovery template to a person who has no account, and would put
// application state inside Auth's templates. They are separate concerns with
// separate failure modes, so they get separate paths.
//
// The key lives only as a Supabase secret. It is never in VITE_*, never in the
// browser bundle, never in a database row, and never in a response.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

const TRACK_URL = 'https://jmac-enterprise.vercel.app/track'
const SENDER = { name: 'JMAC Enterprise', email: 'no-reply@jmac-enterprise.com' }

/** How many attempts before a row is left alone for a person to look at.
 *  Bounded on purpose: an address that will never accept mail must not be
 *  retried forever. */
const MAX_ATTEMPTS = 5

/** Backoff in minutes, indexed by attempt. Slow enough to ride out an outage,
 *  short enough that a real interview notice is not days late. */
const BACKOFF_MINUTES = [1, 5, 30, 120, 480]

interface OutboxRow {
  id: string
  event_type: string
  recipient_email: string
  recipient_name: string
  attempts: number
  payload: Record<string, string>
}

/** Subject and body per event. Applicant-safe by construction: the only values
 *  available are the ones the trigger put in the payload, and the trigger puts
 *  no notes, ratings or reasons there. */
function compose(row: OutboxRow): { subject: string; heading: string; lines: string[]; action: string } {
  const p = row.payload ?? {}
  const position = p.position || 'the role you applied for'
  const when = p.scheduled_at ? `${p.scheduled_at}` : ''
  const time = p.scheduled_time ? `${p.scheduled_time}` : ''
  const place = p.meeting_link || p.location || ''
  const mode = p.mode === 'online' ? 'Online' : p.mode === 'face_to_face' ? 'In person' : ''

  const interviewLines = [
    when ? `Date: ${when}` : '',
    time ? `Time: ${time}` : '',
    mode ? `Format: ${mode}` : '',
    place ? `Where: ${place}` : '',
  ].filter(Boolean)

  switch (row.event_type) {
    case 'application_submitted':
      return {
        subject: 'JMAC Application Received',
        heading: 'We have your application',
        lines: [
          `Thank you for applying for ${position}.`,
          'Your application has been received and will be reviewed by our team.',
          'Please keep the reference code below — you will need it, together with this email address, to check your application at any time.',
        ],
        action: 'Track your application',
      }
    case 'application_shortlisted':
      return {
        subject: 'JMAC Application Update — Shortlisted',
        heading: 'Your application is moving forward',
        lines: [
          `Your application for ${position} has been shortlisted.`,
          'We will be in touch with the next steps.',
        ],
        action: 'Track your application',
      }
    case 'interview_scheduled':
      return {
        subject: 'JMAC Application Update — Interview Scheduled',
        heading: 'Your interview is scheduled',
        lines: [`An interview has been scheduled for your application for ${position}.`, ...interviewLines],
        action: 'View the latest details',
      }
    case 'interview_rescheduled':
      return {
        subject: 'JMAC Application Update — Interview Rescheduled',
        heading: 'Your interview schedule has changed',
        lines: [
          `The interview for your application for ${position} has been moved.`,
          'The current schedule is:',
          ...interviewLines,
        ],
        action: 'View the latest details',
      }
    case 'interview_cancelled':
      return {
        subject: 'JMAC Application Update — Interview Cancelled',
        heading: 'Your interview has been cancelled',
        lines: [
          `The interview for your application for ${position} has been cancelled.`,
          'If another interview is arranged, you will receive a new notification.',
        ],
        action: 'Track your application',
      }
    case 'offer_sent':
      return {
        subject: 'JMAC Application Update — Job Offer',
        heading: 'You have a job offer',
        lines: [
          `A job offer has been prepared for your application for ${position}.`,
          'Please review it and respond using the link below.',
        ],
        action: 'Review your offer',
      }
    case 'application_hired':
      return {
        subject: 'JMAC Application Update — Welcome to JMAC',
        heading: 'Welcome to JMAC',
        lines: [
          `We are pleased to confirm you have been hired for ${position}.`,
          'Onboarding details will follow.',
        ],
        action: 'Track your application',
      }
    case 'deployment_completed':
      return {
        subject: 'JMAC Application Update — Onboarding Complete',
        heading: 'Your onboarding is complete',
        lines: [`Your onboarding for ${position} is complete. Welcome aboard.`],
        action: 'Track your application',
      }
    case 'application_rejected':
      // Neutral and reasonless on purpose. rejection_reason is HR's internal
      // record, and this workflow has no applicant-facing reason field.
      return {
        subject: 'JMAC Application Update',
        heading: 'Update on your application',
        lines: [
          `Thank you for your interest in ${position} at JMAC Enterprise.`,
          'After careful consideration we will not be moving forward with your application at this time.',
          'We appreciate the time you took to apply, and we wish you well.',
        ],
        action: 'Track your application',
      }
    case 'application_closed':
    default:
      return {
        subject: 'JMAC Application Update',
        heading: 'Update on your application',
        lines: [`There has been an update to your application for ${position}.`],
        action: 'Track your application',
      }
  }
}

function render(row: OutboxRow) {
  const { subject, heading, lines, action } = compose(row)
  const ref = row.payload?.reference_code ?? ''
  const name = row.recipient_name || 'there'

  const text = [
    `Hello ${name},`,
    '',
    ...lines,
    '',
    ref ? `Reference: ${ref}` : '',
    `${action}: ${TRACK_URL}`,
    '',
    'You will need your reference code and this email address to view your application.',
    '',
    'JMAC Enterprise',
  ].filter((l) => l !== undefined).join('\n')

  const html = `<!doctype html><html><body style="margin:0;background:#f1f5f9;padding:24px;font-family:system-ui,-apple-system,'Segoe UI',sans-serif;color:#0f2a43">
  <div style="max-width:520px;margin:0 auto;background:#fff;border-radius:12px;padding:28px">
    <p style="margin:0 0 4px;font-size:18px;font-weight:800;letter-spacing:-.02em">JMAC</p>
    <p style="margin:0 0 20px;font-size:11px;letter-spacing:.28em;text-transform:uppercase;color:#64748b">Enterprise</p>
    <h1 style="margin:0 0 14px;font-size:18px">${heading}</h1>
    <p style="margin:0 0 14px;font-size:14px">Hello ${name},</p>
    ${lines.map((l) => `<p style="margin:0 0 10px;font-size:14px;line-height:1.6">${l}</p>`).join('')}
    ${ref ? `<p style="margin:18px 0 6px;font-size:12px;color:#64748b">Reference</p>
    <p style="margin:0 0 18px;font-family:ui-monospace,monospace;font-size:15px;font-weight:600">${ref}</p>` : ''}
    <a href="${TRACK_URL}" style="display:inline-block;background:#0f2a43;color:#fff;text-decoration:none;padding:10px 18px;border-radius:8px;font-size:14px;font-weight:600">${action}</a>
    <p style="margin:20px 0 0;font-size:12px;color:#64748b;line-height:1.6">You will need your reference code and this email address to view your application.</p>
  </div>
</body></html>`

  return { subject, text, html }
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    const brevoKey = Deno.env.get('BREVO_API_KEY')

    if (!brevoKey) {
      // Named precisely so an operator knows exactly what to add, and nothing
      // is attempted that would mark rows failed for a configuration reason.
      return json({ error: 'BREVO_API_KEY is not configured for this project.' }, 503)
    }

    const admin = createClient(supabaseUrl, serviceRoleKey)

    // Claim a batch. `processing` is set first so two concurrent runs cannot
    // send the same row twice -- the outbox is at-least-once, and the unique
    // index plus this claim keep it close to exactly-once.
    const { data: due, error: dueError } = await admin
      .from('applicant_notification_outbox')
      .select('id, event_type, recipient_email, recipient_name, attempts, payload')
      .in('status', ['pending', 'failed'])
      .lte('next_attempt_at', new Date().toISOString())
      .lt('attempts', MAX_ATTEMPTS)
      .order('created_at', { ascending: true })
      .limit(25)

    if (dueError) {
      console.error('outbox read failed:', dueError.message)
      return json({ error: 'Could not read the notification queue.' }, 500)
    }

    const rows = (due ?? []) as OutboxRow[]
    let sent = 0
    let failed = 0

    for (const row of rows) {
      const claimed = await admin
        .from('applicant_notification_outbox')
        .update({ status: 'processing' })
        .eq('id', row.id)
        .in('status', ['pending', 'failed'])
        .select('id')
      if (!claimed.data || claimed.data.length === 0) continue // another run took it

      const { subject, text, html } = render(row)
      const attempts = row.attempts + 1

      try {
        const res = await fetch('https://api.brevo.com/v3/smtp/email', {
          method: 'POST',
          headers: { 'api-key': brevoKey, 'Content-Type': 'application/json', accept: 'application/json' },
          body: JSON.stringify({
            sender: SENDER,
            to: [{ email: row.recipient_email, name: row.recipient_name }],
            subject,
            textContent: text,
            htmlContent: html,
          }),
        })

        if (res.ok) {
          await admin.from('applicant_notification_outbox')
            .update({ status: 'sent', sent_at: new Date().toISOString(), attempts, last_error: null })
            .eq('id', row.id)
          sent += 1
        } else {
          const body = (await res.text()).slice(0, 300)
          const give_up = attempts >= MAX_ATTEMPTS
          const wait = BACKOFF_MINUTES[Math.min(attempts - 1, BACKOFF_MINUTES.length - 1)]
          await admin.from('applicant_notification_outbox')
            .update({
              status: 'failed',
              attempts,
              // Kept server-side for an operator. get_applicant_notifications
              // deliberately does not return it, so a provider message never
              // reaches a screen.
              last_error: `HTTP ${res.status}: ${body}`,
              next_attempt_at: give_up
                ? new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString()
                : new Date(Date.now() + wait * 60 * 1000).toISOString(),
            })
            .eq('id', row.id)
          failed += 1
          console.error(`notification ${row.id} failed (attempt ${attempts}): HTTP ${res.status}`)
        }
      } catch (err) {
        const attemptsNow = attempts
        const wait = BACKOFF_MINUTES[Math.min(attemptsNow - 1, BACKOFF_MINUTES.length - 1)]
        await admin.from('applicant_notification_outbox')
          .update({
            status: 'failed',
            attempts: attemptsNow,
            last_error: (err instanceof Error ? err.message : String(err)).slice(0, 300),
            next_attempt_at: new Date(Date.now() + wait * 60 * 1000).toISOString(),
          })
          .eq('id', row.id)
        failed += 1
        console.error(`notification ${row.id} threw:`, err instanceof Error ? err.message : err)
      }
    }

    // Counts only. No addresses, no payloads, no provider text.
    return json({ considered: rows.length, sent, failed })
  } catch (err) {
    console.error('send-applicant-notifications unhandled:', err instanceof Error ? err.message : err)
    return json({ error: 'Could not process the notification queue.' }, 500)
  }
})
