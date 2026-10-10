// /reserve/claim/<token> — claim a table offered from the waitlist (client
// page); its title lives here. robots.txt keeps these token URLs out of
// crawlers' reach, so no noindex is needed.

import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'Claim your table',
}

export default function ReserveClaimLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}
