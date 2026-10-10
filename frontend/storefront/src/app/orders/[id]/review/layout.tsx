// /orders/<id>/review — "rate your meal" (client page); its title lives here.
// Not the /orders canonical: this is one order's page.

import type { Metadata } from 'next'

export const metadata: Metadata = {
  title:      'Rate your meal',
  alternates: { canonical: null },
  openGraph:  { type: 'website', siteName: 'servd', locale: 'en_PK', title: 'Rate your meal · servd' },
  twitter:    { card: 'summary_large_image', title: 'Rate your meal · servd' },
}

export default function OrderReviewLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}
