// Pages the owner adds to a brand in Admin → Storefront ("New page" under the
// brand). SiteLayout `brand:<slug>:<page>`, served at /brand/<slug>/pages/<page>
// and on the brand's own domain at /pages/<page> (middleware rewrite). Only
// the approved copy renders; nothing live → 404.

import type { Metadata } from 'next'
import { fetchSiteLayout } from '../../../../../lib/blocks'
import { ManagedPage } from '../../../../../sections/ManagedPage'

export const dynamic = 'force-dynamic'

type Params = { params: Promise<{ slug: string; page: string }> | { slug: string; page: string } }

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { slug, page } = await Promise.resolve(params as Promise<{ slug: string; page: string }>)
  const layout = await fetchSiteLayout(`brand:${slug}:${page}`)
  return layout?.title ? { title: layout.title } : {}
}

export default async function BrandCustomPage({ params }: Params) {
  const { slug, page } = await Promise.resolve(params as Promise<{ slug: string; page: string }>)
  return <ManagedPage slug={`brand:${slug}:${page}`} notFoundWhenEmpty />
}
