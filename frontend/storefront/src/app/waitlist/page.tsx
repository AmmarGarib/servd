// /waitlist — the shareable servd new-brand waitlist link (?src=<tag> for the
// channel). The page is content (SiteLayout `servd:waitlist`, Admin →
// Storefront); nothing published → the default sections (the pitch beside the
// form). Either way one anonymous visit is counted.

import type { Metadata } from 'next'
import { fetchSiteLayout } from '../../lib/blocks'
import { ManagedPage } from '../../sections/ManagedPage'
import { VisitBeacon } from './VisitBeacon'

export const dynamic = 'force-dynamic'

const DESCRIPTION = 'Join the servd waitlist and be first to hear, on WhatsApp, when servd opens a new brand.'

export async function generateMetadata(): Promise<Metadata> {
  const layout = await fetchSiteLayout('servd:waitlist')
  return {
    title: layout?.blocks?.length && layout.title ? layout.title : 'Be first in line',
    description: DESCRIPTION,
    openGraph: { title: 'Be first in line · servd', description: DESCRIPTION },
  }
}

export default async function WaitlistPage() {
  return (
    <>
      <VisitBeacon />
      <ManagedPage slug="servd:waitlist" />
    </>
  )
}
