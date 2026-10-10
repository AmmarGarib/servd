// /login — the page is a client component; its title and description live
// here. robots.txt keeps /login out of crawlers' reach (no noindex needed —
// a crawler that may not fetch the page could never read one).

import type { Metadata } from 'next'
import { SERVD_ORIGIN, pageMetadata } from '../../lib/brandDomains'

export const metadata: Metadata = pageMetadata({
  title:       'Sign in',
  description: 'Sign in to your servd account to order from every kitchen, track your orders and collect Insiders rewards.',
  canonical:   `${SERVD_ORIGIN}/login`,
})

export default function LoginLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}
