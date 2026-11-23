import { ImageResponse } from 'next/og'
import { notFound } from 'next/navigation'
import { resolveConcept } from '../../lib/liveConcepts'
import { brandMark } from '../brand/[slug]/brandArt'

// The brand's favicon on its ordering screen (/<concept>, also stackd.pk/stackd): the same art as /brand/<slug>/icon.
// Next emits <link rel="icon"> for every page under /<concept> (menu, checkout, tracking), replacing servd's icon.
// 96px: a multiple of 48, as Google's favicon rules ask.

export const size = { width: 96, height: 96 }
export const contentType = 'image/png'

export default async function BrandIcon({ params }: { params: Promise<{ concept: string }> }) {
  const concept = await resolveConcept((await params).concept)
  if (!concept) notFound()
  const { element, fonts } = await brandMark(concept, size.width)
  return new ImageResponse(element, {
    ...size,
    ...(fonts.length > 0 && { fonts }),
    headers: { 'cache-control': 'public, max-age=86400, s-maxage=86400' },
  })
}
