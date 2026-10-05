// Draft preview for Admin → Storefront. The token is a short-lived JWT from
// POST /site-layouts/:slug/preview-token; the API returns the DRAFT in the
// same shape as the public read. Never indexed, never counted in stats.
// ?variant=b shows the A/B test's variant B.

import type { Metadata } from 'next'
import type { ReactNode } from 'react'
import { fetchSiteLayout, fetchSiteLayoutPreview, type SiteLayoutRead } from '../../../lib/blocks'
import type { Concept } from '../../../lib/concept'
import { brandAccent, formatBrandName } from '../../../lib/concept'
import { parseHeroBlock } from '../../../lib/heroConfig'
import { SiteLayoutView } from '../../../components/blocks/SiteLayoutView'
import type { RenderContext } from '../../../components/blocks/PageRenderer'
import { HomeClient } from '../../../components/HomeClient'
import { BrandFallback } from '../../../components/brand/BrandFallback'
import { PopupPreview } from '../../../components/popups/PopupHost'

export const dynamic = 'force-dynamic'
export const metadata: Metadata = { title: 'Preview', robots: { index: false, follow: false } }

const API_URL = process.env.INTERNAL_API_URL ?? process.env['NEXT_PUBLIC_API_URL'] ?? 'http://localhost:3001'

async function getConcepts(): Promise<Concept[]> {
  try {
    const res = await fetch(`${API_URL}/api/v1/storefront/concepts`, { cache: 'no-store' })
    return res.ok ? await res.json() as Concept[] : []
  } catch { return [] }
}

/** Render context for this slug: the built-in design a `signature` block
    stands for, plus brand placeholders on a brand page. */
async function contextFor(layout: SiteLayoutRead): Promise<RenderContext> {
  if (layout.slug === 'servd:home') {
    const [concepts, hero] = await Promise.all([getConcepts(), fetchSiteLayout('servd:hero')])
    return { signature: <HomeClient concepts={concepts} heroConfig={parseHeroBlock(hero?.blocks)} /> }
  }
  const m = /^brand:([^:]+)$/.exec(layout.slug)
  if (m) {
    const slug = m[1]!
    const concepts = await getConcepts()
    const found = concepts.find((c) => c.slug === slug)
    if (!found) return { conceptSlug: slug }
    const concept = { ...found, primaryColor: brandAccent(found.slug, found.primaryColor) }
    return {
      conceptSlug: slug,
      signature: <BrandFallback concept={concept} concepts={concepts} />,
      brand: { name: formatBrandName(concept.name), description: concept.description, primaryColor: concept.primaryColor, slug },
    }
  }
  return {}
}

function Strip({ children }: { children: ReactNode }) {
  return (
    <div role="status" style={{
      position: 'sticky', top: 0, zIndex: 70,
      background: 'var(--servd-purple)', color: 'var(--servd-on-purple)', textAlign: 'center',
      fontSize: '0.8rem', fontWeight: 700, letterSpacing: '0.04em', padding: '0.45rem 1rem',
    }}>
      {children}
    </div>
  )
}

export default async function PreviewPage({
  params, searchParams,
}: {
  params: Promise<{ token: string }> | { token: string }
  searchParams?: { variant?: string }
}) {
  const { token } = await Promise.resolve(params as Promise<{ token: string }>)
  const layout = await fetchSiteLayoutPreview(token)
  if (!layout) {
    return (
      <>
        <Strip>Preview — not live</Strip>
        <div className="container" style={{ padding: '4rem 1.25rem', textAlign: 'center', color: 'var(--servd-mute)' }}>
          This preview link has expired or is invalid. Open a fresh preview from the admin.
        </div>
      </>
    )
  }
  const variant = searchParams?.variant === 'b' ? 'b' : 'a'
  const label = `Preview — not live${layout.settings?.ab ? ` · variant ${variant.toUpperCase()}` : ''}`

  if (layout.kind === 'popup' || layout.slug.startsWith('popup:')) {
    return (
      <>
        <Strip>{label}</Strip>
        <PopupPreview layout={layout} />
      </>
    )
  }
  if (layout.slug === 'servd:hero') {
    const concepts = await getConcepts()
    return (
      <>
        <Strip>{label}</Strip>
        <HomeClient concepts={concepts} heroConfig={parseHeroBlock(layout.blocks)} />
      </>
    )
  }
  if (/^brand:[^:]+:footer$/.test(layout.slug)) {
    return (
      <>
        <Strip>{label}</Strip>
        <div className="container" style={{ padding: '4rem 1.25rem', textAlign: 'center', color: 'var(--servd-mute)' }}>
          Footer drafts show on the brand page once approved.
        </div>
      </>
    )
  }

  const context = await contextFor(layout)
  return (
    <>
      <Strip>{label}</Strip>
      {layout.blocks?.length
        ? <SiteLayoutView layout={layout} previewVariant={variant} context={context} />
        : context.signature}
    </>
  )
}
