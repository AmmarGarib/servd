'use client'
// Loading state for brand microsites. Never the servd card — each brand loads
// in its own title card (see BrandLoader), the same frame the cut holds on.
// loading.tsx receives no params, so the slug comes from useParams(); this
// still server-renders, so the loader paints before hydration. On a brand's
// own domain the middleware rewrite still resolves [slug], so the same
// variant shows there.
import { useParams, usePathname } from 'next/navigation'
import { BrandLoader } from '../../../components/party/loader/BrandLoader'
import { cutTitleFor } from '../../../lib/film/cut'

export default function BrandLoading() {
  const params = useParams<{ slug?: string | string[] }>()
  const pathname = usePathname() ?? '/'
  const raw = params?.slug
  const slug = Array.isArray(raw) ? raw[0] : raw
  const chapter = pathname.startsWith('/brand/') ? cutTitleFor(pathname) : undefined
  return <BrandLoader slug={slug?.toLowerCase()} chapter={chapter} />
}
