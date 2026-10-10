// /reserve/confirm/<token> — confirm or cancel a booking from the SMS / email
// link (client page); its title lives here. robots.txt keeps these token URLs
// out of crawlers' reach, so no noindex is needed.

import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'Your reservation',
}

export default function ReserveConfirmLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}
