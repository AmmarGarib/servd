// Custom storefront pages built in Admin → Storefront → Pages, stored as the
// SiteLayout `page:<slug>` and served at /pages/<slug>. Only the approved
// (live) copy renders; nothing live → 404.

import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { fetchSiteLayout } from '../../../lib/blocks'
import { SiteLayoutView } from '../../../components/blocks/SiteLayoutView'

export const dynamic = 'force-dynamic'

type Params = { params: Promise<{ slug: string }> | { slug: string } }

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { slug } = await Promise.resolve(params as Promise<{ slug: string }>)
  const layout = await fetchSiteLayout(`page:${slug}`)
  return layout?.title ? { title: layout.title } : {}
}

export default async function CustomPage({ params }: Params) {
  const { slug } = await Promise.resolve(params as Promise<{ slug: string }>)
  const layout = await fetchSiteLayout(`page:${slug}`)
  if (!layout?.blocks?.length) notFound()
  return <SiteLayoutView layout={layout} />
}
