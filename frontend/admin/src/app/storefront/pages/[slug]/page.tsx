'use client'

// Page builder for one storefront page (slug URL-encoded, e.g. brand%3Aflipd).

import { useParams } from 'next/navigation'
import { Builder } from '../../../../components/storefront/Builder'

export default function StorefrontPageBuilder() {
  const { slug } = useParams<{ slug: string }>()
  const decoded = decodeURIComponent(slug)
  return <Builder key={decoded} slug={decoded} />
}
