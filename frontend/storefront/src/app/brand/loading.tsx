'use client'
// Loading boundary for the whole /brand subtree. Without it, navigating from
// the servd hub to a brand page is caught by the ROOT loading.tsx (the servd
// card) while brand/[slug]/layout.tsx fetches — the [slug]-level loader only
// wraps that segment's page, not its layout. The slug is already in the URL,
// so the brand still loads in its own title card, the one the cut holds on.
import { useParams, usePathname } from 'next/navigation'
import { BrandLoader } from '../../components/party/loader/BrandLoader'
import { cutTitleFor } from '../../lib/film/cut'

export default function BrandSubtreeLoading() {
  const params = useParams<{ slug?: string | string[] }>()
  const pathname = usePathname() ?? '/'
  const raw = params?.slug
  const slug = Array.isArray(raw) ? raw[0] : raw
  return <BrandLoader slug={slug?.toLowerCase()} chapter={brandChapter(pathname)} />
}

/** On a brand's own domain the browser path is "/", not /brand/<slug>; keep
 *  the brand's "now showing" card rather than the servd home title. */
function brandChapter(pathname: string) {
  return pathname.startsWith('/brand/') ? cutTitleFor(pathname) : undefined
}
