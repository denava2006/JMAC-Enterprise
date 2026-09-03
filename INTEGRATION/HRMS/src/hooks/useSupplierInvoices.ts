import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase'
import type { Tables } from '@/lib/database.types'
import { toast } from '@/components/ui/sonner'
import { describeFinanceError } from './useFinanceMasterData'

/**
 * Supplier invoices and what the company owes on them.
 *
 * The document is recorded by the Accountant and decided by the Finance
 * Manager, and the server refuses everything else -- these hooks mirror that
 * rather than deciding it. Nothing here touches a budget, a purchase order or
 * a quantity of stock: an invoice is a statement of what a supplier is
 * charging, and agreeing to owe it moves no money.
 */

export type SupplierInvoice = Tables<'supplier_invoice_status'>
export type SupplierInvoiceLine = Tables<'supplier_invoice_lines'>
export type SupplierInvoiceHistory = Tables<'supplier_invoice_history'>

export const INVOICE_KEYS = {
  all: ['supplier-invoices'] as const,
  list: ['supplier-invoices', 'list'] as const,
  lines: (id: string) => ['supplier-invoices', id, 'lines'] as const,
  match: (id: string) => ['supplier-invoices', id, 'match'] as const,
  history: (id: string) => ['supplier-invoices', id, 'history'] as const,
  invoiceable: ['supplier-invoices', 'invoiceable'] as const,
}

export const INVOICE_STATUS_LABEL: Record<string, string> = {
  draft: 'Draft',
  for_review: 'With the Finance Manager',
  approved: 'Approved — awaiting payment',
  returned: 'Returned for correction',
  rejected: 'Rejected',
  voided: 'Voided',
}

/** One row of the three-way match, as the database computes it. */
export interface InvoiceMatchRow {
  line_id: string
  purchase_order_item_id: string
  description: string
  ordered_quantity: number
  cancelled_quantity: number
  effective_quantity: number
  received_quantity: number
  previously_invoiced: number
  billable_quantity: number
  invoice_quantity: number
  po_unit_cost: number
  invoice_unit_cost: number
  po_line_value: number
  invoice_line_value: number
  quantity_matched: boolean
  price_matched: boolean
  verdict: 'matched' | 'quantity_mismatch' | 'price_mismatch'
}

/** A completed purchase order with value still to be billed. */
export interface InvoiceablePurchaseOrder {
  purchase_order_id: string
  po_number: string
  vendor_id: string
  vendor_name: string
  status: string
  received_value: number
  invoiced_value: number
  outstanding_value: number
}

export function useSupplierInvoices() {
  return useQuery({
    queryKey: INVOICE_KEYS.list,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('supplier_invoice_status')
        .select('*')
        .order('created_at', { ascending: false })
      if (error) throw error
      return data
    },
  })
}

export function useSupplierInvoiceLines(invoiceId: string | undefined) {
  return useQuery({
    queryKey: INVOICE_KEYS.lines(invoiceId ?? 'none'),
    enabled: !!invoiceId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('supplier_invoice_lines')
        .select('*')
        .eq('supplier_invoice_id', invoiceId!)
        .order('created_at')
      if (error) throw error
      return data
    },
  })
}

/**
 * The three-way match.
 *
 * Read from the server, never recomputed here. The approval guard reads the
 * same function, so what an approver is shown and what the database will
 * accept cannot drift apart -- a UI that computed its own verdict would
 * eventually disagree with the one that matters.
 */
export function useInvoiceMatch(invoiceId: string | undefined) {
  return useQuery({
    queryKey: INVOICE_KEYS.match(invoiceId ?? 'none'),
    enabled: !!invoiceId,
    queryFn: async (): Promise<InvoiceMatchRow[]> => {
      const { data, error } = await supabase.rpc('supplier_invoice_match', {
        _supplier_invoice_id: invoiceId!,
      })
      if (error) throw error
      return (data ?? []) as unknown as InvoiceMatchRow[]
    },
  })
}

export function useInvoiceHistory(invoiceId: string | undefined) {
  return useQuery({
    queryKey: INVOICE_KEYS.history(invoiceId ?? 'none'),
    enabled: !!invoiceId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('supplier_invoice_history')
        .select('*')
        .eq('supplier_invoice_id', invoiceId!)
        .order('created_at')
      if (error) throw error
      return data
    },
  })
}

/** Completed procurement nobody has billed in full yet. */
export function useInvoiceablePurchaseOrders() {
  return useQuery({
    queryKey: INVOICE_KEYS.invoiceable,
    queryFn: async (): Promise<InvoiceablePurchaseOrder[]> => {
      const { data, error } = await supabase.rpc('get_invoiceable_purchase_orders')
      if (error) throw error
      return (data ?? []) as unknown as InvoiceablePurchaseOrder[]
    },
  })
}

export function useCreateSupplierInvoice() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (input: {
      purchaseOrderId: string
      supplierInvoiceNumber: string
      invoiceDate: string
      dueDate: string | null
      lines: Array<{ purchase_order_item_id: string; quantity: number; unit_cost: number }>
      taxAmount: number
      otherCharges: number
      otherChargesNote: string | null
      notes: string | null
    }) => {
      const { data, error } = await supabase.rpc('create_supplier_invoice', {
        _purchase_order_id: input.purchaseOrderId,
        _supplier_invoice_number: input.supplierInvoiceNumber,
        _invoice_date: input.invoiceDate,
        _due_date: input.dueDate ?? undefined,
        _lines: input.lines,
        _tax_amount: input.taxAmount,
        _other_charges: input.otherCharges,
        _other_charges_note: input.otherChargesNote ?? undefined,
        _notes: input.notes ?? undefined,
      })
      if (error) throw error
      return data as unknown as string
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: INVOICE_KEYS.all })
      toast.success('Supplier invoice recorded as a draft.')
    },
    onError: (error) => toast.error(describeFinanceError(error)),
  })
}

export function useTransitionSupplierInvoice() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (input: { invoiceId: string; to: string; remarks?: string | null }) => {
      const { error } = await supabase.rpc('transition_supplier_invoice', {
        _supplier_invoice_id: input.invoiceId,
        _to_status: input.to,
        _remarks: input.remarks ?? undefined,
      })
      if (error) throw error
    },
    onSuccess: (_data, input) => {
      queryClient.invalidateQueries({ queryKey: INVOICE_KEYS.all })
      toast.success(
        input.to === 'approved'
          ? 'Invoice approved. It is now payable — nothing has been paid.'
          : 'Supplier invoice updated.',
      )
    },
    onError: (error) => toast.error(describeFinanceError(error)),
  })
}
