import * as React from 'react'
import { ImagePlus, Link2, Upload, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { cn } from '@/lib/utils'

/**
 * Choosing a product's picture, either way round.
 *
 * Two routes to the same destination. A file from the manager's machine, or a
 * link to one on a supplier's site — because finding the photo, saving it, and
 * uploading it again is three steps to achieve what pasting an address
 * achieves in one, and managers were doing all three.
 *
 * Both end in the same place: an object inside pos-product-images. A link is
 * imported, not referenced, so the till keeps showing the product after the
 * supplier redesigns their website.
 *
 * The component chooses nothing and stores nothing. It hands back either a File
 * or a URL string and lets the caller decide when to act, because Create
 * Product cannot import until the product exists and has an id.
 */

export type ImageChoice =
  | { kind: 'none' }
  | { kind: 'file'; file: File }
  | { kind: 'url'; url: string }

const ACCEPT = '.jpg,.jpeg,.png,.webp,image/jpeg,image/png,image/webp'

export function ProductImagePicker({
  value,
  onChange,
  currentImageUrl,
  onImportNow,
  importing = false,
  disabled = false,
}: {
  value: ImageChoice
  onChange: (next: ImageChoice) => void
  /** A signed URL for the picture the product already has, if any. */
  currentImageUrl?: string | null
  /** Present when the product already exists, so a link can be imported
   *  immediately and previewed as the stored copy. Absent during creation. */
  onImportNow?: (url: string) => void
  importing?: boolean
  disabled?: boolean
}) {
  const [mode, setMode] = React.useState<'upload' | 'url'>('upload')
  const [url, setUrl] = React.useState('')
  const [localError, setLocalError] = React.useState<string | null>(null)
  const fileRef = React.useRef<HTMLInputElement>(null)

  // A preview of a chosen file needs an object URL, and object URLs leak unless
  // they are revoked when the file changes or the dialog closes.
  const [filePreview, setFilePreview] = React.useState<string | null>(null)
  React.useEffect(() => {
    if (value.kind !== 'file') {
      setFilePreview(null)
      return
    }
    const objectUrl = URL.createObjectURL(value.file)
    setFilePreview(objectUrl)
    return () => URL.revokeObjectURL(objectUrl)
  }, [value])

  const preview = filePreview ?? currentImageUrl ?? null

  const chooseFile = (file: File | undefined) => {
    setLocalError(null)
    if (!file) return
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) {
      setLocalError('Choose a JPG, PNG or WebP image.')
      return
    }
    if (file.size > 5 * 1024 * 1024) {
      setLocalError('That image is larger than 5MB.')
      return
    }
    onChange({ kind: 'file', file })
  }

  return (
    <div className="flex flex-col gap-2">
      <Label>Product image</Label>

      <div className="flex flex-wrap items-start gap-3">
        {preview ? (
          <div className="relative">
            <img
              src={preview}
              alt=""
              className="h-20 w-20 rounded-md border border-border object-cover"
            />
            {value.kind !== 'none' && (
              <button
                type="button"
                aria-label="Remove selected image"
                onClick={() => {
                  onChange({ kind: 'none' })
                  setUrl('')
                  setLocalError(null)
                }}
                className="absolute -right-2 -top-2 flex h-5 w-5 items-center justify-center rounded-full border border-border bg-card text-muted-foreground hover:text-foreground"
              >
                <X className="h-3 w-3" />
              </button>
            )}
          </div>
        ) : (
          <div
            aria-hidden="true"
            className="flex h-20 w-20 items-center justify-center rounded-md border border-dashed border-input bg-muted/40 text-muted-foreground"
          >
            <ImagePlus className="h-5 w-5" />
          </div>
        )}

        <div className="flex min-w-[240px] flex-1 flex-col gap-2">
          <div className="flex gap-1.5">
            <Button
              type="button"
              size="sm"
              variant={mode === 'upload' ? 'secondary' : 'outline'}
              disabled={disabled}
              onClick={() => setMode('upload')}
            >
              <Upload className="h-3.5 w-3.5" />
              Upload image
            </Button>
            <Button
              type="button"
              size="sm"
              variant={mode === 'url' ? 'secondary' : 'outline'}
              disabled={disabled}
              onClick={() => setMode('url')}
            >
              <Link2 className="h-3.5 w-3.5" />
              Use image URL
            </Button>
          </div>

          {mode === 'upload' ? (
            <div className="flex flex-col gap-1.5">
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={disabled}
                onClick={() => fileRef.current?.click()}
                className="justify-start"
              >
                {value.kind === 'file' ? value.file.name : 'Choose image…'}
              </Button>
              <input
                ref={fileRef}
                type="file"
                accept={ACCEPT}
                className="sr-only"
                onChange={(e) => chooseFile(e.target.files?.[0])}
              />
              <p className="text-xs text-muted-foreground">JPG, PNG or WebP — up to 5MB.</p>
            </div>
          ) : (
            <div className="flex flex-col gap-1.5">
              <div className="flex gap-2">
                <Input
                  value={url}
                  disabled={disabled}
                  placeholder="https://example.com/product.jpg"
                  onChange={(e) => {
                    setUrl(e.target.value)
                    setLocalError(null)
                    onChange(e.target.value.trim() ? { kind: 'url', url: e.target.value.trim() } : { kind: 'none' })
                  }}
                />
                {/* Only offered once the product exists — an import needs
                    somewhere to file the result. During creation the link is
                    carried and imported the moment the product has an id. */}
                {onImportNow && (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={disabled || url.trim().length === 0}
                    loading={importing}
                    onClick={() => onImportNow(url.trim())}
                  >
                    Import
                  </Button>
                )}
              </div>
              <p className="text-xs text-muted-foreground">
                {onImportNow
                  ? 'We save a copy, so the image keeps working if the source site changes.'
                  : 'We save a copy when the product is created.'}
              </p>
            </div>
          )}

          {localError && <p className="text-xs text-destructive">{localError}</p>}
        </div>
      </div>
    </div>
  )
}

export function imageChoiceIsSet(choice: ImageChoice): boolean {
  return choice.kind !== 'none'
}

/** Shared so the create and edit dialogs cannot drift on the wording. */
export const GLOBAL_FIELD_NOTICE =
  'Product name, category and image are shared across all branches carrying this product.'

export const globalNoticeClass = cn(
  'rounded-md border border-warning/40 bg-warning/5 px-3 py-2 text-xs text-muted-foreground'
)
