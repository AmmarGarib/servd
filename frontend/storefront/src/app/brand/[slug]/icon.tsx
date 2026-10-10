import { ImageResponse } from 'next/og'
import { notFound } from 'next/navigation'
import { resolveConcept } from '../../../lib/liveConcepts'
import { brandMark } from './brandArt'

// The brand's favicon on its own site (stackd.pk, simmer.pk, flipd.pk): the
// header's disc — the brand accent with its logo or monogram (./brandArt.tsx).
// Next emits <link rel="icon"> for every page under /brand/<slug>, replacing
// servd's icon there. 96px: a multiple of 48, as Google's favicon rules ask.

export const size = { width: 96, height: 96 }
export const contentType = 'image/png'

export default async function BrandIcon({ params }: { params: { slug: string } }) {
  const concept = await resolveConcept(params.slug)
  if (!concept) notFound()
  const { element, fonts } = await brandMark(concept, size.width)
  return new ImageResponse(element, {
    ...size,
    ...(fonts.length > 0 && { fonts }),
    headers: { 'cache-control': 'public, max-age=86400, s-maxage=86400' },
  })
}
