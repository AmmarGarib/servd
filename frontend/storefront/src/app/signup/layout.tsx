// /signup — the page is a client component; its title and description live
// here. robots.txt keeps /signup out of crawlers' reach (no noindex needed).

import type { Metadata } from 'next'
import { SERVD_ORIGIN, pageMetadata } from '../../lib/brandDomains'

export const metadata: Metadata = pageMetadata({
  title:       'Create an account',
  description: 'Create a servd account with one code: order from every kitchen, track your orders and earn Insiders rewards on each one.',
  canonical:   `${SERVD_ORIGIN}/signup`,
})

export default function SignupLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}
