// Draft preview for Admin → Storefront. The token is a short-lived JWT from
// POST /site-layouts/:slug/preview-token; the API returns the DRAFT in the
// same shape as the public read. Never indexed, never counted in stats.
// ?variant=b shows the A/B test's variant B.

import type { Metadata } from 'next'
import type { ReactNode } from 'react'
import { fetchSiteLayoutPreview } from '../../../lib/blocks'
import { ManagedPage } from '../../../sections/ManagedPage'
import { PopupPreview } from '../../../components/popups/PopupHost'

export const dynamic = 'force-dynamic'
export const metadata: Metadata = { title: 'Preview', robots: { index: false, follow: false } }

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
  params: Promise<{ token: string }>
  searchParams?: Promise<{ variant?: string }>
}) {
  const { token } = await params
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
  const variant = (await searchParams)?.variant === 'b' ? 'b' : 'a'
  const label = `Preview — not live${layout.settings?.ab ? ` · variant ${variant.toUpperCase()}` : ''}`

  if (layout.kind === 'popup' || layout.slug.startsWith('popup:')) {
    return (
      <>
        <Strip>{label}</Strip>
        <PopupPreview layout={layout} />
      </>
    )
  }
  // Every page — servd, brand, header, footer, custom — previews through the
  // same resolver the live route uses, with the draft in place of the live copy.
  return (
    <>
      <Strip>{label}</Strip>
      <ManagedPage slug={layout.slug} layout={layout} previewVariant={variant} />
    </>
  )
}
