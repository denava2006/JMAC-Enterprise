import type { Fee } from '@/lib/posFees'
import { errorMessage } from '@/lib/errorMessage'

/**
 * The parts of branch POS settings that are pure decisions rather than network
 * calls, kept out of the hook so they can be tested without a Supabase client.
 */

export interface BranchPosSettings {
  branch_id: string
  fees: Fee[]
  /** The storage object path, never a signed URL -- a signature expires, a path
   * does not. */
  payment_qr_path: string | null
  created_at: string
  updated_at: string
}

/**
 * What an unconfigured branch looks like.
 *
 * Most branches have no branch_pos_settings row and that is not an error
 * condition: it means no fees and no payment QR. Every read path returns this
 * shape rather than undefined so the POS portal cannot crash on a branch nobody
 * has set up yet.
 */
export function emptySettings(branchId: string): BranchPosSettings {
  return {
    branch_id: branchId,
    fees: [],
    payment_qr_path: null,
    created_at: '',
    updated_at: '',
  }
}

/**
 * Postgres and Storage each answer in their own vocabulary. This turns the
 * three failures reachable from the settings screen into a sentence someone can
 * act on, following useBranches' precedent for constraint errors.
 */
export function describeSettingsError(error: unknown): string {
  const message = errorMessage(error)

  if (message.includes('branch_pos_settings_fees_valid')) {
    return 'That fee configuration is not valid. Check for negative values, percentages over 100, or a missing name.'
  }
  if (message.includes('branch_pos_settings_qr_path_scoped')) {
    return 'The payment QR must be stored under its own branch. Please try the upload again.'
  }
  if (message.includes('row-level security') || message.toLowerCase().includes('unauthorized')) {
    return 'Only an Administrator can change POS settings.'
  }
  if (message.includes('violates foreign key constraint')) {
    return 'That branch no longer exists. Refresh the page and try again.'
  }
  if (message.includes('exceeded the maximum allowed size')) {
    return 'The image must be under 5MB.'
  }
  return message || 'Something went wrong. Please try again.'
}
