import * as React from 'react'
import { Image as ImageIcon, Minus, Plus, Search, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { MoneyInput } from '@/components/MoneyInput'
import { OnlinePaymentPanel } from '@/components/pos/OnlinePaymentPanel'
import { useCreateOnlineCheckout, useRefreshAfterOnlineSale } from '@/hooks/usePosPayment'
import { useSaleDetail } from '@/hooks/usePosTransactions'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
  SelectGroup,
  SelectLabel,
  SelectSeparator,
} from '@/components/ui/select'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog'
import { useAuth } from '@/contexts/AuthContext'
import { useBranches } from '@/hooks/useBranches'
import { usePosCatalogue, useProductImageUrls } from '@/hooks/usePosCatalogue'
import { useBranchFees, useCheckout, type Receipt } from '@/hooks/usePosTill'
import {
  PAYMENT_METHODS,
  ONLINE_METHODS,
  ONLINE_METHOD_LABEL,
  saleMethodLabel,
  isOnlineMethod,
  onlineMethodOf,
  PAYMENT_METHOD_LABEL,
  addToCart,
  attemptFingerprint,
  cartToItems,
  cartTotals,
  changeDue,
  newCheckoutKey,
  nextAttempt,
  peso,
  setLineQuantity,
  validateSale,
  type CartLine,
  type CatalogueProduct,
  type CheckoutAttempt,
  type TillMethod,
} from '@/lib/posTill'

/**
 * The till.
 *
 * Everything shown here is a preview. `checkout_pos_sale` recomputes the price,
 * the fees, the total and the change from the database under lock, and its
 * answer is what is charged — the browser sends only which branch, which
 * products, how many, and how the customer is paying.
 *
 * The checkout key is what makes a double-tap safe: the same sale keeps its
 * key, so a second send returns the sale that already exists instead of
 * charging again. It changes the moment anything about the sale changes.
 */

function ReceiptDialog({ receipt, onClose }: { receipt: Receipt | null; onClose: () => void }) {
  if (!receipt) return null
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Sale complete</DialogTitle>
          <DialogDescription>
            {receipt.company_name ? `${receipt.company_name} · ` : ''}
            {receipt.branch_name} · {new Date(receipt.created_at).toLocaleString()}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1">
            {receipt.items.map((item) => (
              <div key={item.product_name} className="flex justify-between text-sm">
                <span className="text-foreground">
                  {item.product_name} <span className="text-muted-foreground">× {item.quantity}</span>
                </span>
                <span className="tabular-nums text-foreground">{peso(item.line_total)}</span>
              </div>
            ))}
          </div>

          <div className="flex flex-col gap-1 border-t border-border pt-2 text-sm">
            <div className="flex justify-between text-muted-foreground">
              <span>Subtotal</span>
              <span className="tabular-nums">{peso(receipt.subtotal)}</span>
            </div>
            {receipt.fees.map((fee) => (
              <div key={fee.name} className="flex justify-between text-muted-foreground">
                <span>
                  {fee.name} {fee.type === 'percent' ? `(${fee.value}%)` : ''}
                </span>
                <span className="tabular-nums">{peso(fee.amount)}</span>
              </div>
            ))}
            <div className="flex justify-between border-t border-border pt-1 font-medium text-foreground">
              <span>Total</span>
              <span className="tabular-nums">{peso(receipt.total_amount)}</span>
            </div>
          </div>

          <div className="flex flex-col gap-1 border-t border-border pt-2 text-sm text-muted-foreground">
            <div className="flex justify-between">
              <span>Paid by</span>
              <span>{saleMethodLabel(receipt.payment_method)}</span>
            </div>
            {receipt.payment_reference && (
              <div className="flex justify-between">
                <span>Reference</span>
                <span className="tabular-nums">{receipt.payment_reference}</span>
              </div>
            )}
            {receipt.amount_tendered !== null && (
              <>
                <div className="flex justify-between">
                  <span>Cash received</span>
                  <span className="tabular-nums">{peso(receipt.amount_tendered)}</span>
                </div>
                <div className="flex justify-between font-medium text-foreground">
                  <span>Change</span>
                  <span className="tabular-nums">{peso(receipt.change_given ?? 0)}</span>
                </div>
              </>
            )}
            <div className="flex justify-between pt-1">
              <span>Served by</span>
              <span>{receipt.cashier_name}</span>
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button onClick={onClose}>New sale</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export default function PosTillPage() {
  const { profile, posAccess } = useAuth()
  const { data: branches } = useBranches()
  const isAdministrator = profile?.role === 'admin'

  const myBranches = React.useMemo(() => {
    const active = (branches ?? []).filter((b) => b.is_active)
    return isAdministrator ? active : active.filter((b) => posAccess.branchIds.includes(b.id))
  }, [branches, posAccess.branchIds, isAdministrator])

  const [branchId, setBranchId] = React.useState('')
  React.useEffect(() => {
    if (!branchId && myBranches.length > 0) setBranchId(myBranches[0].id)
  }, [branchId, myBranches])

  const { data: catalogue, isLoading } = usePosCatalogue(branchId || undefined)
  const { data: fees } = useBranchFees(branchId || undefined)
  const { data: imageUrls } = useProductImageUrls((catalogue ?? []).map((r) => r.image_path))
  const checkout = useCheckout()

  const [cart, setCart] = React.useState<CartLine[]>([])
  const [search, setSearch] = React.useState('')
  const [method, setMethod] = React.useState<TillMethod>('cash')
  const [reference, setReference] = React.useState('')
  const [tendered, setTendered] = React.useState('')
  const [receipt, setReceipt] = React.useState<Receipt | null>(null)

  // A live online payment. While this is set the till is watching a row it
  // cannot write, and the cart stays put so nothing is lost if the payment
  // fails and the cashier falls back to cash.
  const [onlinePayment, setOnlinePayment] = React.useState<{
    checkoutKey: string
    checkoutUrl: string | null
    amountCentavos: number
    reference: string | null
  } | null>(null)
  const [paidSaleId, setPaidSaleId] = React.useState<string | null>(null)

  const createOnline = useCreateOnlineCheckout()
  const refreshAfterOnlineSale = useRefreshAfterOnlineSale()
  const paidSale = useSaleDetail(paidSaleId)

  // Switching branch abandons the cart: the prices, stock and fees all belong
  // to the branch it was built at.
  React.useEffect(() => {
    setCart([])
    setTendered('')
    setReference('')
    setOnlinePayment(null)
  }, [branchId])

  const products: CatalogueProduct[] = React.useMemo(
    () =>
      (catalogue ?? []).map((row) => ({
        product_id: row.product_id,
        name: row.name,
        category_name: row.category_name,
        selling_price: row.selling_price,
        image_path: row.image_path,
        available_quantity: row.available_quantity,
        is_low_stock: row.is_low_stock,
      })),
    [catalogue]
  )

  const visible = React.useMemo(() => {
    const term = search.trim().toLowerCase()
    if (!term) return products
    return products.filter(
      (p) => p.name.toLowerCase().includes(term) || p.category_name.toLowerCase().includes(term)
    )
  }, [products, search])

  const totals = cartTotals(cart, fees)
  const errors = validateSale({ cart, method, reference, tendered, total: totals.total })
  const change =
    method === 'cash' && tendered.trim() !== '' ? changeDue(totals.total, Number(tendered)) : null

  // The key survives while the sale is unchanged, so a double-tap is one sale.
  const attemptRef = React.useRef<CheckoutAttempt | null>(null)
  const fingerprint = attemptFingerprint({
    branchId: branchId || null,
    items: cartToItems(cart),
    method,
    reference: method === 'cash' || isOnlineMethod(method) ? null : reference.trim() || null,
    tendered: method === 'cash' && tendered.trim() !== '' ? Number(tendered) : null,
  })
  attemptRef.current = nextAttempt(attemptRef.current, fingerprint, newCheckoutKey)

  const inCart = (id: string) => cart.find((l) => l.product.product_id === id)?.quantity ?? 0

  // When an online payment is confirmed, the sale already exists -- the webhook
  // created it. Fetch it and show the same receipt a cash sale shows.
  React.useEffect(() => {
    if (paidSale.data) {
      setReceipt(paidSale.data)
      setCart([])
      setTendered('')
      setReference('')
      setOnlinePayment(null)
      setPaidSaleId(null)
      attemptRef.current = null
      refreshAfterOnlineSale()
    }
  }, [paidSale.data, refreshAfterOnlineSale])

  const pay = () => {
    if (errors.length > 0 || checkout.isPending || createOnline.isPending || !branchId) return

    if (isOnlineMethod(method)) {
      const online = onlineMethodOf(method)
      if (!online) return
      // The till sends products and quantities only. The amount is priced by
      // the database inside the Edge Function, so nothing here can influence
      // what the customer is charged.
      createOnline.mutate(
        {
          branchId,
          items: cartToItems(cart),
          method: online,
          checkoutKey: attemptRef.current!.key,
        },
        {
          onSuccess: (result) => {
            setOnlinePayment({
              checkoutKey: attemptRef.current!.key,
              checkoutUrl: result.checkoutUrl,
              amountCentavos: result.amountCentavos,
              reference: result.reference ?? null,
            })
          },
        }
      )
      return
    }

    checkout.mutate(
      {
        branchId,
        items: cartToItems(cart),
        method,
        checkoutKey: attemptRef.current!.key,
        reference: method === 'cash' ? null : reference.trim(),
        tendered: method === 'cash' ? Number(tendered) : null,
      },
      {
        onSuccess: (result) => {
          setReceipt(result)
          setCart([])
          setTendered('')
          setReference('')
          // The sale is committed; the next one must not reuse its key.
          attemptRef.current = null
        },
      }
    )
  }

  if (myBranches.length === 0) {
    return (
      <Card>
        <CardContent className="py-12 text-center text-sm text-muted-foreground">
          You are not assigned to a branch, so there is no till to open.
        </CardContent>
      </Card>
    )
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="font-display text-xl font-semibold text-foreground">Till</h2>
          <p className="text-sm text-muted-foreground">
            Ring up a sale. Prices and totals are confirmed by the server when you take payment.
          </p>
        </div>
        {myBranches.length > 1 && (
          <Select value={branchId} onValueChange={setBranchId}>
            <SelectTrigger className="w-52" aria-label="Branch">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {myBranches.map((branch) => (
                <SelectItem key={branch.id} value={branch.id}>
                  {branch.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1fr_380px]">
        {/* ------------------------------------------------------- catalogue */}
        <div className="flex flex-col gap-3">
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search products..."
              aria-label="Search products"
              className="pl-9"
            />
          </div>

          {isLoading ? (
            <Skeleton className="h-64 w-full" />
          ) : visible.length === 0 ? (
            <Card>
              <CardContent className="py-12 text-center text-sm text-muted-foreground">
                {products.length === 0
                  ? 'This branch is not offering anything yet.'
                  : 'No product matches that search.'}
              </CardContent>
            </Card>
          ) : (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              {visible.map((p) => {
                const url = p.image_path ? imageUrls?.[p.image_path] : undefined
                const taken = inCart(p.product_id)
                const soldOut = p.available_quantity === 0
                const maxed = taken >= p.available_quantity
                return (
                  <button
                    key={p.product_id}
                    type="button"
                    disabled={soldOut || maxed}
                    aria-label={`Add ${p.name}`}
                    onClick={() => setCart((c) => addToCart(c, p))}
                    className="flex flex-col gap-2 rounded-lg border border-border bg-card p-3 text-left transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    <div className="flex h-16 items-center justify-center rounded-md bg-muted/40">
                      {url ? (
                        <img src={url} alt={p.name} className="h-14 object-contain" />
                      ) : (
                        <ImageIcon className="h-5 w-5 text-muted-foreground" />
                      )}
                    </div>
                    <div>
                      <p className="truncate text-sm font-medium text-foreground">{p.name}</p>
                      <p className="text-xs text-muted-foreground">{p.category_name}</p>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-sm font-medium text-foreground">{peso(p.selling_price)}</span>
                      {soldOut ? (
                        <Badge variant="destructive">Out</Badge>
                      ) : p.is_low_stock ? (
                        <Badge variant="warning">{p.available_quantity} left</Badge>
                      ) : (
                        <span className="text-xs text-muted-foreground">{p.available_quantity}</span>
                      )}
                    </div>
                  </button>
                )
              })}
            </div>
          )}
        </div>

        {/* ------------------------------------------------------------ cart */}
        <Card className="self-start">
          <CardContent className="flex flex-col gap-3 py-4">
            <div className="flex items-center justify-between">
              <h3 className="font-medium text-foreground">Cart</h3>
              {cart.length > 0 && (
                <Button variant="ghost" size="sm" onClick={() => setCart([])}>
                  Clear
                </Button>
              )}
            </div>

            {cart.length === 0 ? (
              <p className="py-8 text-center text-sm text-muted-foreground">
                Tap a product to start a sale.
              </p>
            ) : (
              <div className="flex flex-col gap-2">
                {cart.map((line) => (
                  <div key={line.product.product_id} className="flex items-center gap-2">
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm text-foreground">{line.product.name}</p>
                      <p className="text-xs text-muted-foreground">
                        {peso(line.product.selling_price)} each
                      </p>
                    </div>
                    <div className="flex items-center gap-1">
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7"
                        aria-label={`One less ${line.product.name}`}
                        onClick={() =>
                          setCart((c) => setLineQuantity(c, line.product.product_id, line.quantity - 1))
                        }
                      >
                        <Minus className="h-3 w-3" />
                      </Button>
                      <span className="w-6 text-center text-sm tabular-nums">{line.quantity}</span>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7"
                        aria-label={`One more ${line.product.name}`}
                        disabled={line.quantity >= line.product.available_quantity}
                        onClick={() =>
                          setCart((c) => setLineQuantity(c, line.product.product_id, line.quantity + 1))
                        }
                      >
                        <Plus className="h-3 w-3" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7"
                        aria-label={`Remove ${line.product.name}`}
                        onClick={() => setCart((c) => setLineQuantity(c, line.product.product_id, 0))}
                      >
                        <Trash2 className="h-3 w-3" />
                      </Button>
                    </div>
                    <span className="w-20 text-right text-sm tabular-nums text-foreground">
                      {peso(line.product.selling_price * line.quantity)}
                    </span>
                  </div>
                ))}
              </div>
            )}

            <div className="flex flex-col gap-1 border-t border-border pt-2 text-sm">
              <div className="flex justify-between text-muted-foreground">
                <span>Subtotal ({totals.units} items)</span>
                <span className="tabular-nums">{peso(totals.subtotal)}</span>
              </div>
              {totals.appliedFees.map((fee) => (
                <div key={fee.name} className="flex justify-between text-muted-foreground">
                  <span>
                    {fee.name} {fee.type === 'percent' ? `(${fee.value}%)` : ''}
                  </span>
                  <span className="tabular-nums">{peso(fee.amount)}</span>
                </div>
              ))}
              <div className="flex justify-between border-t border-border pt-1 text-base font-semibold text-foreground">
                <span>Total</span>
                <span className="tabular-nums">{peso(totals.total)}</span>
              </div>
            </div>

            <div className="flex flex-col gap-1.5">
              <Label>Payment</Label>
              <Select value={method} onValueChange={(value) => setMethod(value as TillMethod)}>
                <SelectTrigger aria-label="Payment method">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PAYMENT_METHODS.map((m) => (
                    <SelectItem key={m} value={m}>
                      {PAYMENT_METHOD_LABEL[m]}
                    </SelectItem>
                  ))}
                  {/* Two GCash entries is deliberate and they are not the same
                      thing: the one above records a payment the customer
                      already made and read out, this one collects the payment
                      through JMAC and waits for PayMongo to confirm it. */}
                  <SelectSeparator />
                  <SelectGroup>
                    <SelectLabel>Collect online (test)</SelectLabel>
                    {ONLINE_METHODS.map((m) => (
                      <SelectItem key={'online:' + m} value={'online:' + m}>
                        {ONLINE_METHOD_LABEL[m]}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </div>

            {isOnlineMethod(method) ? (
              onlinePayment ? (
                <OnlinePaymentPanel
                  checkoutKey={onlinePayment.checkoutKey}
                  checkoutUrl={onlinePayment.checkoutUrl}
                  amountCentavos={onlinePayment.amountCentavos}
                  reference={onlinePayment.reference}
                  onPaid={setPaidSaleId}
                  onDismiss={() => {
                    // A fresh key, or the retry is a dead end. The key is
                    // derived from the cart, so an unchanged cart would reuse
                    // the key of the attempt that just failed and the server
                    // would refuse it as already terminal, forever.
                    attemptRef.current = null
                    setOnlinePayment(null)
                  }}
                />
              ) : (
                <p className="rounded-lg border border-border bg-muted/30 p-2 text-xs text-muted-foreground">
                  The customer pays on a PayMongo page. The sale is recorded only once PayMongo
                  confirms the payment, and nothing is deducted from stock before then.
                </p>
              )
            ) : method === 'cash' ? (
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="till_tendered">Cash received</Label>
                {/* Deliberately NOT type="number": browsers accept e, E, +
                    and - in a number field, which is how a symbol reached this
                    field before. MoneyInput sanitises to digits and at most one
                    decimal point, and caps the length. */}
                <MoneyInput
                  id="till_tendered"
                  value={tendered}
                  onValueChange={setTendered}
                  placeholder="0.00"
                />
                {change !== null && change >= 0 && (
                  <p className="text-sm text-foreground">
                    Change <strong className="tabular-nums">{peso(change)}</strong>
                  </p>
                )}
              </div>
            ) : (
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="till_reference">Reference</Label>
                <Input
                  id="till_reference"
                  value={reference}
                  inputMode={method === 'gcash' || method === 'maya' ? 'numeric' : 'text'}
                  maxLength={64}
                  onChange={(e) => {
                    // GCash and Maya references are digits only, and
                    // validateSale enforces 6-32 of them. Stripping here means
                    // the field cannot hold something the rules will refuse.
                    const raw = e.target.value
                    setReference(
                      method === 'gcash' || method === 'maya'
                        ? raw.replace(/[^0-9]/g, '').slice(0, 32)
                        : raw.slice(0, 64)
                    )
                  }}
                  placeholder={method === 'bank' ? 'TRF 2026-0001' : '1234567890'}
                />
                <p className="text-xs text-muted-foreground">
                  Recorded as the customer read it out. It is not confirmation that the payment
                  arrived — check your own account.
                </p>
              </div>
            )}

            {cart.length > 0 && errors.length > 0 && (
              <ul className="flex flex-col gap-1 rounded-lg border border-destructive/40 bg-destructive/5 p-2">
                {errors.map((error) => (
                  <li key={error} className="text-xs text-destructive">
                    {error}
                  </li>
                ))}
              </ul>
            )}

            {createOnline.isError && (
              <p className="rounded-lg border border-destructive/40 bg-destructive/5 p-2 text-xs text-destructive">
                {createOnline.error.message}
              </p>
            )}

            {checkout.isError && (
              <p className="rounded-lg border border-destructive/40 bg-destructive/5 p-2 text-xs text-destructive">
                {checkout.error.message}
              </p>
            )}

            {/* Hidden while a payment is in flight: the customer is at the
                PayMongo page and pressing this again would only start a second
                one. The idempotency key would make that harmless, but showing
                it invites the cashier to think the first attempt failed. */}
            {!onlinePayment && (
              <Button
                className="w-full"
                loading={checkout.isPending || createOnline.isPending}
                disabled={errors.length > 0 || cart.length === 0}
                onClick={pay}
              >
                {isOnlineMethod(method) ? 'Start payment' : 'Take payment'} ·{' '}
                {peso(totals.total)}
              </Button>
            )}
          </CardContent>
        </Card>
      </div>

      <ReceiptDialog receipt={receipt} onClose={() => setReceipt(null)} />
    </div>
  )
}
