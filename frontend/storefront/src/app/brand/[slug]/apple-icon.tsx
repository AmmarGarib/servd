import { ImageResponse } from 'next/og'
import { notFound } from 'next/navigation'
import { resolveConcept } from '../../../lib/liveConcepts'
import { brandMark } from './brandArt'

// The brand's home-screen icon on its own site: the same mark as ./icon.tsx,
// full-bleed (iOS rounds the corners itself). Without it the brand's icon
// would replace servd's favicon but leave no touch icon at all.

export const size = { width: 180, height: 180 }
export const contentType = 'image/png'

export default async function BrandAppleIcon({ params }: { params: { slug: string } }) {
  const concept = await resolveConcept(params.slug)
  if (!concept) notFound()
  const { element, fonts } = await brandMark(concept, size.width, true)
  return new ImageResponse(element, {
    ...size,
    ...(fonts.length > 0 && { fonts }),
    headers: { 'cache-control': 'public, max-age=86400, s-maxage=86400' },
  })
}
