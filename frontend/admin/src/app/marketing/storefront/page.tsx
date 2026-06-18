'use client'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { api } from '../../../lib/api'
import { useEnsureTenant } from '../../../hooks/useEnsureTenant'

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
  const [showAdd, setShowAdd] = useState(false)
  const ensureTenant = useEnsureTenant()
  // Wraps the "+ Add brand" click: in portfolio view, the global modal
  // prompts which company the new brand should belong to. After picking,
  // the AddBrand modal opens against that tenant. In single-tenant mode,
  // ensureTenant runs the callback synchronously.
  const openAdd = () => ensureTenant(() => setShowAdd(true), 'add a brand')

  return (
    <div className="min-h-screen" style={{ background: '#090a0e' }}>
      <header className="px-7 py-6 border-b border-white/[0.05]">
        <p className="text-[10px] font-black uppercase tracking-[0.3em] text-white/30">Marketing</p>
        <h1 className="text-2xl font-black text-white/90 mt-1">Storefront Designer</h1>
        <p className="text-sm text-white/40 mt-1 max-w-2xl">
          Tweak the customer-facing storefront — hero copy, announcement banners, page layout. The visual layout editor (drag-drop blocks) opens per brand below.
        </p>
      </header>

      <div className="px-7 py-7 max-w-5xl mx-auto space-y-7">
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
            <div className="flex items-center gap-3">
              <p className="text-xs text-white/35">{concepts.length} configured</p>
              <button
                onClick={openAdd}
                className="rounded-lg px-3 py-1.5 text-xs font-bold bg-kds-green text-black hover:opacity-90">
                + Add brand
              </button>
            </div>
          </div>

          {isLoading && <p className="text-sm text-white/40">Loading…</p>}

          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {/* "Add brand" tile — shown alongside existing brands so the
                empty-state and "I want one more" cases both have the same
                visual entry point. */}
            <button
              onClick={openAdd}
              className="rounded-2xl border border-dashed border-white/15 hover:border-kds-green/60 p-6 text-left transition-all min-h-[140px] flex flex-col justify-center items-center gap-2 hover:bg-white/[0.02]">
              <div className="text-3xl">＋</div>
              <p className="text-sm font-bold text-white/70">Add a brand</p>
              <p className="text-[11px] text-white/35 text-center max-w-[16rem]">
                New concept — name, slug, primary colour, type. You&rsquo;ll fill in the rest in the editor.
              </p>
            </button>
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

        {/* Add-brand modal — mounted at page level so it can close from anywhere */}
        {showAdd && (
          <AddBrandModal
            onClose={() => setShowAdd(false)}
            existingSlugs={concepts.map((c) => c.slug)} />
        )}

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

// ─── Add brand modal ────────────────────────────────────────────────────────
// Minimum-friction concept creation. Required: name, slug, type. Everything
// else (FBR details, geography, hero copy, layout) gets filled in on the
// brand editor page after creation.
//
// The slug auto-suggests from the name (lowercase, hyphenated). Operator
// can override; collisions are caught both client-side (existingSlugs) and
// server-side (Concept.slug @unique).
//
// Permissions: POST /concepts requires ADMIN_ONLY. Manager-role users will
// get a 403 — surfaced as an error at the bottom of the modal.

const TYPE_OPTIONS: Array<{ value: 'restaurant' | 'digital' | 'cart'; label: string; desc: string }> = [
  { value: 'restaurant', label: '🍽 Restaurant',     desc: 'Dine-in, reservations, table service.' },
  { value: 'digital',    label: '🛵 Delivery / digital', desc: 'Ghost kitchen, delivery-first.' },
  { value: 'cart',       label: '🚚 Cart / pop-up', desc: 'Walk-up, events, container kitchens.' },
]

const SUGGESTED_COLORS = [
  '#22c55e', '#0ea5e9', '#f59e0b', '#ef4444',
  '#8b5cf6', '#ec4899', '#14b8a6', '#a855f7',
]

function slugify(s: string): string {
  return s
    .toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32)
}

function AddBrandModal({ onClose, existingSlugs }: { onClose: () => void; existingSlugs: string[] }) {
  const qc = useQueryClient()
  const router = useRouter()

  const [name, setName] = useState('')
  const [slug, setSlug] = useState('')
  const [slugTouched, setSlugTouched] = useState(false)
  const [type, setType] = useState<'restaurant' | 'digital' | 'cart'>('restaurant')
  const [primaryColor, setPrimaryColor] = useState('#22c55e')
  const [description, setDescription] = useState('')
  const [error, setError] = useState('')

  // Auto-derive slug from name until the user manually edits the slug field.
  const effectiveSlug = slugTouched ? slug : slugify(name)
  const slugConflict = effectiveSlug && existingSlugs.includes(effectiveSlug)
  const slugInvalid = effectiveSlug.length > 0 && !/^[a-z0-9][a-z0-9-]{0,30}[a-z0-9]?$/.test(effectiveSlug)
  const canSubmit = name.trim().length >= 2 && effectiveSlug.length >= 2 && !slugConflict && !slugInvalid

  const create = useMutation({
    mutationFn: () => api.post<{ id: string; slug: string }>('/concepts', {
      name: name.trim(),
      slug: effectiveSlug,
      type,
      primaryColor,
      description: description.trim() || undefined,
    }),
    onSuccess: (concept) => {
      qc.invalidateQueries({ queryKey: ['concepts'] })
      onClose()
      // Land directly on the brand editor for the new concept.
      router.push(`/marketing/brands?id=${concept.id}`)
    },
    onError: (err) => setError((err as Error).message ?? 'Could not create brand.'),
  })

  return (
    <div role="dialog" aria-modal="true"
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: 'rgba(0,0,0,0.6)' }}
      onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()}
        className="w-full max-w-lg rounded-2xl"
        style={{ background: '#0e1014', border: '1px solid rgba(255,255,255,0.08)' }}>
        <div className="px-6 pt-6 pb-4 border-b border-white/[0.06]">
          <p className="text-[10px] font-black uppercase tracking-[0.24em] text-white/35">Marketing</p>
          <h2 className="text-xl font-black text-white/95 mt-1">Add a brand</h2>
          <p className="text-xs text-white/45 mt-1">
            One brand = one concept = one storefront microsite. You can flesh out the details (logo, FBR, hours, layout) right after.
          </p>
        </div>

        <div className="px-6 py-5 space-y-5">
          <Field label="Brand name" hint="What customers see — e.g. &ldquo;Stax&rdquo;, &ldquo;Bukhari&rdquo;.">
            <input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={60}
              placeholder="Stax"
              className={inputCls} />
          </Field>

          <Field
            label="URL slug"
            hint={`Used for the microsite path. Lowercase letters, numbers, hyphens. Becomes /brand/${effectiveSlug || 'your-slug'} on the storefront.`}>
            <input
              value={effectiveSlug}
              onChange={(e) => { setSlug(slugify(e.target.value)); setSlugTouched(true) }}
              maxLength={32}
              placeholder="auto-from-name"
              className={inputCls + (slugConflict || slugInvalid ? ' border-rose-500/60' : '')} />
            {slugConflict && <p className="text-[11px] text-rose-300 mt-1">That slug is already taken.</p>}
            {slugInvalid && !slugConflict && (
              <p className="text-[11px] text-rose-300 mt-1">Letters, numbers, hyphens only. Must start + end with alphanumeric.</p>
            )}
          </Field>

          <Field label="Type" hint="Drives which features appear (reservations, dispatch, etc.).">
            <div className="grid grid-cols-1 gap-2">
              {TYPE_OPTIONS.map((o) => (
                <button key={o.value} type="button"
                  onClick={() => setType(o.value)}
                  className="text-left rounded-xl px-4 py-3 transition-all"
                  style={type === o.value
                    ? { background: 'rgba(34,197,94,0.1)', border: '1px solid rgba(34,197,94,0.4)' }
                    : { background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.06)' }}>
                  <p className={`text-sm font-bold ${type === o.value ? 'text-kds-green' : 'text-white/85'}`}>{o.label}</p>
                  <p className="text-[11px] text-white/40 mt-0.5">{o.desc}</p>
                </button>
              ))}
            </div>
          </Field>

          <Field label="Primary colour" hint="Used across the brand microsite + admin chips.">
            <div className="flex items-center gap-3">
              <input
                type="color"
                value={primaryColor}
                onChange={(e) => setPrimaryColor(e.target.value)}
                className="h-10 w-12 rounded-lg cursor-pointer bg-transparent"
                style={{ border: '1px solid rgba(255,255,255,0.1)' }} />
              <input
                value={primaryColor}
                onChange={(e) => setPrimaryColor(e.target.value)}
                maxLength={9}
                className={inputCls + ' flex-1 font-mono'} />
              <div className="flex gap-1">
                {SUGGESTED_COLORS.map((c) => (
                  <button key={c} type="button"
                    onClick={() => setPrimaryColor(c)}
                    aria-label={`Pick ${c}`}
                    className="h-7 w-7 rounded-full"
                    style={{ background: c, outline: c === primaryColor ? '2px solid #fff' : 'none', outlineOffset: 1 }} />
                ))}
              </div>
            </div>
          </Field>

          <Field label="One-line description" hint="Optional. Shows under the brand on customer-facing pages.">
            <input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              maxLength={200}
              placeholder="e.g. Smashed double burgers, loaded fries."
              className={inputCls} />
          </Field>

          {error && (
            <p className="rounded-lg px-3 py-2 text-xs text-rose-300"
              style={{ background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.25)' }}>
              {error}
            </p>
          )}
        </div>

        <div className="px-6 py-4 flex justify-end gap-2 border-t border-white/[0.06]">
          <button onClick={onClose}
            className="rounded-lg px-4 py-2 text-xs font-bold text-white/55 hover:text-white">
            Cancel
          </button>
          <button
            onClick={() => create.mutate()}
            disabled={!canSubmit || create.isPending}
            className="rounded-lg px-5 py-2.5 text-xs font-black bg-kds-green text-black hover:opacity-90 disabled:opacity-40">
            {create.isPending ? 'Creating…' : 'Create brand →'}
          </button>
        </div>
      </div>
    </div>
  )
}

const inputCls =
  "w-full rounded-lg bg-white/[0.03] border border-white/[0.1] px-3 py-2.5 text-sm text-white/90 focus:border-kds-green focus:outline-none placeholder:text-white/25"

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="text-[11px] font-black uppercase tracking-wide text-white/55">{label}</label>
      {children}
      {hint && <p className="text-[10px] text-white/30 mt-1">{hint}</p>}
    </div>
  )
}
