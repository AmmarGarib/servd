// /orders (and /orders/<id>/review) — client pages; their titles live in
// layouts. robots.txt keeps /orders out of crawlers' reach (no noindex needed).

import type { Metadata } from 'next'
import { SERVD_ORIGIN, pageMetadata } from '../../lib/brandDomains'

export const metadata: Metadata = pageMetadata({
  title:       'Your orders',
  description: 'Every servd order you have placed, from every kitchen: track live orders, reorder a favourite and rate your meal.',
  canonical:   `${SERVD_ORIGIN}/orders`,
})

export default function OrdersLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}
