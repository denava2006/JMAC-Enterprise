import * as React from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase'
import { describeFunctionError } from '@/lib/functionErrors'
import type { OnlineMethod } from '@/lib/posTill'

/**
 * Online payments at the till.
 *
 * The shape of this is dictated by one fact: the till does not decide when a
 * payment succeeded. It asks the server to start one, hands the customer a
 * PayMongo page, and then *watches* a row that only a verified webhook can
 * change. There is deliberately no client-side "mark as paid" of any kind --
 * if there were, a cashier with the browser console open could ring up free
 * merchandise.
 *
 * So the flow is: create -> poll -> the row becomes 'paid' -> show the receipt.
 */

export type PaymentAttemptStatus =
  | 'pending'
  | 'paid'
  | 'paid_unfulfilled'
  | 'failed'
  | 'expired'
  | 'cancelled'

export interface PaymentAttempt {
  id: string
  status: PaymentAttemptStatus
  method: string
  amount_centavos: number
  checkout_url: string | null
  reference_number: string
  sale_id: string | null
  expires_at: string | null
}

export interface CreateCheckoutInput {
  branchId: string
  items: { product_id: string; quantity: number }[]
  method: OnlineMethod
  checkoutKey: string
}

export interface CreatedCheckout {
  attemptId: string
  checkoutUrl: string | null
  amountCentavos: number
  method: string
  reference?: string
  reused?: boolean
  testMode: boolean
}

export function useCreateOnlineCheckout() {
  return useMutation({
    mutationFn: async (input: CreateCheckoutInput): Promise<CreatedCheckout> => {
      const { data, error } = await supabase.functions.invoke('create-paymongo-checkout', {
        body: {
          branchId: input.branchId,
          items: input.items,
          method: input.method,
          checkoutKey: input.checkoutKey,
        },
      })
      if (error) throw new Error(await describeFunctionError(error, 'the payment service'))
      if (data?.error) throw new Error(data.error)
      if (!data?.checkoutUrl) throw new Error('The payment provider did not return a checkout page.')
      return data as CreatedCheckout
    },
  })
}

/**
 * Watch one payment attempt.
 *
 * Polling rather than realtime: a till is a foreground screen for the couple of
 * minutes a customer spends paying, the row is tiny, and polling has no
 * reconnect semantics to get wrong. It stops the moment the status is terminal,
 * so an idle till is not asking anything.
 */
export function usePaymentAttempt(checkoutKey: string | null, enabled: boolean) {
  return useQuery({
    queryKey: ['pos-payment-attempt', checkoutKey],
    enabled: Boolean(checkoutKey) && enabled,
    refetchInterval: (query) => {
      const status = (query.state.data as PaymentAttempt | undefined)?.status
      return status && status !== 'pending' ? false : 3000
    },
    queryFn: async (): Promise<PaymentAttempt | null> => {
      const { data, error } = await supabase
        .from('pos_payment_attempts')
        .select('id, status, method, amount_centavos, checkout_url, reference_number, sale_id, expires_at')
        .eq('checkout_key', checkoutKey!)
        .maybeSingle()
      if (error) throw new Error(error.message)
      return (data as PaymentAttempt | null) ?? null
    },
  })
}

/**
 * Cancel an online payment.
 *
 * Goes through a trusted server endpoint rather than an RPC, because
 * cancelling has to kill the session at PayMongo BEFORE it is recorded
 * locally. The old RPC marked the attempt cancelled while the provider's URL
 * stayed live and payable -- a customer could then pay a basket the till had
 * already written off.
 *
 * The endpoint refuses when the provider says the payment already succeeded,
 * and finalizes it into a sale instead.
 */
export function useCancelPaymentAttempt() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (checkoutKey: string) => {
      const { data, error } = await supabase.functions.invoke('cancel-pos-payment', {
        body: { checkoutKey },
      })
      if (error) throw new Error(await describeFunctionError(error, 'the payment service'))
      if (data?.error) throw new Error(data.error)
      return data as { ok?: boolean; status?: string }
    },
    onSettled: (_data, _error, checkoutKey) => {
      // Settled, not success: a refused cancellation means the payment was in
      // fact paid, and the panel must re-read the row to find that out.
      queryClient.invalidateQueries({ queryKey: ['pos-payment-attempt', checkoutKey] })
    },
  })
}

/** What a cashier should be told about each terminal state, in words that say
 *  what to do next rather than naming a status. */
export function describeAttemptStatus(status: PaymentAttemptStatus): string {
  switch (status) {
    case 'pending':
      return 'Waiting for the customer to pay.'
    case 'paid':
      return 'Paid. Completing the sale.'
    case 'paid_unfulfilled':
      return 'The customer paid, but the sale could not be completed. Do not release the goods — call a manager, this needs a refund decision.'
    case 'failed':
      return 'The payment failed. Start it again or take another method.'
    case 'expired':
      return 'The payment window closed before it was paid. Start it again.'
    case 'cancelled':
      return 'Cancelled at the till.'
  }
}

/** Invalidate everything a completed online sale makes stale. Mirrors what
 *  useCheckout does, because the same sale was created either way. */
export function useRefreshAfterOnlineSale() {
  const queryClient = useQueryClient()
  return React.useCallback(() => {
    for (const key of [
      'pos-catalogue',
      'pos-branch-inventory',
      'pos-inventory-movements',
      'pos-dashboard',
      'pos-transactions',
      'pos-reports',
    ]) {
      queryClient.invalidateQueries({ queryKey: [key] })
    }
  }, [queryClient])
}
