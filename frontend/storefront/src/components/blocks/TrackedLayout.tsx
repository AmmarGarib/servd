'use client'
import { useCallback, useEffect, useRef, type ReactNode } from 'react'
import { trackLayout } from '../../lib/blocks'
import type { Variant } from '../../lib/abVariant'
import { ConversionContext, isManualConvertTarget } from './conversion'

const API_URL = process.env['NEXT_PUBLIC_API_URL'] ?? ''

// View + conversion beacon for a published SiteLayout page. One `view` per page
// view, one `convert` on the first click on a link or button inside the page —
// except inside blocks that fire their own conversion (see ./conversion).
// Sent for every page (variant 'a' when there is no test) so the owner gets
// numbers either way.
export function TrackedLayout({ slug, version, variant, children }: {
  slug: string
  version: number
  variant: Variant
  children: ReactNode
}) {
  const viewed = useRef(false)
  const converted = useRef(false)

  useEffect(() => {
    if (viewed.current) return
    viewed.current = true
    trackLayout(API_URL, slug, version, variant, 'view')
  }, [slug, version, variant])

  const convert = useCallback(() => {
    if (converted.current) return
    converted.current = true
    trackLayout(API_URL, slug, version, variant, 'convert')
  }, [slug, version, variant])

  const onClickCapture = (e: React.MouseEvent) => {
    const target = e.target as Element | null
    if (!target?.closest?.('a, button') || isManualConvertTarget(target)) return
    convert()
  }

  return (
    <ConversionContext.Provider value={convert}>
      <div onClickCapture={onClickCapture}>{children}</div>
    </ConversionContext.Provider>
  )
}
