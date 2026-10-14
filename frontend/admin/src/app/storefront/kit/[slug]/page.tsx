'use client'

// Brand kit editor for one brand (URL-encoded brand slug, e.g. /storefront/kit/simmer).

import { useParams } from 'next/navigation'
import { KitEditor } from '../../../../components/storefront/KitEditor'

export default function StorefrontKitEditor() {
  const { slug } = useParams<{ slug: string }>()
  const brand = decodeURIComponent(slug)
  return <KitEditor key={brand} brand={brand} />
}
