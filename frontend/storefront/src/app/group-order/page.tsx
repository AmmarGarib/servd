// /group-order — landing page for shared carts.
// Replaces the legacy dev-facing "type a brand slug" text input with a
// proper grid of live brand cards fetched from the API.
//
// Two modes: "Start" (pick a brand → start a shared cart) and "Join"
// (enter a 6-char code from someone else). After start, redirects to
// /group-order/<code>.

import type { Metadata } from 'next'
import { SERVD_ORIGIN, pageMetadata } from '../../lib/brandDomains'
import { formatBrandName } from '../../lib/concept'
import { liveSectionFields } from '../../sections/liveFields'
import { list } from '../../sections/safe'
import { conceptsOrFallback, fetchLiveConcepts, fitSentences, inBrandOrder, joinNames } from '../../lib/liveConcepts'
import { BlockedNotice } from '../../components/account/BlockedNotice'
import { GroupOrderEntryClient } from './GroupOrderEntryClient'

export const dynamic = 'force-dynamic'

export async function generateMetadata(): Promise<Metadata> {
  // Built from the live brand list, in a fixed order (inBrandOrder — the
  // API's row order moves when a brand is edited): 'Group order from
  // Simmer, Stackd & Flipd'.
  const names = inBrandOrder(conceptsOrFallback(await fetchLiveConcepts())).map((c) => formatBrandName(c.name))
  const list = names.length > 0 && names.length <= 3 ? joinNames(names) : ''
  return pageMetadata({
    title:       list ? `Group order from ${list}` : 'Group order in Karachi',
    description: fitSentences([
      'Start a shared cart, send the link, everyone adds their own — checkout once.',
      `Group orders from ${list || 'every servd kitchen'} in Karachi.`,
    ]),
    canonical:   `${SERVD_ORIGIN}/group-order`,
  })
}

export default async function GroupOrderEntryPage() {
  // The public brand list (GET /storefront/concepts applies the one public-brand
  // rule — active, shown on the storefront, not a test company — so a hidden or
  // no-revenue brand such as G's Kitchen never shows here), in the fixed brand
  // order, as the SAME trading cards as servd home's kitchens section, with
  // that section's own tiles (owner, 2026-10-26).
  const [concepts, kitchens] = await Promise.all([fetchLiveConcepts(), liveSectionFields('servd:home', 'servd.kitchens')])
  const tiles = list<Record<string, unknown>>(kitchens['tiles'])

  return (
    <>
      <BlockedNotice className="container-narrow" style={{ paddingTop: '1rem' }} />
      <GroupOrderEntryClient concepts={inBrandOrder(concepts)} tiles={tiles} />
    </>
  )
}
