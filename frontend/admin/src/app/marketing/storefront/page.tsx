'use client'
import { useQuery } from '@tanstack/react-query'
import Link from 'next/link'
import { api } from '../../../lib/api'

interface Concept {
  id: string
  name: string
  slug: string
  primaryColor: string | null
  logoUrl: string | null
  storefrontVisible: boolean
  heroTagline: string | null
  announcementBanner: string | null
}

const STOREFRONT_HOST = process.env['NEXT_PUBLIC_STOREFRONT_HOST'] ?? 'http://localhost:3002'

export default function StorefrontDesignerPage() {
  const { data: concepts = [], isLoading } = useQuery<Concept[]>({
    queryKey: ['concepts'],
    queryFn: () => api.get('/concepts'),
  })

  return (
    <div className="min-h-screen" style={{ background: '#090a0e' }}>
      <header className="px-7 py-6 border-b border-white/[0.05]">
        <p className="text-[10px] font-black uppercase tracking-[0.3em] text-white/30">Marketing</p>
        <h1 className="text-2xl font-black text-white/90 mt-1">Storefront Designer</h1>
        <p className="text-sm text-white/40 mt-1 max-w-2xl">
          Tweak the customer-facing storefront — hero copy, announcement banners, page layout. The visual layout editor (drag-drop blocks) opens per brand below.
        </p>
      </header>

      <div className="px-7 py-7 max-w-5xl space-y-7">
        {/* Quick links */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <Link href="/marketing/brands"
            className="rounded-2xl p-5 hover:-translate-y-0.5 transition-all"
            style={{ background: 'rgba(0,212,177,0.05)', border: '1px solid rgba(0,212,177,0.2)' }}>
            <p className="text-2xl mb-2">🏷</p>
            <p className="font-bold text-white/85">Brand Editor</p>
            <p className="text-xs text-white/45 mt-0.5">Logo, primary colour, tagline, banner, taxes.</p>
            <p className="text-[11px] text-kds-green font-bold mt-2">Open editor →</p>
          </Link>
          <Link href="/storefront"
            className="rounded-2xl p-5 hover:-translate-y-0.5 transition-all"
            style={{ background: 'rgba(99,102,241,0.05)', border: '1px solid rgba(99,102,241,0.2)' }}>
            <p className="text-2xl mb-2">🎨</p>
            <p className="font-bold text-white/85">Visual Layout</p>
            <p className="text-xs text-white/45 mt-0.5">Drag-drop blocks: hero, gallery, menu strip, footer.</p>
            <p className="text-[11px] text-[#6366F1] font-bold mt-2">Open canvas →</p>
          </Link>
          <Link href="/media"
            className="rounded-2xl p-5 hover:-translate-y-0.5 transition-all"
            style={{ background: 'rgba(245,158,11,0.05)', border: '1px solid rgba(245,158,11,0.2)' }}>
            <p className="text-2xl mb-2">🖼</p>
            <p className="font-bold text-white/85">Media Library</p>
            <p className="text-xs text-white/45 mt-0.5">Upload + browse images for menus, hero, gallery.</p>
            <p className="text-[11px] text-amber-400 font-bold mt-2">Open library →</p>
          </Link>
        </div>

        {/* Brand cards with quick edit + preview */}
        <section>
          <div className="flex items-baseline justify-between mb-4">
            <h2 className="text-sm font-black uppercase tracking-[0.24em] text-white/60">Brands</h2>
            <p className="text-xs text-white/35">{concepts.length} configured</p>
          </div>

          {isLoading && <p className="text-sm text-white/40">Loading…</p>}

          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {concepts.map((c) => (
              <div key={c.id}
                className="rounded-2xl overflow-hidden"
                style={{ background: 'rgba(255,255,255,0.025)', border: '1px solid rgba(255,255,255,0.06)' }}>
                {/* Hero strip preview */}
                <div className="h-24 relative flex items-center px-5"
                  style={{
                    background: c.primaryColor
                      ? `linear-gradient(135deg, ${c.primaryColor}aa 0%, ${c.primaryColor}55 100%)`
                      : 'linear-gradient(135deg, #2a3344, #1a1f2c)',
                  }}>
                  {c.logoUrl && (
                    <img src={c.logoUrl} alt={c.name} className="h-12 w-12 rounded-lg object-cover mr-3 shrink-0" />
                  )}
                  <div className="min-w-0">
                    <p className="text-base font-black text-white truncate">{c.name}</p>
                    {c.heroTagline && <p className="text-xs text-white/85 truncate">{c.heroTagline}</p>}
                  </div>
                  {!c.storefrontVisible && (
                    <span className="absolute top-2 right-2 text-[9px] font-bold text-amber-300 bg-black/40 px-1.5 py-0.5 rounded">
                      HIDDEN
                    </span>
                  )}
                </div>

                {c.announcementBanner && (
                  <div className="px-5 py-2 text-[11px] text-amber-400"
                    style={{ background: 'rgba(245,158,11,0.08)', borderBottom: '1px solid rgba(245,158,11,0.15)' }}>
                    📣 {c.announcementBanner}
                  </div>
                )}

                <div className="p-4 flex items-center justify-between gap-2">
                  <div className="text-[11px] text-white/40 font-mono truncate">{c.slug}</div>
                  <div className="flex items-center gap-2">
                    <Link href={`/marketing/brands?id=${c.id}`}
                      className="text-xs font-bold text-kds-green hover:underline">
                      Edit brand →
                    </Link>
                    <a href={`${STOREFRONT_HOST}/brand/${c.slug}`} target="_blank" rel="noopener noreferrer"
                      className="text-xs text-white/55 hover:text-white">
                      Preview ↗
                    </a>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </section>

        {/* What lives where, explainer */}
        <div className="rounded-2xl p-5"
          style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.05)' }}>
          <p className="text-[10px] font-black uppercase tracking-[0.24em] text-white/45 mb-2">What lives where</p>
          <ul className="text-xs text-white/65 space-y-2 leading-relaxed">
            <li><strong className="text-white/85">Brand Editor</strong> — text fields: name, logo, primary colour, hero tagline, banner, hours, geography, FBR / tax invoice details.</li>
            <li><strong className="text-white/85">Visual Layout</strong> — block-by-block page builder for the brand microsite (hero block, gallery, menu strip, footer, custom HTML).</li>
            <li><strong className="text-white/85">Media Library</strong> — central R2 bucket. Upload once, reference from any block or menu item.</li>
            <li><strong className="text-white/85">Menu Editor</strong> (under Product) — items, prices, photos, descriptions, allergens. Storefront menu is a live read of this.</li>
          </ul>
        </div>
      </div>
    </div>
  )
}
