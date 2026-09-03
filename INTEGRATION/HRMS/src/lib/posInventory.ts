import type { Enums } from '@/lib/database.types'
import { errorMessage } from '@/lib/errorMessage'

/**
 * Inventory decisions that are pure, kept out of the hooks so they can be
 * tested without a Supabase client.
 *
 * None of this is a security boundary. The balance moves only through
 * `receive_pos_stock` and `adjust_pos_stock`, both Administrator-only and both
 * guarded by a trigger that refuses any other write. What is here keeps the UI
 * from offering an action the database would refuse, and keeps cost off screens
 * that must not show it.
 */

export type MovementType = Enums<'pos_movement_type'>

export const MOVEMENT_LABEL: Record<MovementType, string> = {
  receipt: 'Received',
  adjustment_in: 'Adjusted up',
  adjustment_out: 'Adjusted down',
  sale: 'Sold',
}

/** Reasons `adjust_pos_stock` accepts. Anything else is refused by the RPC. */
export const ADJUSTMENT_REASONS = ['recount', 'damaged', 'expired', 'lost', 'found'] as const
export type AdjustmentReason = (typeof ADJUSTMENT_REASONS)[number]

export const ADJUSTMENT_REASON_LABEL: Record<AdjustmentReason, string> = {
  recount: 'Recount',
  damaged: 'Damaged',
  expired: 'Expired',
  lost: 'Lost',
  found: 'Found',
}

/** Reasons that only make sense in one direction, so the form can stop a
 * nonsense entry before the round trip. `recount` goes either way. */
export const REASON_DIRECTION: Record<AdjustmentReason, 'up' | 'down' | 'either'> = {
  recount: 'either',
  damaged: 'down',
  expired: 'down',
  lost: 'down',
  found: 'up',
}

export interface InventoryRow {
  product_id: string
  product_name: string
  category_name: string
  quantity_on_hand: number
  low_stock_threshold: number
  is_low_stock: boolean
  is_available: boolean
  product_status: Enums<'pos_product_status'>
}

export const peso = (value: number) =>
  `₱${value.toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

/**
 * What a branch would hold after an adjustment.
 *
 * Mirrors the RPC's refusal: the balance may not go below zero. Returning the
 * projected number rather than a boolean lets the form say *what* it would be.
 */
export function projectedQuantity(current: number, change: number): number {
  return current + change
}

export function validateAdjustment(
  current: number,
  change: number,
  reason: AdjustmentReason
): string[] {
  const errors: string[] = []

  if (!Number.isFinite(change) || change === 0) {
    errors.push('An adjustment cannot be zero.')
    return errors
  }
  if (!Number.isInteger(change)) errors.push('An adjustment must be a whole number of units.')

  const projected = projectedQuantity(current, change)
  if (projected < 0) {
    errors.push(`That would leave ${projected} units. Stock cannot go below zero.`)
  }

  const direction = REASON_DIRECTION[reason]
  if (direction === 'down' && change > 0) {
    errors.push(`"${ADJUSTMENT_REASON_LABEL[reason]}" removes stock, so the change must be negative.`)
  }
  if (direction === 'up' && change < 0) {
    errors.push(`"${ADJUSTMENT_REASON_LABEL[reason]}" adds stock, so the change must be positive.`)
  }

  return errors
}

export function validateReceipt(quantity: number, unitCost: number): string[] {
  const errors: string[] = []

  if (!Number.isFinite(quantity) || quantity <= 0) {
    errors.push('The received quantity must be more than zero.')
  } else if (!Number.isInteger(quantity)) {
    errors.push('The received quantity must be a whole number of units.')
  }

  if (!Number.isFinite(unitCost) || unitCost < 0) {
    errors.push('The unit cost cannot be negative.')
  }

  return errors
}

/**
 * The branch average after a receipt, mirroring `receive_pos_stock`.
 *
 * Used only to preview what a delivery would do to the branch's valuation --
 * the database recomputes it authoritatively. A branch at zero takes the
 * received price outright, which is also what avoids a division by zero.
 */
export function projectedAverageCost(
  currentQuantity: number,
  currentAverage: number,
  receivedQuantity: number,
  receivedUnitCost: number
): number {
  if (receivedQuantity <= 0) return currentAverage
  if (currentQuantity <= 0) return round2(receivedUnitCost)
  return round2(
    (currentQuantity * currentAverage + receivedQuantity * receivedUnitCost) /
      (currentQuantity + receivedQuantity)
  )
}

/** Half away from zero, the way PostgreSQL's round(numeric, 2) does. */
export function round2(value: number): number {
  if (!Number.isFinite(value)) return 0
  const scaled = Number(`${value}e2`)
  if (!Number.isFinite(scaled)) return Math.round(value * 100) / 100
  const rounded = scaled < 0 ? -Math.round(-scaled) : Math.round(scaled)
  return Number(`${rounded}e-2`)
}

/** Sorts the branch's worst problems to the top: out of stock, then low. */
export function inventoryConcernRank(row: Pick<InventoryRow, 'quantity_on_hand' | 'is_low_stock'>): number {
  if (row.quantity_on_hand === 0) return 0
  if (row.is_low_stock) return 1
  return 2
}

export function describeInventoryError(error: unknown): string {
  const message = errorMessage(error)

  if (message.includes('below zero')) {
    // The RPC's own sentence already names the resulting number.
    return message.replace(/^.*?ERROR:\s*/i, '')
  }
  if (message.includes('not carried at this branch')) {
    return 'That product is not carried at this branch any more. Refresh and try again.'
  }
  if (message.includes('Only an Administrator can receive')) {
    return 'Only an Administrator can receive stock. Ask them to record the delivery.'
  }
  if (message.includes('Only an Administrator can adjust')) {
    return 'Only an Administrator can adjust stock.'
  }
  if (message.includes('low-stock level')) {
    return 'Only an Administrator or this branch’s POS Manager can set a low-stock level.'
  }
  if (message.includes('Stock and valuation change only through')) {
    return 'Stock can only be changed by receiving or adjusting it.'
  }
  if (message.includes('pos_inventory_movements_inventory_fk') || message.includes('still referenced')) {
    return 'This branch has inventory history for that product, so it cannot be removed. Disable it instead.'
  }
  if (message.includes('row-level security') || message.includes('permission denied')) {
    return 'You do not have access to change this branch’s stock.'
  }
  return message || 'Something went wrong. Please try again.'
}
