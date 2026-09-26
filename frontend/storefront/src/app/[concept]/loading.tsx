'use client'
// Ordering pages (/flipd, /stackd, /simmer and their menu/checkout) are
// brand-skinned, so they load in the brand's own loader, not the servd butter
// party. Unknown slugs fall back to the neutral ripple inside BrandLoader.
import { useParams } from 'next/navigation'
import { BrandLoader } from '../../components/party/loader/BrandLoader'

export default function ConceptLoading() {
  const params = useParams<{ concept?: string | string[] }>()
  const raw = params?.concept
  const slug = Array.isArray(raw) ? raw[0] : raw
  return <BrandLoader slug={slug?.toLowerCase()} />
}
