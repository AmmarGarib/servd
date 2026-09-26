'use client'
// Loading boundary for the whole /brand subtree. Without it, navigating from
// the servd hub to a brand page is caught by the ROOT loading.tsx (the servd
// butter party) while brand/[slug]/layout.tsx fetches — the [slug]-level
// loader only wraps that segment's page, not its layout. The slug is already
// in the URL, so the brand still gets its own loader.
import { useParams } from 'next/navigation'
import { BrandLoader } from '../../components/party/loader/BrandLoader'

export default function BrandSubtreeLoading() {
  const params = useParams<{ slug?: string | string[] }>()
  const raw = params?.slug
  const slug = Array.isArray(raw) ? raw[0] : raw
  return <BrandLoader slug={slug?.toLowerCase()} />
}
