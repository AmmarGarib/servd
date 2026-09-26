'use client'
// Loading state for brand microsites. Never the servd butter party — each
// brand loads in its own language (see BrandLoader). loading.tsx receives no
// params, so the slug comes from useParams(); this still server-renders, so
// the loader paints before hydration. On a brand's own domain the middleware
// rewrite still resolves [slug], so the same variant shows there.
import { useParams } from 'next/navigation'
import { BrandLoader } from '../../../components/party/loader/BrandLoader'

export default function BrandLoading() {
  const params = useParams<{ slug?: string | string[] }>()
  const raw = params?.slug
  const slug = Array.isArray(raw) ? raw[0] : raw
  return <BrandLoader slug={slug?.toLowerCase()} />
}
