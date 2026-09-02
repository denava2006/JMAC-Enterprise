import { z } from 'zod'

/**
 * What a vendor's details have to look like.
 *
 * The same rules the database enforces, so the form can say what is wrong
 * before anybody presses Save — but the database is the rule, not this. These
 * exist to turn a refusal into a sentence next to the offending field.
 */

/** 14 digits, displayed 3-3-3-5. Stored in exactly one shape so two vendors
 *  cannot hold the same TIN written differently. */
export const TIN_PATTERN = /^\d{3}-\d{3}-\d{3}-\d{5}$/

export function tinDigits(value: string): string {
  return value.replace(/\D/g, '')
}

/** Formats as far as the digits go, so the field can format while typing. */
export function formatTin(value: string): string {
  const digits = tinDigits(value).slice(0, 14)
  const parts = [digits.slice(0, 3), digits.slice(3, 6), digits.slice(6, 9), digits.slice(9, 14)]
  return parts.filter((p) => p.length > 0).join('-')
}

/** Only digits, hyphens and spaces may separate a TIN.
 *
 * Stripping every non-digit would accept 123/456/789/01234 by silently
 * discarding the slashes — and the database, which reformats only when the
 * input is digits and separators, would then refuse what the form had just
 * called valid. The two say the same thing on purpose. */
const TIN_ACCEPTED_CHARACTERS = /^[\d\-\s]+$/

export function isValidTin(value: string): boolean {
  if (!TIN_ACCEPTED_CHARACTERS.test(value.trim())) return false
  return TIN_PATTERN.test(formatTin(value)) && tinDigits(value).length === 14
}

/**
 * An address, not merely something containing an @.
 *
 * Rejects supplier, supplier@, @example.com and supplier@example — the last
 * because a bare hostname with no dotted TLD is almost always a typo, and a
 * bounced supplier email is discovered weeks later.
 */
export const EMAIL_PATTERN = /^[^@\s]+@[^@\s]+\.[A-Za-z]{2,}$/

/** Digits only. A leading + is refused rather than stripped: quietly changing
 *  what somebody typed is how a wrong number gets stored confidently. */
export const PHONE_PATTERN = /^\d{7,15}$/

/** Letters and spaces, Unicode-aware so accented and non-Latin names pass. */
export const PERSON_NAME_PATTERN = /^\p{L}+(?: \p{L}+)*$/u

export function collapseSpaces(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

const optionalText = (max: number) => z.string().trim().max(max).optional().or(z.literal(''))

export const vendorSchema = z.object({
  // A business name is not a person's name: 7-Eleven & Co. is a real supplier.
  name: z.string().trim().min(1, 'A vendor name is required').max(150),

  contact_person: z
    .string()
    .transform(collapseSpaces)
    .refine((v) => v === '' || PERSON_NAME_PATTERN.test(v), {
      message: 'Contact person may contain letters and spaces only.',
    })
    .optional(),

  email: z
    .string()
    .transform((v) => v.trim().toLowerCase())
    .refine((v) => v === '' || EMAIL_PATTERN.test(v), {
      message: 'Enter a valid email address.',
    })
    .optional(),

  phone: z
    .string()
    .transform((v) => v.trim())
    .refine((v) => v === '' || PHONE_PATTERN.test(v), {
      message: 'Phone number must be digits only, 7 to 15 of them.',
    })
    .optional(),

  tin: z
    .string()
    .transform((v) => v.trim())
    .refine((v) => v === '' || !/^[\d\-\s]+$/.test(v) || tinDigits(v).length === 14, {
      message: 'TIN must contain 14 digits.',
    })
    .refine((v) => v === '' || isValidTin(v), {
      message: 'Enter a valid TIN in the format 000-000-000-00000.',
    })
    .optional(),

  address: optionalText(300),
  notes: optionalText(500),
})

export type VendorFormValues = z.infer<typeof vendorSchema>
