// /reserve/invite/<token> — someone invited you to their table (owner,
// 2026-10-26). robots.txt keeps these token URLs out of crawlers' reach.

import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'You’re invited to a table',
  robots: { index: false, follow: false },
}

export default function ReserveInviteLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}
