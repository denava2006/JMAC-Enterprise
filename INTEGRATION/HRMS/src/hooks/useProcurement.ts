import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase'
import type { Tables, TablesInsert } from '@/lib/database.types'
import { toast } from '@/components/ui/sonner'
import { describeFinanceError } from './useFinanceMasterData'

export type PurchaseOrder = Tables<'purchase_order_status'>
export type PurchaseOrderItem = Tables<'purchase_order_items'>
export type PurchaseOrderSource = Tables<'purchase_order_sources'>
export type ProcurementReceipt = Tables<'procurement_receipts'>

export const PROCUREMENT_KEYS = {
  orders: ['procurement', 'orders'] as const,
  order: (id: string) => ['procurement', 'orders', id] as const,
  items: (id: string) => ['procurement', 'orders', id, 'items'] as const,
  sources: (id: string) => ['procurement', 'orders', id, 'sources'] as const,
  demand: ['procurement', 'demand'] as const,
  deliveries: (branchId: string) => ['procurement', 'deliveries', branchId] as const,
}

/* ------------------------------------------------------------------ orders */

export function usePurchaseOrders() {
  return useQuery({
    queryKey: PROCUREMENT_KEYS.orders,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('purchase_order_status')
        .select('*')
        .order('created_at', { ascending: false })
      if (error) throw error
      return data
    },
  })
}

export function usePurchaseOrderItems(orderId: string | undefined) {
  return useQuery({
    queryKey: PROCUREMENT_KEYS.items(orderId ?? 'none'),
    enabled: !!orderId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('purchase_order_items')
        .select('*, pos_products(name), branches(name)')
        .eq('purchase_order_id', orderId!)
        .order('created_at')
      if (error) throw error
      return data as unknown as (PurchaseOrderItem & {
        pos_products: { name: string } | null
        branches: { name: string } | null
      })[]
    },
  })
}

/** What created this order. A link to the demand, never a copy of it. */
export function usePurchaseOrderSources(orderId: string | undefined) {
  return useQuery({
    queryKey: PROCUREMENT_KEYS.sources(orderId ?? 'none'),
    enabled: !!orderId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('purchase_order_sources')
        .select('*, finance_requests(request_no, title), pos_inventory_requests(id, product_name_snapshot, requested_quantity)')
        .eq('purchase_order_id', orderId!)
      if (error) throw error
      return data as unknown as (PurchaseOrderSource & {
        finance_requests: { request_no: string | null; title: string } | null
        pos_inventory_requests: {
          id: string
          product_name_snapshot: string | null
          requested_quantity: number
        } | null
      })[]
    },
  })
}

function useProcurementMutation<TInput>(
  run: (input: TInput) => Promise<void>,
  success: string,
) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: run,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['procurement'] })
      toast.success(success)
    },
    onError: (error) => toast.error(describeFinanceError(error)),
  })
}

export function useCreatePurchaseOrder() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (input: {
      order: TablesInsert<'purchase_orders'>
      source?: { financeRequestId?: string; posInventoryRequestId?: string }
    }) => {
      const { data, error } = await supabase
        .from('purchase_orders')
        .insert(input.order)
        .select('id')
        .single()
      if (error) throw error

      if (input.source?.financeRequestId || input.source?.posInventoryRequestId) {
        const { error: linkError } = await supabase.from('purchase_order_sources').insert({
          purchase_order_id: data.id,
          finance_request_id: input.source.financeRequestId ?? null,
          pos_inventory_request_id: input.source.posInventoryRequestId ?? null,
        })
        // The order exists either way; a missing link is worth saying so about
        // rather than pretending the order failed.
        if (linkError) toast.error('The order was created but could not be linked to its source.')
      }
      return data.id
    },
    onSuccess: (id) => {
      queryClient.invalidateQueries({ queryKey: ['procurement'] })
      toast.success('Purchase order drafted.')
      return id
    },
    onError: (error) => toast.error(describeFinanceError(error)),
  })
}

export function useSavePurchaseOrderItem() {
  return useProcurementMutation<TablesInsert<'purchase_order_items'>>(async (values) => {
    const { error } = await supabase.from('purchase_order_items').insert(values)
    if (error) throw error
  }, 'Line added.')
}

export function useRemovePurchaseOrderItem() {
  return useProcurementMutation<{ id: string }>(async ({ id }) => {
    const { error } = await supabase.from('purchase_order_items').delete().eq('id', id)
    if (error) throw error
  }, 'Line removed.')
}

/** The one door for a purchase order's status, mirroring the request chain. */
export function useTransitionPurchaseOrder() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (input: { orderId: string; to: string; remarks?: string | null }) => {
      const { error } = await supabase.rpc('transition_purchase_order', {
        _purchase_order_id: input.orderId,
        _to_status: input.to,
        _remarks: input.remarks ?? undefined,
      })
      if (error) throw error
    },
    onSuccess: (_data, input) => {
      queryClient.invalidateQueries({ queryKey: ['procurement'] })
      toast.success(
        input.to === 'approved'
          ? 'Purchase order approved. Nothing is received until the branch confirms delivery.'
          : 'Purchase order updated.',
      )
    },
    onError: (error) => toast.error(describeFinanceError(error)),
  })
}

/* ------------------------------------------------------------------ demand */

/**
 * What is waiting to be procured.
 *
 * Two independent sources, deliberately not merged into a third table: an
 * approved finance request, and a POS stock request a branch raised. Each keeps
 * its own lifecycle and its own home; procurement links to them.
 */
export function useProcurementDemand() {
  return useQuery({
    queryKey: PROCUREMENT_KEYS.demand,
    queryFn: async () => {
      const [requests, stock] = await Promise.all([
        supabase
          .from('finance_requests')
          .select('id, request_no, title, amount, type, status, budget_id')
          .eq('status', 'approved')
          .eq('type', 'purchase')
          .order('created_at', { ascending: false }),
        supabase
          .from('pos_inventory_requests')
          .select('id, branch_id, product_id, requested_quantity, status, branch_name_snapshot, product_name_snapshot, requested_at')
          .eq('status', 'approved')
          .order('requested_at', { ascending: false }),
      ])
      if (requests.error) throw requests.error
      // POS stock requests may not be readable by every finance role; an empty
      // list is a valid answer rather than a failure of the whole page.
      return {
        financeRequests: requests.data ?? [],
        stockRequests: stock.error ? [] : (stock.data ?? []),
      }
    },
  })
}

/* -------------------------------------------------------------- deliveries */

export interface BranchDelivery {
  purchase_order_item_id: string
  po_number: string | null
  expected_delivery_date: string | null
  product_id: string
  product_name: string
  quantity_ordered: number
  quantity_received: number
  quantity_outstanding: number
}

/**
 * What a branch is waiting to receive.
 *
 * Product and quantities only. No unit cost, no line total, no vendor terms:
 * confirming that units arrived is not a reason to learn what the company pays
 * for them. The database function decides that, not this query.
 */
export function useBranchDeliveries(branchId: string | undefined) {
  return useQuery({
    queryKey: PROCUREMENT_KEYS.deliveries(branchId ?? 'none'),
    enabled: !!branchId,
    queryFn: async () => {
      const { data, error } = await supabase.rpc('get_branch_deliveries', { _branch_id: branchId! })
      if (error) throw error
      return (data ?? []) as BranchDelivery[]
    },
  })
}

/**
 * Confirm a physical delivery.
 *
 * The idempotency key is generated once per receiving action and reused on
 * every retry, so a double-click, a refresh mid-flight or a flaky connection
 * produces one receipt and one inventory movement. There is no cost parameter:
 * the server takes it from the approved order line.
 */
export function useReceiveDelivery(branchId: string | undefined) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (input: {
      purchaseOrderItemId: string
      quantity: number
      deliveryReference?: string | null
      idempotencyKey: string
    }) => {
      const { error } = await supabase.rpc('receive_procurement_stock', {
        _purchase_order_item_id: input.purchaseOrderItemId,
        _quantity: input.quantity,
        _delivery_reference: input.deliveryReference ?? undefined,
        _idempotency_key: input.idempotencyKey,
      })
      if (error) throw error
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: PROCUREMENT_KEYS.deliveries(branchId ?? 'none') })
      queryClient.invalidateQueries({ queryKey: ['pos'] })
      queryClient.invalidateQueries({ queryKey: ['branch-inventory'] })
      toast.success('Delivery confirmed. Branch stock has been updated.')
    },
    onError: (error) => toast.error(describeFinanceError(error)),
  })
}

export const PO_STATUS_LABEL: Record<string, string> = {
  draft: 'Draft',
  pending_approval: 'With the Finance Manager',
  approved: 'Approved — awaiting delivery',
  returned: 'Returned for revision',
  rejected: 'Rejected',
  cancelled: 'Cancelled',
  closed: 'Closed',
}
