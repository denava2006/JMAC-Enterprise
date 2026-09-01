-- What "sent" actually means.
--
-- The outbox marks a row 'sent' when Brevo's API returns 2xx. That is the
-- provider ACCEPTING the message, which is not the same as the message reaching
-- an inbox: an accepted message can still bounce, be blocked, or be dropped as
-- spam, and none of that comes back through the original HTTP response.
--
-- So a row reading status = 'sent', attempts = 1, last_error = null is evidence
-- that we handed the message over correctly, and evidence of nothing else. When
-- an applicant says no email arrived, that row cannot answer the question, and
-- reporting it as confirmed delivery would be a false answer.
--
-- Brevo returns a messageId on acceptance. Storing it is what makes the rest of
-- the trail reachable: it is the key their delivery log, bounce list and event
-- webhook are all keyed by. Without it there is nothing to look anything up by,
-- which is exactly the position the existing seven rows are in.
--
-- This adds the column and nothing else. It does not change what is sent, does
-- not re-send anything, and does not touch a delivered row.

alter table public.applicant_notification_outbox
  add column if not exists provider_message_id text;

comment on column public.applicant_notification_outbox.provider_message_id is
  'Brevo messageId returned when the message was accepted. The key for looking '
  'the message up in the provider''s delivery log. Null for rows sent before '
  'this was captured, and for rows never accepted.';

comment on column public.applicant_notification_outbox.status is
  'queued | sent | failed. ''sent'' means the provider ACCEPTED the message, '
  'not that it reached an inbox -- an accepted message can still bounce or be '
  'blocked. Confirm real delivery against provider_message_id.';
