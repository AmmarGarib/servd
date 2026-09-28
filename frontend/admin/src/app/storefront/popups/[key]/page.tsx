'use client'

// Pop-up editor: the page builder plus display rules. Route key is the part
// after `popup:` in the SiteLayout slug.

import { useParams } from 'next/navigation'
import { Builder } from '../../../../components/storefront/Builder'

export default function StorefrontPopupBuilder() {
  const { key } = useParams<{ key: string }>()
  const k = decodeURIComponent(key)
  const slug = k.startsWith('popup:') ? k : `popup:${k}`
  return <Builder key={slug} slug={slug} />
}
