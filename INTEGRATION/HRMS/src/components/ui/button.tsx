import * as React from 'react'
import { Slot } from '@radix-ui/react-slot'
import { cva, type VariantProps } from 'class-variance-authority'
import { Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'

const buttonVariants = cva(
  // `transition`, not the catch-all variant. A button animates its colours, its
  // shadow and its press scale; animating everything additionally puts width,
  // height, padding and margin on the critical path, so any layout change to a
  // button -- a label swapping to a spinner, a responsive size step -- animates
  // geometry and thrashes layout for 150ms. Tailwind's `transition` is the same
  // property list minus the box metrics, so nothing here looks different.
  //
  // The class name is deliberately not written out above: Tailwind scans
  // comments too, and naming it in prose was enough to keep emitting the
  // utility into the stylesheet after the last use of it had gone.
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
  {
    variants: {
      variant: {
        default: 'bg-primary text-primary-foreground shadow-sm hover:bg-navy-2 active:scale-[0.98]',
        secondary: 'bg-secondary text-secondary-foreground shadow-sm hover:opacity-90 active:scale-[0.98]',
        // One step darker than the brand accent, because white on #12a594 is
        // 3.07:1 and this is a filled button carrying normal-size label text.
        // #0c8377 carries white at 4.64:1 and the hover at 6.30:1. The accent
        // itself is untouched and still fills icon backplates, rules and rings,
        // where it is a shape rather than a word.
        accent: 'bg-teal-2 text-accent-foreground shadow-sm hover:bg-teal-ink active:scale-[0.98]',
        // The filled variants already gave way under the cursor; these two did
        // not, so a secondary action felt dead next to a primary one.
        outline: 'border border-input bg-card hover:bg-muted text-foreground active:scale-[0.98]',
        ghost: 'hover:bg-muted text-foreground active:scale-[0.98]',
        destructive: 'bg-destructive text-destructive-foreground shadow-sm hover:opacity-90',
        link: 'text-secondary underline-offset-4 hover:underline',
      },
      size: {
        default: 'h-10 px-4 py-2',
        sm: 'h-9 rounded-md px-3 text-sm',
        lg: 'h-11 rounded-md px-6 text-base',
        icon: 'h-10 w-10',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  }
)

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean
  loading?: boolean
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, loading = false, disabled, children, ...props }, ref) => {
    const Comp = asChild ? Slot : 'button'
    return (
      <Comp
        className={cn(buttonVariants({ variant, size, className }))}
        ref={ref}
        disabled={disabled || loading}
        aria-busy={loading || undefined}
        {...props}
      >
        {asChild ? (
          // Radix Slot requires exactly one element child — the loading spinner can't
          // be a sibling here, so asChild buttons don't render a loading state.
          children
        ) : (
          <>
            {loading && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
            {children}
          </>
        )}
      </Comp>
    )
  }
)
Button.displayName = 'Button'

export { Button, buttonVariants }
