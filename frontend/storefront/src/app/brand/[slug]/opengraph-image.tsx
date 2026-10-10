import { ImageResponse } from 'next/og'
import { notFound } from 'next/navigation'
import { resolveConcept } from '../../../lib/liveConcepts'
import { OG_SIZE, brandCard } from './brandArt'

// The brand's share card (og:image / twitter:image on every page of its site,
// and the image on its Restaurant structured data) — /brand/<slug>/opengraph-image,
// referenced absolutely as brandImageUrl(slug) in lib/jsonLd.ts. The brand's
// own artwork on its own colours (./brandArt.tsx), so a share of stackd.pk
// previews as Stackd, not as servd. The alt is set where the card is
// referenced (the brand layout's metadata), from the live description.

export const size = OG_SIZE
export const contentType = 'image/png'

export default async function BrandOpengraphImage({ params }: { params: { slug: string } }) {
  const concept = await resolveConcept(params.slug)
  if (!concept) notFound()
  const { element, fonts } = await brandCard(concept)
  return new ImageResponse(element, {
    ...size,
    ...(fonts.length > 0 && { fonts }),
    // A day, not the default year-long immutable: the card follows the
    // brand's live description and uploaded artwork.
    headers: { 'cache-control': 'public, max-age=86400, s-maxage=86400' },
  })
}
