// /group-order/<code> — one group's live shared cart (client page). Its own
// title rather than the site default. robots.txt already keeps these private
// share-code URLs out of crawlers' reach, so no noindex is needed (a crawler
// that may not fetch the page could never see one).

import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'Your group order',
}

export default function GroupOrderRoomLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}
