'use client'
import { useEffect, useRef, type ReactNode } from 'react'
import { trackLayout } from '../../lib/blocks'
import type { Variant } from '../../lib/abVariant'

const API_URL = process.env['NEXT_PUBLIC_API_URL'] ?? ''

// View + conversion beacon for a published SiteLayout page. One `view` per page
// view, one `convert` on the first click on a link or button inside the page.
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

  const onClickCapture = (e: React.MouseEvent) => {
    if (converted.current) return
    const target = e.target as Element | null
    if (!target?.closest?.('a, button')) return
    converted.current = true
    trackLayout(API_URL, slug, version, variant, 'convert')
  }

  return <div onClickCapture={onClickCapture}>{children}</div>
}
