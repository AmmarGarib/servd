'use client'
// Ordering pages (/flipd, /stackd, /simmer and their checkout and tracker)
// load in the brand's own title card, the same frame the cut holds on, so the
// cut opens straight onto it. Anything that isn't a brand (a servd page that
// falls through to this segment) gets the servd card instead.
import { useParams, usePathname } from 'next/navigation'
import { BrandLoader } from '../../components/party/loader/BrandLoader'
import { PartyLoader } from '../../components/party/loader/PartyLoader'
import { cutThemeFor, cutTitleFor, statusFor } from '../../lib/film/cut'

export default function ConceptLoading() {
  const params = useParams<{ concept?: string | string[] }>()
  const pathname = usePathname() ?? '/'
  const raw = params?.concept
  const slug = (Array.isArray(raw) ? raw[0] : raw)?.toLowerCase()
  const chapter = cutTitleFor(pathname)
  const status = statusFor(pathname)
  if (cutThemeFor(pathname) === 'servd') return <PartyLoader chapter={chapter} status={status} />
  return <BrandLoader slug={slug} chapter={chapter} status={status} />
}
