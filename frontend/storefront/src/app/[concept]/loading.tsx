'use client'
// Ordering pages (/flipd, /stackd, /simmer and their menu/checkout) are
// brand-skinned, so they load in the brand's own loader, not the servd butter
// party. Unknown slugs (a wrong door, e.g. /checkout) get the servd hub
// loader inside BrandLoader. useParams() resolves during SSR, so the right
// loader paints from the first byte with no client-only gating.
import { useParams } from 'next/navigation'
import { BrandLoader } from '../../components/party/loader/BrandLoader'

export default function ConceptLoading() {
  const params = useParams<{ concept?: string | string[] }>()
  const raw = params?.concept
  const slug = Array.isArray(raw) ? raw[0] : raw
  return <BrandLoader slug={slug?.toLowerCase()} />
}
