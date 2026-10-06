'use client'

// Per-brand ordering page. Replaces the previous 1400-line monolith with a
// focused ordering UX:
//   • brand-keyed hero (image + name + tagline)
//   • sticky category nav (jumps within the page)
//   • menu grid with card-per-item
//   • floating cart drawer with checkout CTA
//   • item customisation modal for items with modifier groups
//
// Uses the public storefront API: /storefront/concepts and /storefront/:slug/menu.

import { useEffect, useMemo, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import Link from 'next/link'
import { MagneticButton, MagneticLink } from '@/components/ui/MagneticButton'
import { useCart } from '../../store/cart'
import { conceptHeroImage, heroCover, formatBrandName } from '../../lib/concept'
import { useBrandSlug, getServdHost } from '../../lib/host'
import { encodeCartToken } from '../../lib/cartHandoff'

const API_URL = process.env['NEXT_PUBLIC_API_URL'] ?? 'http://localhost:3001'

interface Modifier   { id: string; name: string; priceDeltaCents: number; isDefault?: boolean }
interface ModGroup   { id: string; name: string; minSelect: number; maxSelect: number; isRequired: boolean; modifiers: Modifier[] }
interface MenuItem   {
  id: string; name: string; description: string | null; priceCents: number
  imageUrl: string | null
  videoUrl?: string | null
  isAvailable: boolean
  allergens?: string[]
  dietary?: string[]
  spiceLevel?: number | null
  modifierGroups?: ModGroup[]
}

// SVG icons used by dietary + spice badges below. Emoji glyphs were a
// platform-fingerprint risk (font fallback differs per OS, kerning varies
// per platform → CLS) and violate the storefront's no-emoji-as-structural-
// icon rule.
function LeafIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M11 20A7 7 0 0 1 9.8 6.1C15.5 5 17 4.48 19.2 2.96c.97 6.43.95 10.39-2.95 12.36C12.6 17.5 8 17 8 13"/>
    </svg>
  )
}
function FlameIcon() {
  return (
    <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z"/>
    </svg>
  )
}

const DIETARY_BADGE: Record<string, { label: string; color: string; withIcon: boolean }> = {
  vegetarian:  { label: 'Veg',   color: 'rgba(135,197,64,0.15)',  withIcon: true  },
  vegan:       { label: 'Vegan', color: 'rgba(135,197,64,0.15)',  withIcon: true  },
  halal:       { label: 'Halal', color: 'rgba(135,197,64,0.15)',  withIcon: false },
  gluten_free: { label: 'GF',    color: 'rgba(245,158,11,0.15)', withIcon: false },
}
interface Category   { id: string; name: string; sortOrder: number; items: MenuItem[] }
interface Concept    {
  id: string; name: string; slug: string; type: string
  description: string | null; logoUrl: string | null; primaryColor: string | null; taxRate: number
  phone?: string | null; address?: string | null
  latitude?: number | null; longitude?: number | null
}

// Currency rendering — brand-aware per the marketing bundle.
// Simmer's brand bible specifies `1200`, no prefix, tax-exclusive
// (premium positioning; the PKR prefix reads transactional). Casual
// brands (Stackd, Flipd) keep the press-format `PKR 1,200`.
function fmtFor(slug: string | null | undefined) {
  return (cents: number): string => {
    const n = (cents / 100).toLocaleString('en-PK', { maximumFractionDigits: 0 })
    return slug === 'simmer' ? n : `PKR ${n}`
  }
}

// Slug → display name: "garnish-station" → "Garnish Station".
// Used as a placeholder when the /concepts lookup hiccups but we still want
// to render a usable page from just the URL slug.
function prettifySlug(slug: string): string {
  return slug
    .split('-')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ')
}

export default function ConceptOrderPage() {
  const { concept: slug } = useParams<{ concept: string }>()
  const router = useRouter()

  const [concept, setConcept] = useState<Concept | null>(null)
  const [categories, setCategories] = useState<Category[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [activeCategory, setActiveCategory] = useState<string | null>(null)
  const [openItem, setOpenItem] = useState<MenuItem | null>(null)
  const [cartOpen, setCartOpen] = useState(false)

  const cart = useCart()
  const brandSlug = useBrandSlug()

  // Fetch concept + menu. Resilient against either API hiccupping: if the
  // /concepts fetch fails (Neon cold-start, transient 5xx, rate limit) we
  // derive a minimal placeholder concept from the slug so the menu still
  // renders. Only show the error page when the *menu* itself is unavailable
  // — that's the one we can't fake.
  useEffect(() => {
    let cancelled = false
    async function load() {
      try {
        const [conceptsRes, menuRes] = await Promise.all([
          fetch(`${API_URL}/api/v1/storefront/concepts`).catch(() => null),
          fetch(`${API_URL}/api/v1/storefront/${slug}/menu`),
        ])

        if (!menuRes.ok) {
          throw new Error(menuRes.status === 404 ? 'Brand not found' : `Menu API returned ${menuRes.status}`)
        }
        // Backend returns { concept, categories } — pull the array out.
        const menuPayload = await menuRes.json() as { concept?: Concept; categories: Category[] } | Category[]
        const cats: Category[] = Array.isArray(menuPayload) ? menuPayload : (menuPayload.categories ?? [])

        // Try to enrich with real concept data; otherwise build a placeholder
        // from the slug so the page still renders with brand colour/name.
        let resolved: Concept
        if (conceptsRes && conceptsRes.ok) {
          const all: Concept[] = await conceptsRes.json()
          const found = all.find((x) => x.slug === slug)
          if (found) {
            resolved = found
          } else {
            resolved = {
              id: slug, slug, name: prettifySlug(slug), type: 'restaurant',
              description: null, logoUrl: null, primaryColor: null, taxRate: 0,
            }
          }
        } else {
          resolved = {
            id: slug, slug, name: prettifySlug(slug), type: 'restaurant',
            description: null, logoUrl: null, primaryColor: null, taxRate: 0,
          }
        }

        if (cancelled) return
        setConcept(resolved)
        setCategories(cats)
        setActiveCategory(cats[0]?.id ?? null)
        if (cart.conceptSlug && cart.conceptSlug !== slug) cart.clearCart()
        cart.setConceptSlug(slug)
      } catch (e) {
        if (!cancelled) setError((e as Error).message)
      }
    }
    void load()
    return () => { cancelled = true }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug])

  // Track active category as the user scrolls
  useEffect(() => {
    if (!categories) return
    const handler = () => {
      const offset = 180  // sticky header height
      let current: string | null = null
      for (const c of categories) {
        const el = document.getElementById(`cat-${c.id}`)
        if (el && el.getBoundingClientRect().top < offset) current = c.id
      }
      if (current) setActiveCategory(current)
    }
    window.addEventListener('scroll', handler, { passive: true })
    return () => window.removeEventListener('scroll', handler)
  }, [categories])

  if (error) {
    return (
      <div className="min-h-dvh flex items-center justify-center p-6 text-center">
        <div style={{ maxWidth: '28rem' }}>
          <h1 className="text-2xl font-bold mb-2">Tableside ordering isn&rsquo;t live yet.</h1>
          <p className="text-s-muted text-sm mb-4">
            The kitchen hasn&rsquo;t published a menu to the order system. Flag down your server — they&rsquo;ll take the order from the printed card. Reservations are open below.
          </p>
          <div style={{ display: 'flex', gap: '0.75rem', justifyContent: 'center', flexWrap: 'wrap' }}>
            <MagneticLink href={`/brand/${slug}/menu`} className="servd-btn-primary">See the menu</MagneticLink>
            <MagneticLink href={`/reserve/${slug}`} className="servd-btn-primary" style={{ background: 'var(--servd-mute)', color: 'white' }}>Reserve a table</MagneticLink>
          </div>
        </div>
      </div>
    )
  }

  if (!concept || !categories) {
    // Menu skeleton — same hero stripe + category nav strip + 4 item rows
    // as the real page, just shimmer-tinted. Reserves the layout so the
    // real menu doesn't push content around on hydrate (avoids CLS).
    return (
      <div role="status" aria-label="Loading menu" style={{ background: '#fff', minHeight: '100dvh' }}>
        <div style={{ height: '260px', background: 'linear-gradient(90deg, var(--servd-surface), #f0f0f0, var(--servd-surface))', backgroundSize: '200% 100%', animation: 'skeletonShimmer 1.4s ease-in-out infinite' }} />
        <div style={{ padding: '1rem 1rem 0', display: 'flex', gap: '0.5rem', overflowX: 'hidden' }}>
          {Array.from({ length: 4 }).map((_, i) => (
            <span key={i} style={{ width: '4.5rem', height: '2rem', borderRadius: '999px', background: 'var(--servd-surface)', flex: 'none' }} />
          ))}
        </div>
        <div style={{ padding: '1.25rem', display: 'grid', gap: '0.85rem' }}>
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} style={{
              display: 'grid', gridTemplateColumns: '1fr 5rem', gap: '0.75rem',
              padding: '0.85rem', borderRadius: '1rem',
              background: 'var(--servd-surface)', border: '1px solid var(--servd-line)',
            }}>
              <div>
                <div style={{ height: '0.95rem', width: '60%', background: '#eaeaea', borderRadius: '4px', marginBottom: '0.4rem' }} />
                <div style={{ height: '0.75rem', width: '90%', background: '#f1f1f1', borderRadius: '4px' }} />
              </div>
              <div style={{ height: '4rem', borderRadius: '0.6rem', background: '#eaeaea' }} />
            </div>
          ))}
        </div>
        <span className="sr-only">Loading menu…</span>
      </div>
    )
  }

  const accent = concept.primaryColor ?? 'var(--servd-green-dark)'
  const itemTotal = cart.itemCount()
  const hasItems = itemTotal > 0
  const fmt = fmtFor(slug)

  // Per-brand skin — same class system as /[concept]/checkout. Wraps the
  // ordering surface in the brand's design language (token remap + a few
  // targeted overrides in globals.css) so the menu / item modal / cart
  // drawer feel like the brand the customer just walked into, not the
  // generic servd treatment.
  const brandSkinClass =
    slug === 'simmer' ? 'simmer-ordering' :
    slug === 'stackd'   ? 'stackd-ordering'   :
    slug === 'flipd'  ? 'flipd-ordering'  :
    ''

  return (
    <div className={brandSkinClass}
      style={{ background: '#fff', minHeight: '100dvh', paddingBottom: hasItems ? '7rem' : '0' }}>
      {/* Hero */}
      <section
        style={{
          position: 'relative',
          minHeight: '320px',
          display: 'flex',
          alignItems: 'flex-end',
          background: `${accent}${heroCover(conceptHeroImage(concept))}`,
          color: '#fff',
        }}
      >
        <div aria-hidden="true" style={{ position: 'absolute', inset: 0, background: 'linear-gradient(180deg, rgba(0,0,0,0.15) 0%, rgba(0,0,0,0.65) 100%)' }} />
        <div className="container" style={{ position: 'relative', zIndex: 1, paddingTop: '5rem', paddingBottom: '2rem' }}>
          <div className="flex items-center justify-between mb-4 flex-wrap gap-2">
            <Link href={`/brand/${concept.slug}`} style={{ color: 'rgba(255,255,255,0.85)', textDecoration: 'none', fontSize: '0.85rem' }}>
              ← {formatBrandName(concept.name)}
            </Link>
            <Link href="/browse" style={{ color: 'rgba(255,255,255,0.85)', textDecoration: 'none', fontSize: '0.85rem' }}>
              Other brands →
            </Link>
          </div>
          <h1 style={{ fontSize: 'clamp(2rem, 5vw, 3.25rem)', fontWeight: 900, letterSpacing: '-0.04em', marginBottom: '0.5rem' }}>
            {formatBrandName(concept.name)}
          </h1>
          {concept.description && (
            <p style={{ color: 'rgba(255,255,255,0.85)', maxWidth: '36rem', fontSize: '1rem' }}>
              {concept.description}
            </p>
          )}
        </div>
      </section>

      {/* Sticky category nav */}
      {categories.length > 0 && (
        <nav
          aria-label="Menu sections"
          className="no-scrollbar"
          style={{
            position: 'sticky',
            top: '60px',
            zIndex: 30,
            background: 'rgba(255,255,255,0.95)',
            backdropFilter: 'blur(14px)',
            WebkitBackdropFilter: 'blur(14px)',
            borderBottom: '1px solid var(--servd-line)',
            display: 'flex',
            gap: '0.25rem',
            overflowX: 'auto',
            padding: '0.5rem clamp(1rem, 4vw, 2rem)',
          }}
        >
          {categories.map((c) => {
            const active = activeCategory === c.id
            return (
              <a
                key={c.id}
                href={`#cat-${c.id}`}
                onClick={(e) => {
                  e.preventDefault()
                  document.getElementById(`cat-${c.id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
                  setActiveCategory(c.id)
                }}
                style={{
                  whiteSpace: 'nowrap',
                  padding: '0.45rem 0.95rem',
                  fontWeight: active ? 800 : 500,
                  fontSize: '0.875rem',
                  color: active ? '#0a0a0a' : 'var(--servd-mute)',
                  textDecoration: 'none',
                  borderRadius: '999px',
                  background: active ? 'var(--servd-green-soft)' : 'transparent',
                }}
              >
                {c.name}
              </a>
            )
          })}
        </nav>
      )}

      {/* Menu */}
      <div className="container" style={{ padding: 'clamp(2rem, 4vw, 3rem) 0', display: 'grid', gap: '2.5rem' }}>
        {categories.length === 0 && (
          <div className="text-center py-12">
            <h3 className="text-lg font-semibold mb-2">No menu yet</h3>
            <p className="text-s-muted">{formatBrandName(concept.name)} hasn&rsquo;t published a menu. Check back soon.</p>
          </div>
        )}

        {categories.map((cat) => (
          <section key={cat.id} id={`cat-${cat.id}`} style={{ scrollMarginTop: '120px' }}>
            <h2 style={{ fontSize: 'clamp(1.4rem, 3vw, 1.85rem)', marginBottom: '1.25rem' }}>{cat.name}</h2>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 260px), 1fr))', gap: '1rem' }}>
              {cat.items.map((item) => <ItemCard key={item.id} item={item} onClick={() => setOpenItem(item)} accent={accent} fmt={fmt} />)}
            </div>
          </section>
        ))}
      </div>

      {/* Item modal */}
      {openItem && (
        <ItemDetailModal
          item={openItem}
          conceptSlug={concept.slug}
          accent={accent}
          fmt={fmt}
          onClose={() => setOpenItem(null)}
          onAdd={(item, qty, modifiers, finalPriceCents, notes) => {
            for (let i = 0; i < qty; i++) {
              cart.addItem({
                menuItemId: item.id,
                name: item.name,
                priceCents: finalPriceCents,
                ...(modifiers.length > 0 && { modifiers }),
                ...(notes && { notes }),
              })
            }
            setOpenItem(null)
            setCartOpen(true)
          }}
        />
      )}

      {/* Cart drawer */}
      {hasItems && (
        <CartDrawer
          open={cartOpen}
          onOpen={() => setCartOpen(true)}
          onClose={() => setCartOpen(false)}
          accent={accent}
          fmt={fmt}
          onCheckout={() => {
            // On a brand custom domain (eatstax.com, stackd.localhost:3002…),
            // hand the cart off to the canonical servd checkout via a URL
            // token so the user can be cross-sold items from other GS Foods
            // brands. On the servd host itself, fall through to the local
            // checkout route.
            const onBrandHost = brandSlug !== null
            const servdHost   = getServdHost()
            if (onBrandHost && servdHost) {
              const token = encodeCartToken({
                cartId:      cart.cartId,
                conceptSlug: cart.conceptSlug,
                items:       cart.items,
              })
              window.location.href = `${servdHost}/${concept.slug}/checkout?cart=${encodeURIComponent(token)}`
              return
            }
            router.push(`/${concept.slug}/checkout`)
          }}
        />
      )}
    </div>
  )
}

// ───── Components ───────────────────────────────────────────────────────────

function ItemCard({ item, onClick, accent, fmt }: { item: MenuItem; onClick: () => void; accent: string; fmt: (cents: number) => string }) {
  const disabled = !item.isAvailable
  return (
    <button
      type="button"
      onClick={() => !disabled && onClick()}
      disabled={disabled}
      style={{
        textAlign: 'left',
        background: '#fff',
        border: '1px solid var(--servd-line)',
        borderRadius: '0.85rem',
        padding: 0,
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.55 : 1,
        overflow: 'hidden',
        transition: 'transform 180ms cubic-bezier(0.22,1,0.36,1), box-shadow 180ms',
      }}
      onMouseEnter={(e) => { if (!disabled) e.currentTarget.style.transform = 'translateY(-2px)'; if (!disabled) e.currentTarget.style.boxShadow = '0 8px 24px rgba(0,0,0,0.08)' }}
      onMouseLeave={(e) => { e.currentTarget.style.transform = 'translateY(0)'; e.currentTarget.style.boxShadow = 'none' }}
      aria-label={`${item.name} — ${fmt(item.priceCents)}${disabled ? ' — sold out' : ''}`}
    >
      <div style={{
        aspectRatio: '4/3',
        background: item.imageUrl ? `url(${item.imageUrl}) center/cover` : `linear-gradient(135deg, ${accent}22 0%, white 200%)`,
        position: 'relative',
        overflow: 'hidden',
      }}>
        {item.videoUrl && (
          <video
            src={item.videoUrl}
            {...(item.imageUrl ? { poster: item.imageUrl } : {})}
            autoPlay muted loop playsInline preload="metadata"
            aria-hidden="true"
            style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover' }}
          />
        )}
        {disabled && (
          <span style={{
            position: 'absolute', top: '0.6rem', left: '0.6rem',
            background: 'rgba(0,0,0,0.7)', color: 'white',
            fontSize: '0.7rem', fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase',
            padding: '0.2rem 0.55rem', borderRadius: '999px',
          }}>Sold out</span>
        )}
      </div>
      <div style={{ padding: '0.95rem 1rem', display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
        <h3 style={{ fontSize: '1rem', fontWeight: 700, lineHeight: 1.3 }}>{item.name}</h3>
        {item.description && (
          <p style={{ color: 'var(--servd-mute)', fontSize: '0.85rem', lineHeight: 1.4, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
            {item.description}
          </p>
        )}
        {((item.dietary?.length ?? 0) > 0 || ((item.spiceLevel ?? 0) > 0)) && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.3rem', marginTop: '0.2rem' }}>
            {(item.dietary ?? []).map((d) => {
              const b = DIETARY_BADGE[d]
              return (
                <span key={d} style={{
                  display: 'inline-flex', alignItems: 'center', gap: '0.25rem',
                  fontSize: '0.65rem', fontWeight: 700, letterSpacing: '0.05em',
                  padding: '0.15rem 0.45rem', borderRadius: '999px',
                  background: b?.color ?? 'rgba(0,0,0,0.06)', color: 'var(--servd-ink)',
                }}>
                  {b?.withIcon && <LeafIcon />}
                  {b?.label ?? d}
                </span>
              )
            })}
            {(item.spiceLevel ?? 0) > 0 && (
              <span aria-label={`Spice level ${Math.min(item.spiceLevel ?? 0, 3)} of 3`}
                style={{
                  display: 'inline-flex', alignItems: 'center', gap: '0.1rem',
                  fontSize: '0.65rem', fontWeight: 700, padding: '0.15rem 0.45rem',
                  borderRadius: '999px', background: 'rgba(220,38,38,0.12)', color: '#991b1b',
                }}>
                {Array.from({ length: Math.min(item.spiceLevel ?? 0, 3) }).map((_, i) => (
                  <FlameIcon key={i} />
                ))}
              </span>
            )}
          </div>
        )}
        {(item.allergens?.length ?? 0) > 0 && (
          <p style={{ fontSize: '0.7rem', color: 'var(--servd-mute)', marginTop: '0.1rem' }}>
            Contains: {(item.allergens ?? []).join(', ')}
          </p>
        )}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: '0.4rem' }}>
          <span style={{ fontWeight: 800, color: 'var(--servd-green-dark)' }}>{fmt(item.priceCents)}</span>
          {!disabled && <span style={{ fontSize: '1.25rem', color: 'var(--servd-green-dark)', fontWeight: 700 }}>+</span>}
        </div>
      </div>
    </button>
  )
}

function ItemDetailModal({
  item, accent, onClose, onAdd, fmt,
}: {
  item: MenuItem
  conceptSlug: string
  accent: string
  fmt: (cents: number) => string
  onClose: () => void
  onAdd: (
    item: MenuItem,
    qty: number,
    modifiers: { modifierId: string; name: string; priceDeltaCents: number }[],
    finalPriceCents: number,
    notes: string,
  ) => void
}) {
  const [qty, setQty] = useState(1)
  const [notes, setNotes] = useState('')

  // selections[groupId] = Set of selected modifier ids. Seeded with the
  // group's isDefault picks so a "must pick exactly one" group lands on
  // the default the operator marked.
  const [selections, setSelections] = useState<Record<string, Set<string>>>(() => {
    const seed: Record<string, Set<string>> = {}
    for (const g of item.modifierGroups ?? []) {
      const defaults = g.modifiers.filter((m) => m.isDefault).map((m) => m.id)
      seed[g.id] = new Set(defaults.slice(0, Math.max(1, g.maxSelect)))
    }
    return seed
  })

  function togglePick(group: ModGroup, modifierId: string) {
    setSelections((prev) => {
      const current = new Set(prev[group.id] ?? [])
      if (group.maxSelect <= 1) {
        // Radio behavior — replace selection.
        current.clear()
        current.add(modifierId)
      } else if (current.has(modifierId)) {
        current.delete(modifierId)
      } else if (current.size < group.maxSelect) {
        current.add(modifierId)
      }
      return { ...prev, [group.id]: current }
    })
  }

  // Validate: each required group must have at least minSelect picks.
  const groups = item.modifierGroups ?? []
  const unmet = groups.filter((g) => {
    const count = selections[g.id]?.size ?? 0
    if (g.isRequired && count < Math.max(1, g.minSelect)) return true
    if (g.minSelect > 0 && count > 0 && count < g.minSelect) return true
    return false
  })
  const canAdd = unmet.length === 0

  // Flatten picks for price calculation + the add payload.
  const pickedModifiers = groups.flatMap((g) =>
    g.modifiers
      .filter((m) => selections[g.id]?.has(m.id))
      .map((m) => ({ modifierId: m.id, name: m.name, priceDeltaCents: m.priceDeltaCents })),
  )
  const lineUnitPriceCents = item.priceCents + pickedModifiers.reduce((s, m) => s + m.priceDeltaCents, 0)

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={item.name}
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, zIndex: 60,
        background: 'rgba(0,0,0,0.45)',
        display: 'flex', alignItems: 'flex-end', justifyContent: 'center',
        padding: '0',
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: '#fff', width: '100%', maxWidth: '34rem',
          borderRadius: '1.25rem 1.25rem 0 0',
          maxHeight: '92dvh', overflow: 'hidden',
          display: 'flex', flexDirection: 'column',
          animation: 'fadeUp 200ms cubic-bezier(0.22,1,0.36,1) both',
        }}
      >
        <div style={{
          aspectRatio: '16/10',
          background: item.imageUrl ? `url(${item.imageUrl}) center/cover` : `linear-gradient(135deg, ${accent}22 0%, white 200%)`,
          position: 'relative',
          overflow: 'hidden',
        }}>
          {item.videoUrl && (
            <video
              src={item.videoUrl}
              {...(item.imageUrl ? { poster: item.imageUrl } : {})}
              autoPlay muted loop playsInline preload="metadata"
              aria-hidden="true"
              style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover' }}
            />
          )}
          <button onClick={onClose} aria-label="Close" style={{
            position: 'absolute', top: '0.75rem', right: '0.75rem',
            background: 'rgba(255,255,255,0.95)', border: 'none', borderRadius: '999px',
            width: '2rem', height: '2rem', fontSize: '1.1rem', cursor: 'pointer',
          }}>×</button>
        </div>

        <div style={{ overflowY: 'auto', padding: '1.5rem', display: 'flex', flexDirection: 'column', gap: '1rem' }}>
          <h2 style={{ fontSize: '1.4rem', fontWeight: 800 }}>{item.name}</h2>
          {item.description && (
            <p style={{ color: 'var(--servd-mute)', fontSize: '0.95rem', lineHeight: 1.5 }}>{item.description}</p>
          )}
          <p style={{ fontWeight: 800, color: 'var(--servd-green-dark)', fontSize: '1.1rem' }}>{fmt(item.priceCents)}</p>

          {/* Modifier groups — radios for maxSelect ≤ 1, checkboxes otherwise.
              Required groups get a "Required" pill; min/max constraints
              surface as caption text so the customer knows the rules. */}
          {groups.map((g) => {
            const picked = selections[g.id] ?? new Set<string>()
            const radio = g.maxSelect <= 1
            const caption =
              g.isRequired
                ? `Required · pick ${g.minSelect === g.maxSelect ? g.minSelect : `${g.minSelect}–${g.maxSelect}`}`
                : g.maxSelect > 1
                  ? `Pick up to ${g.maxSelect}`
                  : 'Optional'
            return (
              <fieldset key={g.id} style={{ border: '1px solid var(--servd-line)', borderRadius: '0.75rem', padding: '0.85rem 1rem 0.6rem', margin: 0 }}>
                <legend style={{ padding: '0 0.4rem', display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
                  <span style={{ fontSize: '0.92rem', fontWeight: 700, color: 'var(--servd-ink)' }}>{g.name}</span>
                  {g.isRequired && (
                    <span style={{
                      background: 'var(--servd-green)', color: 'var(--servd-on-green)',
                      fontSize: '0.62rem', fontWeight: 800, letterSpacing: '0.08em',
                      textTransform: 'uppercase', padding: '0.15rem 0.45rem', borderRadius: '999px',
                    }}>Required</span>
                  )}
                </legend>
                <p style={{ fontSize: '0.75rem', color: 'var(--servd-mute)', marginBottom: '0.5rem' }}>{caption}</p>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem' }}>
                  {g.modifiers.map((m) => {
                    const checked = picked.has(m.id)
                    const reachedMax = !radio && !checked && picked.size >= g.maxSelect
                    return (
                      <label
                        key={m.id}
                        style={{
                          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                          padding: '0.55rem 0.75rem', borderRadius: '0.5rem',
                          background: checked ? 'rgba(135,197,64,0.08)' : 'transparent',
                          border: checked ? '1px solid var(--servd-green)' : '1px solid transparent',
                          cursor: reachedMax ? 'not-allowed' : 'pointer',
                          opacity: reachedMax ? 0.5 : 1,
                          gap: '0.75rem',
                        }}
                      >
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.6rem', fontSize: '0.92rem' }}>
                          <input
                            type={radio ? 'radio' : 'checkbox'}
                            name={radio ? g.id : undefined}
                            checked={checked}
                            disabled={reachedMax}
                            onChange={() => togglePick(g, m.id)}
                            style={{ accentColor: 'var(--servd-green)' }}
                          />
                          <span>{m.name}</span>
                        </span>
                        {m.priceDeltaCents !== 0 && (
                          <span style={{ fontSize: '0.85rem', fontWeight: 700, color: 'var(--servd-mute)' }}>
                            {m.priceDeltaCents > 0 ? '+' : ''}{fmt(m.priceDeltaCents)}
                          </span>
                        )}
                      </label>
                    )
                  })}
                </div>
              </fieldset>
            )
          })}

          <label style={{ display: 'block' }}>
            <span style={{ fontSize: '0.85rem', fontWeight: 600, color: 'var(--servd-mute)' }}>Notes for the kitchen (optional)</span>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={2}
              maxLength={200}
              placeholder="e.g. no onions, extra spicy"
              style={{
                marginTop: '0.4rem', width: '100%', padding: '0.65rem 0.85rem',
                border: '1px solid var(--servd-line)', borderRadius: '0.6rem', fontFamily: 'inherit', fontSize: '0.9rem',
              }}
            />
          </label>
        </div>

        <div style={{ padding: '1rem 1.5rem 1.25rem', borderTop: '1px solid var(--servd-line)', display: 'flex', gap: '0.75rem', alignItems: 'center' }}>
          <div style={{ display: 'inline-flex', alignItems: 'center', gap: '0.5rem', border: '1px solid var(--servd-line)', borderRadius: '999px', padding: '0.25rem 0.4rem' }}>
            <button onClick={() => setQty(Math.max(1, qty - 1))} aria-label="Decrease quantity"
              style={{ width: '2rem', height: '2rem', borderRadius: '999px', border: 'none', background: 'transparent', fontSize: '1.1rem', cursor: 'pointer' }}>−</button>
            <span style={{ minWidth: '1.5rem', textAlign: 'center', fontWeight: 700 }}>{qty}</span>
            <button onClick={() => setQty(Math.min(20, qty + 1))} aria-label="Increase quantity"
              style={{ width: '2rem', height: '2rem', borderRadius: '999px', border: 'none', background: 'transparent', fontSize: '1.1rem', cursor: 'pointer' }}>+</button>
          </div>
          <button
            onClick={() => canAdd && onAdd(item, qty, pickedModifiers, lineUnitPriceCents, notes.trim())}
            disabled={!canAdd}
            className="servd-btn-primary"
            style={{ flex: 1, padding: '0.85rem 1rem', opacity: canAdd ? 1 : 0.5, cursor: canAdd ? 'pointer' : 'not-allowed' }}
          >
            {canAdd
              ? `Add ${qty} · ${fmt(lineUnitPriceCents * qty)}`
              : `Pick ${unmet[0]?.name}`}
          </button>
        </div>
      </div>
    </div>
  )
}

function CartDrawer({
  open, onOpen, onClose, accent, onCheckout, fmt,
}: {
  open: boolean
  onOpen: () => void
  onClose: () => void
  accent: string
  onCheckout: () => void
  fmt: (cents: number) => string
}) {
  // Tax is computed at checkout (payment-method aware), not here.
  // The basket just shows subtotal.
  const cart = useCart()
  const subtotal = cart.subtotalCents()
  const itemCount = cart.itemCount()

  if (!open) {
    // Floating CTA pill anchored to bottom of screen
    return (
      <button
        onClick={onOpen}
        aria-label={`View cart — ${itemCount} item${itemCount === 1 ? '' : 's'}, ${fmt(subtotal)}`}
        style={{
          position: 'fixed', bottom: 'calc(1.25rem + env(safe-area-inset-bottom))', left: '50%', transform: 'translateX(-50%)', zIndex: 40,
          background: '#0a0a0a', color: 'white', border: 'none',
          borderRadius: '999px', padding: '0.85rem 1.5rem',
          display: 'flex', alignItems: 'center', gap: '0.85rem',
          boxShadow: '0 12px 40px rgba(0,0,0,0.25)', cursor: 'pointer',
          fontWeight: 700,
        }}
      >
        <span style={{
          background: accent, color: '#0a0a0a',
          minWidth: '1.6rem', height: '1.6rem', borderRadius: '999px',
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          fontWeight: 900, fontSize: '0.85rem',
        }}>
          {itemCount}
        </span>
        <span>View basket</span>
        <span style={{ opacity: 0.85 }}>{fmt(subtotal)}</span>
      </button>
    )
  }

  return (
    <div role="dialog" aria-modal="true" aria-label="Basket"
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, zIndex: 60,
        background: 'rgba(0,0,0,0.45)',
        display: 'flex', alignItems: 'flex-end', justifyContent: 'center',
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: '#fff', width: '100%', maxWidth: '34rem',
          borderRadius: '1.25rem 1.25rem 0 0',
          maxHeight: '92dvh', display: 'flex', flexDirection: 'column',
          animation: 'fadeUp 200ms cubic-bezier(0.22,1,0.36,1) both',
        }}
      >
        <header style={{ padding: '1.25rem 1.5rem', borderBottom: '1px solid var(--servd-line)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <h2 style={{ fontSize: '1.2rem', fontWeight: 800 }}>Your basket</h2>
          <button onClick={onClose} aria-label="Close basket"
            style={{ background: 'transparent', border: 'none', fontSize: '1.4rem', cursor: 'pointer', color: 'var(--servd-mute)' }}>×</button>
        </header>

        <div style={{ overflowY: 'auto', flex: 1 }}>
          {cart.items.length === 0 && (
            <p style={{ padding: '3rem 1.5rem', textAlign: 'center', color: 'var(--servd-mute)' }}>Basket&rsquo;s empty.</p>
          )}
          {cart.items.map((line) => (
            <div key={line.lineId} style={{ padding: '1rem 1.5rem', borderBottom: '1px solid var(--servd-line)', display: 'flex', gap: '1rem', alignItems: 'flex-start' }}>
              <div style={{ flex: 1 }}>
                <p style={{ fontWeight: 700, marginBottom: '0.25rem' }}>{line.name}</p>
                {line.modifiers && line.modifiers.length > 0 && (
                  <p style={{ color: 'var(--servd-mute)', fontSize: '0.78rem', lineHeight: 1.4, marginBottom: '0.2rem' }}>
                    {line.modifiers.map((m) => m.name).join(' · ')}
                  </p>
                )}
                <p style={{ color: 'var(--servd-mute)', fontSize: '0.85rem' }}>{fmt(line.priceCents)} · qty {line.quantity}</p>
                <div style={{ display: 'inline-flex', alignItems: 'center', gap: '0.5rem', marginTop: '0.5rem', border: '1px solid var(--servd-line)', borderRadius: '999px', padding: '0.15rem 0.3rem' }}>
                  <button onClick={() => cart.updateQty(line.lineId, line.quantity - 1)} aria-label="Decrease"
                    style={{ width: '1.6rem', height: '1.6rem', borderRadius: '999px', border: 'none', background: 'transparent', fontSize: '1rem', cursor: 'pointer' }}>−</button>
                  <span style={{ minWidth: '1.2rem', textAlign: 'center', fontWeight: 700, fontSize: '0.85rem' }}>{line.quantity}</span>
                  <button onClick={() => cart.updateQty(line.lineId, line.quantity + 1)} aria-label="Increase"
                    style={{ width: '1.6rem', height: '1.6rem', borderRadius: '999px', border: 'none', background: 'transparent', fontSize: '1rem', cursor: 'pointer' }}>+</button>
                </div>
              </div>
              <div style={{ textAlign: 'right' }}>
                <p style={{ fontWeight: 700 }}>{fmt(line.priceCents * line.quantity)}</p>
                <button onClick={() => cart.removeItem(line.lineId)}
                  style={{ background: 'transparent', border: 'none', color: 'var(--servd-mute)', fontSize: '0.75rem', marginTop: '0.4rem', cursor: 'pointer' }}>Remove</button>
              </div>
            </div>
          ))}
        </div>

        {cart.items.length > 0 && (
          <footer style={{ padding: '1rem 1.5rem 1.25rem', borderTop: '1px solid var(--servd-line)' }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.3rem', marginBottom: '1rem', fontSize: '0.9rem' }}>
              {/* Tax/GST is computed at checkout once the customer picks
                  a payment method (8% on card-rails, 15% on cash), so
                  the basket only shows subtotal here and notes that tax
                  is added at the next step. */}
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span style={{ color: 'var(--servd-mute)' }}>Subtotal</span>
                <span>{fmt(subtotal)}</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.75rem', color: 'var(--servd-mute)' }}>
                <span>GST</span>
                <span>added at checkout</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontWeight: 800, fontSize: '1.05rem', marginTop: '0.4rem', paddingTop: '0.5rem', borderTop: '1px solid var(--servd-line)' }}>
                <span>Total before tax</span>
                <span>{fmt(subtotal)}</span>
              </div>
            </div>
            <MagneticButton onClick={onCheckout} className="servd-btn-primary" style={{ width: '100%', padding: '1rem' }}>
              Checkout · {fmt(subtotal)} + tax
            </MagneticButton>
          </footer>
        )}
      </div>
    </div>
  )
}
