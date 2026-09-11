import { Image as ImageIcon } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'
import { peso, type CatalogueProduct } from '@/lib/posTill'

/**
 * One product, as a till tile.
 *
 * A till is scanned, not read. Every card is the same shape so the eye can
 * learn where things are -- the picture in the same place, the price in the
 * same corner, however long the product's name. `auto-rows-fr` on the grid and
 * `h-full` here do that work together; without them one two-line name makes its
 * whole row taller and the grid stops being a grid.
 *
 * The whole card is the button. A cashier reaching for a 2cm target on a
 * touchscreen should not have to find a smaller one inside it.
 */
export function PosProductCard({
  product,
  imageUrl,
  inCart,
  onAdd,
}: {
  product: CatalogueProduct
  imageUrl?: string
  /** How many are already on the sale, so the card can say when it is spent. */
  inCart: number
  onAdd: () => void
}) {
  const soldOut = product.available_quantity === 0
  const maxed = inCart >= product.available_quantity
  const unavailable = soldOut || maxed

  return (
    <button
      type="button"
      disabled={unavailable}
      aria-label={`Add ${product.name}`}
      onClick={onAdd}
      className={cn(
        'group relative flex h-full flex-col overflow-hidden rounded-xl border bg-card text-left',
        // Colours, shadow and the press scale -- not the tile's box metrics.
        // A till grid redraws constantly and has no business animating width or
        // height when a card is tapped.
        'transition duration-150',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
        unavailable
          ? // Dimmed enough to read as unavailable, not so far that the cashier
            // cannot tell what it is or how many are left.
            'cursor-not-allowed border-border opacity-60'
          : 'border-border hover:-translate-y-0.5 hover:border-primary/30 hover:shadow-md active:translate-y-0 active:scale-[0.99]'
      )}
    >
      {/* Fixed ratio, so the image area is identical on every card whatever the
          source picture happens to measure.
          Square rather than 4:3: most product shots are portrait -- a bottle, a
          sachet, a can -- and in a landscape box `contain` fits them to the
          short side, which left the picture floating in a band of empty grey.
          A square box gives that same contained image most of its height back
          without cropping anything. */}
      <div className="relative aspect-square w-full shrink-0 overflow-hidden bg-card">
        {imageUrl ? (
          <img
            src={imageUrl}
            alt=""
            loading="lazy"
            // contain, not cover: a bottle photographed portrait must not be
            // cropped to a square. The product sits whole on a neutral ground,
            // which is how it looks on the shelf.
            className="h-full w-full object-contain p-1 transition-transform duration-200 group-hover:scale-[1.04]"
          />
        ) : (
          // Same box, never a collapsed one: a product without a picture must
          // not change the shape of the grid. Tinted, so the gap reads as "no
          // photograph" rather than as a photograph of nothing.
          <div className="flex h-full w-full items-center justify-center bg-muted/50">
            <ImageIcon className="h-7 w-7 text-muted-foreground/50" aria-hidden="true" />
          </div>
        )}

        {soldOut && (
          <div className="absolute inset-0 flex items-center justify-center bg-card/70 backdrop-blur-[1px]">
            <Badge variant="destructive">Out of stock</Badge>
          </div>
        )}
      </div>

      <div className="flex flex-1 flex-col gap-0.5 px-3 pb-3 pt-2.5">
        {/* Two lines, always. A short name leaves the space empty rather than
            pulling the price up to meet it. */}
        <p className="line-clamp-2 min-h-[2.5rem] text-sm font-medium leading-tight text-foreground">
          {product.name}
        </p>
        <p className="truncate text-xs text-muted-foreground">{product.category_name}</p>

        {/* mt-auto pins this to the bottom, so price and stock sit on one line
            across the whole grid. */}
        <div className="mt-auto flex items-end justify-between gap-1.5 pt-2.5">
          <span className="font-display text-[17px] font-bold leading-none tabular-nums text-foreground">
            {peso(product.selling_price)}
          </span>
          {/* Never wraps. A stock line breaking onto a second row pushes the
              price out of line with the card beside it, which is the one thing
              a scannable grid cannot afford. */}
          {soldOut ? null : product.is_low_stock ? (
            <Badge variant="warning" className="whitespace-nowrap">
              {product.available_quantity} left
            </Badge>
          ) : maxed ? (
            <Badge variant="muted" className="whitespace-nowrap">
              All in cart
            </Badge>
          ) : (
            <span className="truncate whitespace-nowrap text-xs tabular-nums text-muted-foreground">
              {product.available_quantity} in stock
            </span>
          )}
        </div>
      </div>

      {/* How many are already on the sale. Sits on the card rather than only in
          the cart, so a cashier adding a third of something can see it is the
          third without looking away from the grid. */}
      {inCart > 0 && (
        <span
          className="absolute right-2 top-2 flex h-6 min-w-6 items-center justify-center rounded-full bg-primary px-1.5 text-xs font-semibold tabular-nums text-primary-foreground shadow-sm"
          aria-hidden="true"
        >
          {inCart}
        </span>
      )}
    </button>
  )
}
