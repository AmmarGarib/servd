'use client'
import type { ReactNode } from 'react'
import { usePathname } from 'next/navigation'
import { useOnBrandMicrosite } from '../lib/host'

// The gate for the servd global footer. The footer itself is content — the
// `servd:footer` page (section `servd.footer`), rendered on the server by
// app/layout.tsx and passed in as children. This decides, on every
// navigation, whether it shows.

export function StorefrontFooter({ initialBrandSlug = null, children }: { initialBrandSlug?: string | null; children: ReactNode }) {
  // Brand microsites render their own BrandFooter (via BrandShell); the global
  // servd footer must hide there or those pages show two footers.
  //
  // The /brand/* path test alone was not enough. On a brand's OWN domain the
  // browser's path is "/", so every microsite page was ending with servd's
  // footer stacked under the brand's — 664px of it on desktop, carrying
  // servd's own CTA and named links to the two rival sibling brands, on
  // domains whose entire purpose is to read as an independent restaurant.
  // Both checks are kept: the path one covers servd.pk/brand/<slug>.
  const pathname = usePathname() ?? '/'
  const onBrandMicrosite = useOnBrandMicrosite(initialBrandSlug)
  if (onBrandMicrosite || pathname.startsWith('/brand/')) return null
  return <>{children}</>
}
