import * as React from 'react'
import { useSearchParams } from 'react-router-dom'
import { Image as ImageIcon, Minus, Plus, Search, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { Input } from '@/components/ui/input'
import { MoneyInput } from '@/components/MoneyInput'
import { OnlinePaymentPanel } from '@/components/pos/OnlinePaymentPanel'
import {
  useCreateOnlineCheckout,
  useRefreshAfterOnlineSale,
  usePaymentAttempt,
} from '@/hooks/usePosPayment'
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
} from '@/components/ui/select'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog'
import { useAuth } from '@/contexts/AuthContext'
import { useBranches } from '@/hooks/useBranches'
import { usePosCatalogue, useProductImageUrls } from '@/hooks/usePosCatalogue'
import { useBranchFees, useCheckout, type Receipt } from '@/hooks/usePosTill'
import {
  TILL_METHODS,
  TILL_METHOD_LABEL,
  saleMethodLabel,
  isOnlineMethod,
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

/**
 * The receipt for a sale that has already happened.
 *
 * There is no confirm button here, and that is the point. By the time this
 * renders, checkout_pos_sale has committed: the sale exists, stock has moved,
 * and Finance can already see it. A button reading "New sale" sat in the footer
 * and did exactly what the X does -- close the dialog -- but a footer button on
 * a dialog is where a cashier expects the action that finishes the job, and
 * this one finished nothing. Dismissing the receipt is housekeeping, so the X
 * is the whole control.
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

  // Choosing the branch for the first time is not the cashier switching branch.
  // The distinction matters because the two look identical to an effect
  // watching branchId: the page mounts with '', resolves to the cashier's
  // branch a tick later, and an effect that treats every change as "the cashier
  // moved" then abandons whatever the page was holding -- including a payment
  // just recovered from the URL.
  const branchInitialised = React.useRef(false)
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
  // to the branch it was built at. The FIRST resolution of branchId is skipped,
  // because that is the page waking up rather than a decision anybody made.
  React.useEffect(() => {
    if (!branchId) return
    if (!branchInitialised.current) {
      branchInitialised.current = true
      return
    }
    setCart([])
    setTendered('')
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
  const errors = validateSale({ cart, method, tendered, total: totals.total })
  const change =
    method === 'cash' && tendered.trim() !== '' ? changeDue(totals.total, Number(tendered)) : null

  // The key survives while the sale is unchanged, so a double-tap is one sale.
  // Coming back from the payment page.
  //
  // The key in the URL says WHICH attempt to look at and nothing more. Its
  // status is read from the database, which only the signed webhook writes, so
  // typing this URL by hand produces exactly what an unpaid attempt looks like.
  const [searchParams, setSearchParams] = useSearchParams()
  const returnedAttempt = searchParams.get('attempt')

  // The URL is the recovery key, and it is held until the attempt actually
  // finishes. Copying it into state and clearing it immediately made recovery
  // depend on that state surviving the next few milliseconds -- which it did
  // not, because branch hydration wiped it. Holding it means a refresh, a
  // re-render, or a branch resolving late all resume the same attempt.
  React.useEffect(() => {
    if (!returnedAttempt) return
    setOnlinePayment((current) =>
      current?.checkoutKey === returnedAttempt
        ? current
        : { checkoutKey: returnedAttempt, checkoutUrl: null, amountCentavos: 0, reference: null }
    )
  }, [returnedAttempt])

  // Watched at page level, not inside the payment panel. The receipt has to
  // appear whether or not that panel happens to be mounted -- it was the panel
  // going away that lost the sale in the first place.
  const recoveredAttempt = usePaymentAttempt(returnedAttempt, Boolean(returnedAttempt))

  React.useEffect(() => {
    const row = recoveredAttempt.data
    if (!row) return

    // Paid AND finalised. Either alone proves nothing: a paid attempt whose
    // webhook has not landed yet has no sale to show, and paid_unfulfilled has
    // a sale that must not be presented as an ordinary success.
    // The page came back with method defaulting to cash, so the payment panel
    // -- which only renders for an online method -- would not show the payment
    // the cashier is standing in front of. Restore what they actually chose.
    if (row.method && isOnlineMethod(row.method as TillMethod)) {
      setMethod(row.method as TillMethod)
    }

    if (row.status === 'paid' && row.sale_id) {
      setPaidSaleId((current) => current ?? row.sale_id)
    }
  }, [recoveredAttempt.data])

  /** Let go of the recovery key. Called when the attempt has finished and the
   *  cashier has seen the outcome -- never merely because it was read. */
  const clearRecovery = React.useCallback(() => {
    if (returnedAttempt) setSearchParams({}, { replace: true })
  }, [returnedAttempt, setSearchParams])

  const attemptRef = React.useRef<CheckoutAttempt | null>(null)
  const fingerprint = attemptFingerprint({
    branchId: branchId || null,
    items: cartToItems(cart),
    method,
    // No offered method carries a typed reference any more.
    reference: null,
    tendered: method === 'cash' && tendered.trim() !== '' ? Number(tendered) : null,
  })
  attemptRef.current = nextAttempt(attemptRef.current, fingerprint, newCheckoutKey)

  const inCart = (id: string) => cart.find((l) => l.product.product_id === id)?.quantity ?? 0

  // When an online payment is confirmed, the sale already exists -- the webhook
  // created it. Fetch it and show the same receipt a cash sale shows.
  // One sale is handled once. Without this the effect feeds itself: clearing
  // the recovery key changes the callback that clears it, which re-runs the
  // effect, which clears it again. It also means a reload or a duplicate
  // webhook cannot open a second receipt for the same sale.
  const handledSaleRef = React.useRef<string | null>(null)

  React.useEffect(() => {
    // paidSaleId is checked explicitly rather than trusting the query to
    // return nothing for a null id. The receipt must open because THIS till
    // resolved a paid, finalised attempt -- not because a sale happened to be
    // in the cache.
    if (paidSaleId && paidSale.data && handledSaleRef.current !== paidSale.data.sale_id) {
      handledSaleRef.current = paidSale.data.sale_id
      setReceipt(paidSale.data)
      setCart([])
      setTendered('')
      setOnlinePayment(null)
      setPaidSaleId(null)
      attemptRef.current = null
      // The receipt is on screen, so the key has done its job. Released only
      // here -- releasing it earlier is what made recovery fragile.
      clearRecovery()
      refreshAfterOnlineSale()
    }
  }, [paidSaleId, paidSale.data, refreshAfterOnlineSale, clearRecovery])

  const pay = () => {
    if (errors.length > 0 || checkout.isPending || createOnline.isPending || !branchId) return

    if (isOnlineMethod(method)) {
      // The till sends products and quantities only. The amount is priced by
      // the database inside the Edge Function, so nothing here can influence
      // what the customer is charged.
      createOnline.mutate(
        {
          branchId,
          items: cartToItems(cart),
          method,
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
            // Straight to the payment page. The cashier has already said "take
            // payment"; making them press a second button afterwards is the
            // same decision asked twice, with a customer waiting through it.
            //
            // Same tab on purpose: the provider returns to /pos/till with the
            // attempt key, and a popup would strand that return in a window the
            // cashier may have dismissed.
            if (result.checkoutUrl) {
              window.location.assign(result.checkoutUrl)
            }
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
        reference: null,
        tendered: method === 'cash' ? Number(tendered) : null,
      },
      {
        onSuccess: (result) => {
          setReceipt(result)
          setCart([])
          setTendered('')
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
            // A till is scanned, not read. Every card is the same size so the
            // eye can learn where things are: the picture in the same place,
            // the price in the same corner, however long the product's name.
            // auto-rows-fr does the work -- without it one two-line name makes
            // its whole row taller and the grid stops being a grid.
            <div className="grid auto-rows-fr grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-4">
              {visible.map((p) => {
                const url = p.image_path ? imageUrls?.[p.image_path] : undefined
                const taken = inCart(p.product_id)
                const soldOut = p.available_quantity === 0
                const maxed = taken >= p.available_quantity
                const unavailable = soldOut || maxed
                return (
                  <button
                    key={p.product_id}
                    type="button"
                    disabled={unavailable}
                    aria-label={`Add ${p.name}`}
                    onClick={() => setCart((c) => addToCart(c, p))}
                    className={cn(
                      'group flex h-full flex-col overflow-hidden rounded-lg border border-border bg-card text-left transition-all',
                      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
                      unavailable
                        ? // Dimmed enough to read as unavailable, not so far that
                          // the cashier cannot tell what it is or how many are left.
                          'cursor-not-allowed opacity-70'
                        : 'hover:border-secondary/60 hover:shadow-sm active:scale-[0.99]'
                    )}
                  >
                    {/* Fixed ratio, so the image area is identical on every card
                        whatever the source picture happens to measure. */}
                    <div className="relative aspect-[4/3] w-full shrink-0 overflow-hidden bg-muted/40">
                      {url ? (
                        <img
                          src={url}
                          alt=""
                          loading="lazy"
                          className="h-full w-full object-cover transition-transform duration-200 group-hover:scale-[1.03]"
                        />
                      ) : (
                        // Same box, never a collapsed one: a product without a
                        // picture must not change the shape of the grid.
                        <div className="flex h-full w-full items-center justify-center">
                          <ImageIcon className="h-7 w-7 text-muted-foreground/60" />
                        </div>
                      )}
                      {soldOut && (
                        <div className="absolute inset-0 flex items-center justify-center bg-background/60">
                          <Badge variant="destructive">Out of stock</Badge>
                        </div>
                      )}
                    </div>

                    <div className="flex flex-1 flex-col gap-0.5 p-3">
                      {/* Two lines, always. A short name leaves the space empty
                          rather than pulling the price up to meet it. */}
                      <p className="line-clamp-2 min-h-[2.5rem] text-sm font-medium leading-tight text-foreground">
                        {p.name}
                      </p>
                      <p className="truncate text-xs text-muted-foreground">{p.category_name}</p>

                      {/* mt-auto pins this to the bottom, so price and stock sit
                          on one line across the whole grid. */}
                      <div className="mt-auto flex items-end justify-between gap-2 pt-2">
                        <span className="text-base font-semibold tabular-nums text-foreground">
                          {peso(p.selling_price)}
                        </span>
                        {soldOut ? null : p.is_low_stock ? (
                          <Badge variant="warning">{p.available_quantity} left</Badge>
                        ) : maxed ? (
                          <Badge variant="muted">All in cart</Badge>
                        ) : (
                          <span className="text-xs tabular-nums text-muted-foreground">
                            {p.available_quantity} in stock
                          </span>
                        )}
                      </div>
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
                  {/* Five, flat, no groups. Every non-cash method here is
                      settled by PayMongo, so there is nothing left to
                      disambiguate with a heading. */}
                  {TILL_METHODS.map((m) => (
                    <SelectItem key={m} value={m}>
                      {TILL_METHOD_LABEL[m]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {isOnlineMethod(method) ? (
              onlinePayment ? (
                <OnlinePaymentPanel
                  // On a recovered attempt the locally created values are gone
                  // -- the page reloaded -- so the stored row supplies them.
                  // Showing a payment of PHP 0.00 because the browser navigated
                  // would be alarming and wrong.
                  checkoutKey={onlinePayment.checkoutKey}
                  checkoutUrl={onlinePayment.checkoutUrl ?? recoveredAttempt.data?.checkout_url ?? null}
                  amountCentavos={
                    onlinePayment.amountCentavos || recoveredAttempt.data?.amount_centavos || 0
                  }
                  reference={onlinePayment.reference ?? recoveredAttempt.data?.reference_number ?? null}
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
            ) : null}

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
