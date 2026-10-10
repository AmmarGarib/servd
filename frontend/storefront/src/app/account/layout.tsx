// /account — the page is a client component; its title lives here.
// robots.txt keeps /account out of crawlers' reach (no noindex needed).

import type { Metadata } from 'next'
import { SERVD_ORIGIN, pageMetadata } from '../../lib/brandDomains'

export const metadata: Metadata = pageMetadata({
  title:       'Your account',
  description: 'Your servd account: profile, saved addresses, order history and Insiders points in one place.',
  canonical:   `${SERVD_ORIGIN}/account`,
})

export default function AccountLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}
