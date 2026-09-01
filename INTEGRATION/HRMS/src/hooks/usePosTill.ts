import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase'
import type { Json } from '@/lib/database.types'
import { parseFees, type Fee } from '@/lib/posFees'
import { describeCheckoutError, type StoredPaymentMethod } from '@/lib/posTill'

/**
 * The till's data.
 *
 * Checkout is a single RPC that does everything: it derives the price, the
 * fees, the cost and the cashier itself, takes the locks, writes the sale, its
 * lines, the stock deduction and the movements, and returns a receipt. There is
 * no client-side sequence to get wrong, and no partial state to clean up if it
 * fails.
 *
 * What goes over the wire is only what the browser legitimately knows.
 */

export interface Receipt {
  sale_id: string
  created_at: string
  status: string
  company_name: string | null
  branch_name: string
  branch_address: string | null
  branch_phone: string | null
  cashier_name: string
  items: {
    product_name: string
    category_name: string
    quantity: number
    unit_price: number
    line_total: number
  }[]
  subtotal: number
  fees: { name: string; type: string; value: number; amount: number }[]
  fees_total: number
  total_amount: number
  /** What the sale STORED, which includes methods the till no longer offers.
   *  Render it with saleMethodLabel, never by indexing the menu. */
  payment_method: string
  payment_reference: string | null
  amount_tendered: number | null
  change_given: number | null
}

/** A branch's fee configuration, for the till's running total. The database
 * applies its own copy at checkout; this only previews it. */
export function useBranchFees(branchId: string | undefined) {
  return useQuery({
    queryKey: ['branch-pos-fees', branchId ?? 'none'],
    enabled: !!branchId,
    queryFn: async (): Promise<Fee[]> => {
      const { data, error } = await supabase
        .from('branch_pos_settings')
        .select('fees')
        .eq('branch_id', branchId!)
        .maybeSingle()
      if (error) throw error
      return parseFees(data?.fees)
    },
  })
}

export interface CheckoutInput {
  branchId: string
  items: { product_id: string; quantity: number }[]
  method: StoredPaymentMethod
  checkoutKey: string
  reference?: string | null
  tendered?: number | null
}

export function useCheckout() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (input: CheckoutInput): Promise<Receipt> => {
      const { data, error } = await supabase.rpc('checkout_pos_sale', {
        _branch_id: input.branchId,
        _items: input.items as unknown as Json,
        _payment_method: input.method,
        _checkout_key: input.checkoutKey,
        _payment_reference: input.reference ?? undefined,
        _amount_tendered: input.tendered ?? undefined,
      })
      if (error) throw new Error(describeCheckoutError(error))
      if (!data) throw new Error('The sale did not return a receipt.')
      return data as unknown as Receipt
    },
    onSuccess: () => {
      // Stock moved, so the catalogue and every inventory view are stale.
      queryClient.invalidateQueries({ queryKey: ['pos-catalogue'] })
      queryClient.invalidateQueries({ queryKey: ['pos-branch-inventory'] })
      queryClient.invalidateQueries({ queryKey: ['pos-inventory-movements'] })
      queryClient.invalidateQueries({ queryKey: ['pos-dashboard'] })
      queryClient.invalidateQueries({ queryKey: ['pos-transactions'] })
      queryClient.invalidateQueries({ queryKey: ['pos-reports'] })
    },
  })
}
