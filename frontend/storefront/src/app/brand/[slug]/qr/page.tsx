// /brand/[slug]/qr — printable table-card QR that lands customers
// directly on the brand's menu. Operator opens this page, prints,
// and clips it to the table card.
//
// The QR encodes the menu's CANONICAL URL — the brand's own domain
// (https://stackd.pk/menu), not servd.pk/brand/stackd/menu, which is a
// duplicate that only redirects or canonicalises there. Cards already printed
// with the old URL keep working.
//
// An operator tool, not a landing page: kept out of the index.

import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { QRCard } from './QRCard'

import { SERVD_ORIGIN, brandCanonical, pageMetadata } from '../../../../lib/brandDomains'
import { formatBrandName } from '../../../../lib/concept'
import { resolveConcept } from '../../../../lib/liveConcepts'

type Params = { params: Promise<{ slug: string }> | { slug: string } }

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { slug } = await Promise.resolve(params as Promise<{ slug: string }>)
  const concept = await resolveConcept(slug)
  if (!concept) notFound()
  return pageMetadata({
    title:     'Table QR card',
    canonical: `${SERVD_ORIGIN}/brand/${slug}/qr`,
    siteName:  formatBrandName(concept.name),
    noindex:   true,
  })
}

export default async function BrandQRPage({ params }: Params) {
  const { slug } = await Promise.resolve(params as Promise<{ slug: string }>)
  const concept = await resolveConcept(slug)
  if (!concept) notFound()
  const url = brandCanonical(slug, 'menu')
  return <QRCard slug={slug} brand={formatBrandName(concept.name)} url={url} />
}
