'use client'
// Ordering pages (/flipd, /stackd, /simmer and their menu/checkout) are
// brand-skinned, so they load in the brand's own loader, not the servd butter
// party. Anything else under this segment (an unknown or future slug) gets
// the servd party loader.
import { useParams } from 'next/navigation'
import { BrandLoader, brandLoaderSlug } from '../../components/party/loader/BrandLoader'
import { PartyLoader } from '../../components/party/loader/PartyLoader'

export default function ConceptLoading() {
  const params = useParams<{ concept?: string | string[] }>()
  const raw = params?.concept
  const slug = brandLoaderSlug(Array.isArray(raw) ? raw[0] : raw)
  return slug ? <BrandLoader slug={slug} /> : <PartyLoader />
}
