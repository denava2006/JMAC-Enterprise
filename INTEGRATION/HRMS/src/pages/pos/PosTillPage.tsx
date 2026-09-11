import * as React from 'react'
import { useSearchParams } from 'react-router-dom'
import { Minus, Plus, Search, ShoppingBasket, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { MoneyInput } from '@/components/MoneyInput'
import { OnlinePaymentPanel } from '@/components/pos/OnlinePaymentPanel'
import { PosProductCard } from '@/components/pos/PosProductCard'
import { PosPaymentMethod } from '@/components/pos/PosPaymentMethod'
import { PosCategoryFilter } from '@/components/pos/PosCategoryFilter'
import {
  useCreateOnlineCheckout,
  useRefreshAfterOnlineSale,
  usePaymentAttempt,
} from '@/hooks/usePosPayment'
import { useSaleDetail } from '@/hooks/usePosTransactions'
import { Label } from '@/components/ui/label'
import { Card, CardContent } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from '@/components/ui/select'
import { PosReceiptDialog } from '@/components/pos/PosReceiptDialog'
import { useAuth } from '@/contexts/AuthContext'
import { useBranches } from '@/hooks/useBranches'
import { usePosCatalogue, useProductImageUrls } from '@/hooks/usePosCatalogue'
import { useBranchFees, useCheckout, type Receipt } from '@/hooks/usePosTill'
import {
  ALL_CATEGORIES,
  categoriesOf,
  visibleProducts,
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
  const [category, setCategory] = React.useState<string>(ALL_CATEGORIES)
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

  // Derived from what the branch is offering, so a new category needs nothing
  // registered here to appear.
  const categories = React.useMemo(() => categoriesOf(products), [products])

  // A chosen category that stops existing -- the last product in it sold out,
  // or the cashier switched branch -- falls back to All rather than filtering
  // the grid down to nothing with no clue why.
  React.useEffect(() => {
    if (category !== ALL_CATEGORIES && !categories.includes(category)) {
      setCategory(ALL_CATEGORIES)
    }
  }, [categories, category])

  const visible = React.useMemo(
    () => visibleProducts(products, { search, category }),
    [products, search, category]
  )

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
    // The till fills the shell and manages its own scrolling, so the settle
    // block below never leaves the screen. min-h-0 on the descendants is what
    // lets an inner column scroll instead of stretching its parent.
    //
    // h-full, not a calc against the viewport: PosLayout's <main> already has a
    // definite height, and subtracting a guessed chrome height from 100dvh put
    // the pay button a few pixels below the fold at 768.
    <div className="flex flex-col gap-4 lg:h-full lg:min-h-0">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="font-display text-xl font-semibold text-foreground">Till</h2>
          <p className="text-sm text-muted-foreground">
            Ring up a sale. Prices and totals are confirmed by the server when you take payment.
          </p>
        </div>
        {myBranches.length > 1 && (
          <Select value={branchId} onValueChange={setBranchId}>
            <SelectTrigger className="h-11 w-52" aria-label="Branch">
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

      {/* 360, not 390: the settle block only needs room for three payment tiles
          across, and the 30px back is what lets the product cards be wider at
          the 1366 the tills actually run at. */}
      <div className="grid min-h-0 grid-cols-1 gap-4 lg:flex-1 lg:grid-cols-[minmax(0,1fr)_360px]">
        {/* ------------------------------------------------------- catalogue */}
        <div className="flex min-h-0 flex-col gap-3">
          {/* Search is the strongest control on the page and the one a cashier
              reaches for by muscle memory, so it stays put while the grid
              scrolls underneath it. */}
          <div className="relative shrink-0">
            <Search
              className="pointer-events-none absolute left-3.5 top-1/2 h-[18px] w-[18px] -translate-y-1/2 text-muted-foreground"
              aria-hidden="true"
            />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search products..."
              aria-label="Search products"
              className="h-12 rounded-xl pl-11 text-base"
            />
          </div>

          {/* Under the search, above the grid -- and it stays put while the
              products scroll, so narrowing by category never means scrolling
              back up first. */}
          <PosCategoryFilter categories={categories} value={category} onChange={setCategory} />

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
            <div className="min-h-0 lg:overflow-y-auto lg:pb-2 lg:pr-1">
              {/* Column counts measured against the real layout rather than
                  guessed from the viewport: the cart takes a fixed width, so
                  the grid's share is roughly (viewport − 256 sidebar − 48
                  padding − cart). That gives ~686px at 1366 and ~1240px at
                  1920, which is why the steps are at 1280 and 1800 rather than
                  at Tailwind's defaults.
                  A minimum width with auto-fill was tried first and cannot do
                  this: any floor low enough to keep three columns at 1366 packs
                  five into 1920 and makes the cards narrower there, not wider. */}
              {/* Both steps are arbitrary min-[] rather than one named and one
                  arbitrary: mixing them let `xl:` be emitted after
                  `min-[1800px]:`, so at 1920 both matched and the narrower rule
                  won. Same form for both means they sort by width. */}
              <div className="grid auto-rows-fr grid-cols-2 gap-3 min-[1280px]:grid-cols-3 min-[1800px]:grid-cols-4">
                {visible.map((p) => (
                  <PosProductCard
                    key={p.product_id}
                    product={p}
                    imageUrl={p.image_path ? imageUrls?.[p.image_path] : undefined}
                    inCart={inCart(p.product_id)}
                    onAdd={() => setCart((c) => addToCart(c, p))}
                  />
                ))}
              </div>
            </div>
          )}
        </div>

        {/* ------------------------------------------------------------ cart */}
        {/* Three bands: a header that names the sale, lines that scroll, and a
            settle block pinned to the bottom. The cashier's two jobs -- build
            the sale, take the money -- never fight each other for the same
            space, and Take payment cannot be scrolled out of reach. */}
        <Card className="flex min-h-0 flex-col overflow-hidden lg:h-full">
          <div className="flex shrink-0 items-center justify-between border-b border-border px-4 py-3">
            <h3 className="font-display font-semibold text-foreground">
              Cart{' '}
              {cart.length > 0 && (
                <span className="tabular-nums text-muted-foreground">({totals.units})</span>
              )}
            </h3>
            {cart.length > 0 && (
              <Button variant="ghost" size="sm" onClick={() => setCart([])}>
                Clear
              </Button>
            )}
          </div>

          {cart.length === 0 ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-2 px-4 py-10 text-center">
              <ShoppingBasket className="h-7 w-7 text-muted-foreground/40" aria-hidden="true" />
              <p className="text-sm text-muted-foreground">Tap a product to start a sale.</p>
            </div>
          ) : (
            <div className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto px-2 py-2">
              {cart.map((line) => (
                <div
                  key={line.product.product_id}
                  className="rounded-lg px-2 py-2 transition-colors hover:bg-muted/50"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium text-foreground">
                        {line.product.name}
                      </p>
                      <p className="text-xs tabular-nums text-muted-foreground">
                        {peso(line.product.selling_price)} each
                      </p>
                    </div>
                    <span className="shrink-0 text-sm font-semibold tabular-nums text-foreground">
                      {peso(line.product.selling_price * line.quantity)}
                    </span>
                  </div>

                  <div className="mt-1.5 flex items-center justify-between gap-2">
                    {/* One stepper, kept together, with 36px targets. Loose
                        icon buttons at 28px were the smallest things on a
                        screen meant to be used with a thumb. */}
                    <div className="flex items-center rounded-lg border border-border bg-card">
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-9 w-9 rounded-r-none"
                        aria-label={`One less ${line.product.name}`}
                        onClick={() =>
                          setCart((c) =>
                            setLineQuantity(c, line.product.product_id, line.quantity - 1)
                          )
                        }
                      >
                        <Minus className="h-3.5 w-3.5" />
                      </Button>
                      <span className="w-9 text-center text-sm font-medium tabular-nums text-foreground">
                        {line.quantity}
                      </span>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-9 w-9 rounded-l-none"
                        aria-label={`One more ${line.product.name}`}
                        disabled={line.quantity >= line.product.available_quantity}
                        onClick={() =>
                          setCart((c) =>
                            setLineQuantity(c, line.product.product_id, line.quantity + 1)
                          )
                        }
                      >
                        <Plus className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-9 w-9 text-muted-foreground hover:text-destructive"
                      aria-label={`Remove ${line.product.name}`}
                      onClick={() => setCart((c) => setLineQuantity(c, line.product.product_id, 0))}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* ---- settle. Everything below this line is about money. ---- */}
          <div className="shrink-0 border-t border-border bg-muted/30 px-4 py-3">
            <div className="flex flex-col gap-1 text-sm">
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
              {/* The number the cashier says out loud. It is the largest thing
                  in the panel because it is the only one that has to be right
                  before money changes hands. */}
              <div className="mt-1 flex items-baseline justify-between border-t border-border pt-2">
                <span className="text-sm font-medium text-foreground">Total</span>
                <span className="font-display text-2xl font-bold leading-none tabular-nums text-foreground">
                  {peso(totals.total)}
                </span>
              </div>
            </div>

            <div className="mt-3 flex flex-col gap-1.5">
              <Label id="till_payment_label" className="text-xs text-muted-foreground">
                Payment
              </Label>
              <PosPaymentMethod value={method} onChange={setMethod} />
            </div>

            {isOnlineMethod(method) ? (
              onlinePayment ? (
                <div className="mt-3">
                  <OnlinePaymentPanel
                    // On a recovered attempt the locally created values are gone
                    // -- the page reloaded -- so the stored row supplies them.
                    // Showing a payment of PHP 0.00 because the browser navigated
                    // would be alarming and wrong.
                    checkoutKey={onlinePayment.checkoutKey}
                    checkoutUrl={
                      onlinePayment.checkoutUrl ?? recoveredAttempt.data?.checkout_url ?? null
                    }
                    amountCentavos={
                      onlinePayment.amountCentavos || recoveredAttempt.data?.amount_centavos || 0
                    }
                    reference={
                      onlinePayment.reference ?? recoveredAttempt.data?.reference_number ?? null
                    }
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
                </div>
              ) : (
                <p className="mt-3 rounded-lg border border-border bg-card p-2.5 text-xs text-muted-foreground">
                  The customer pays on a PayMongo page. The sale is recorded only once PayMongo
                  confirms the payment, and nothing is deducted from stock before then.
                </p>
              )
            ) : method === 'cash' ? (
              <div className="mt-3 flex flex-col gap-1.5">
                <Label htmlFor="till_tendered" className="text-xs text-muted-foreground">
                  Cash received
                </Label>
                {/* Deliberately NOT type="number": browsers accept e, E, +
                    and - in a number field, which is how a symbol reached this
                    field before. MoneyInput sanitises to digits and at most one
                    decimal point, and caps the length. */}
                <MoneyInput
                  id="till_tendered"
                  value={tendered}
                  onValueChange={setTendered}
                  placeholder="0.00"
                  className="h-12 text-right font-display text-lg font-semibold tabular-nums"
                />
                {change !== null && change >= 0 && (
                  // The second number a cashier says out loud, and the one they
                  // count into a hand. Teal, because it is the good outcome.
                  <div className="mt-0.5 flex items-baseline justify-between rounded-lg border border-accent/30 bg-accent/10 px-3 py-2">
                    <span className="text-xs font-medium text-teal-ink">Change due</span>
                    <strong className="font-display text-xl font-bold leading-none tabular-nums text-teal-ink">
                      {peso(change)}
                    </strong>
                  </div>
                )}
              </div>
            ) : null}

            {cart.length > 0 && errors.length > 0 && (
              <ul className="mt-3 flex flex-col gap-1 rounded-lg border border-destructive/40 bg-destructive/5 p-2.5">
                {errors.map((error) => (
                  <li key={error} className="text-xs text-destructive">
                    {error}
                  </li>
                ))}
              </ul>
            )}

            {createOnline.isError && (
              <p className="mt-3 rounded-lg border border-destructive/40 bg-destructive/5 p-2.5 text-xs text-destructive">
                {createOnline.error.message}
              </p>
            )}

            {checkout.isError && (
              <p className="mt-3 rounded-lg border border-destructive/40 bg-destructive/5 p-2.5 text-xs text-destructive">
                {checkout.error.message}
              </p>
            )}

            {/* Hidden while a payment is in flight: the customer is at the
                PayMongo page and pressing this again would only start a second
                one. The idempotency key would make that harmless, but showing
                it invites the cashier to think the first attempt failed. */}
            {!onlinePayment && (
              <Button
                className="mt-3 h-[54px] w-full rounded-xl text-base font-semibold"
                loading={checkout.isPending || createOnline.isPending}
                disabled={errors.length > 0 || cart.length === 0}
                onClick={pay}
              >
                {isOnlineMethod(method) ? 'Start payment' : 'Take payment'} ·{' '}
                {peso(totals.total)}
              </Button>
            )}
          </div>
        </Card>
      </div>

      {/* The same dialog transaction history opens, holding the same receipt
          from the same builder -- so what the cashier prints now and what they
          reprint next year are one document, and Print is here rather than two
          screens away. */}
      <PosReceiptDialog
        open={!!receipt}
        onOpenChange={(next) => !next && setReceipt(null)}
        receipt={receipt}
        title="Sale complete"
        description="Paid and recorded. Print it now, or reprint it any time from Transactions."
      />
    </div>
  )
}
