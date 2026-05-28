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
import { useCart } from '../../store/cart'
import { conceptHeroImage } from '../../lib/concept'
import { useBrandSlug, getServdHost } from '../../lib/host'
import { encodeCartToken } from '../../lib/cartHandoff'

const API_URL = process.env['NEXT_PUBLIC_API_URL'] ?? 'http://localhost:3001'

interface Modifier   { id: string; name: string; priceDeltaCents: number; isDefault?: boolean }
interface ModGroup   { id: string; name: string; minSelect: number; maxSelect: number; isRequired: boolean; modifiers: Modifier[] }
interface MenuItem   {
  id: string; name: string; description: string | null; priceCents: number
  imageUrl: string | null; isAvailable: boolean
  allergens?: string[]
  dietary?: string[]
  spiceLevel?: number | null
  modifierGroups?: ModGroup[]
}

const DIETARY_BADGE: Record<string, { label: string; color: string }> = {
  vegetarian:  { label: '🌿 Veg',     color: 'rgba(30,58,138,0.15)' },
  vegan:       { label: '🌱 Vegan',   color: 'rgba(30,58,138,0.15)' },
  halal:       { label: 'Halal',      color: 'rgba(30,58,138,0.15)' },
  gluten_free: { label: 'GF',         color: 'rgba(245,158,11,0.15)' },
}
interface Category   { id: string; name: string; sortOrder: number; items: MenuItem[] }
interface Concept    {
  id: string; name: string; slug: string; type: string
  description: string | null; logoUrl: string | null; primaryColor: string | null; taxRate: number
  phone?: string | null; address?: string | null
  latitude?: number | null; longitude?: number | null
}

function fmt(cents: number): string {
  return `PKR ${(cents / 100).toLocaleString('en-PK', { maximumFractionDigits: 0 })}`
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
      <div className="min-h-screen flex items-center justify-center p-6 text-center">
        <div>
          <h1 className="text-2xl font-bold mb-2">We can&rsquo;t open this brand right now.</h1>
          <p className="text-s-muted text-sm mb-4">{error}</p>
          <Link href="/browse" className="servd-btn-primary">Back to brands</Link>
        </div>
      </div>
    )
  }

  if (!concept || !categories) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div role="status" className="text-s-muted text-sm">Loading menu…</div>
      </div>
    )
  }

  const accent = concept.primaryColor ?? 'var(--servd-green-dark)'
  const itemTotal = cart.itemCount()
  const hasItems = itemTotal > 0

  return (
    <div style={{ background: '#fff', minHeight: '100vh', paddingBottom: hasItems ? '7rem' : '0' }}>
      {/* Hero */}
      <section
        style={{
          position: 'relative',
          minHeight: '320px',
          display: 'flex',
          alignItems: 'flex-end',
          background: `${accent} url(${conceptHeroImage(concept)}) center/cover`,
          color: '#fff',
        }}
      >
        <div aria-hidden="true" style={{ position: 'absolute', inset: 0, background: 'linear-gradient(180deg, rgba(0,0,0,0.15) 0%, rgba(0,0,0,0.65) 100%)' }} />
        <div className="container" style={{ position: 'relative', zIndex: 1, paddingTop: '5rem', paddingBottom: '2rem' }}>
          <div className="flex items-center justify-between mb-4 flex-wrap gap-2">
            <Link href={`/brand/${concept.slug}`} style={{ color: 'rgba(255,255,255,0.85)', textDecoration: 'none', fontSize: '0.85rem' }}>
              ← {concept.name}
            </Link>
            <Link href="/browse" style={{ color: 'rgba(255,255,255,0.85)', textDecoration: 'none', fontSize: '0.85rem' }}>
              Other brands →
            </Link>
          </div>
          <h1 style={{ fontSize: 'clamp(2rem, 5vw, 3.25rem)', fontWeight: 900, letterSpacing: '-0.04em', marginBottom: '0.5rem' }}>
            {concept.name}
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
            <p className="text-s-muted">{concept.name} hasn&rsquo;t published a menu. Check back soon.</p>
          </div>
        )}

        {categories.map((cat) => (
          <section key={cat.id} id={`cat-${cat.id}`} style={{ scrollMarginTop: '120px' }}>
            <h2 style={{ fontSize: 'clamp(1.4rem, 3vw, 1.85rem)', marginBottom: '1.25rem' }}>{cat.name}</h2>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: '1rem' }}>
              {cat.items.map((item) => <ItemCard key={item.id} item={item} onClick={() => setOpenItem(item)} accent={accent} />)}
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
          taxRate={concept.taxRate / 100}
          onCheckout={() => {
            // On a brand custom domain (eatstax.com, stax.localhost:3002…),
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

function ItemCard({ item, onClick, accent }: { item: MenuItem; onClick: () => void; accent: string }) {
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
      }}>
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
                  fontSize: '0.65rem', fontWeight: 700, letterSpacing: '0.05em',
                  padding: '0.15rem 0.45rem', borderRadius: '999px',
                  background: b?.color ?? 'rgba(0,0,0,0.06)', color: 'var(--servd-ink)',
                }}>
                  {b?.label ?? d}
                </span>
              )
            })}
            {(item.spiceLevel ?? 0) > 0 && (
              <span style={{ fontSize: '0.65rem', fontWeight: 700, padding: '0.15rem 0.45rem', borderRadius: '999px', background: 'rgba(220,38,38,0.12)', color: '#991b1b' }}>
                {'🌶️'.repeat(Math.min(item.spiceLevel ?? 0, 3))}
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
  item, accent, onClose, onAdd,
}: {
  item: MenuItem
  conceptSlug: string
  accent: string
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
          maxHeight: '92vh', overflow: 'hidden',
          display: 'flex', flexDirection: 'column',
          animation: 'fadeUp 200ms cubic-bezier(0.22,1,0.36,1) both',
        }}
      >
        <div style={{
          aspectRatio: '16/10',
          background: item.imageUrl ? `url(${item.imageUrl}) center/cover` : `linear-gradient(135deg, ${accent}22 0%, white 200%)`,
          position: 'relative',
        }}>
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
                      background: 'var(--servd-green)', color: 'white',
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
                          background: checked ? 'rgba(30,58,138,0.08)' : 'transparent',
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
  open, onOpen, onClose, accent, taxRate, onCheckout,
}: {
  open: boolean
  onOpen: () => void
  onClose: () => void
  accent: string
  taxRate: number
  onCheckout: () => void
}) {
  const cart = useCart()
  const subtotal = cart.subtotalCents()
  const tax = Math.round(subtotal * taxRate)
  const total = subtotal + tax
  const itemCount = cart.itemCount()

  if (!open) {
    // Floating CTA pill anchored to bottom of screen
    return (
      <button
        onClick={onOpen}
        aria-label={`View cart — ${itemCount} item${itemCount === 1 ? '' : 's'}, ${fmt(total)}`}
        style={{
          position: 'fixed', bottom: '1.25rem', left: '50%', transform: 'translateX(-50%)', zIndex: 40,
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
        <span style={{ opacity: 0.85 }}>{fmt(total)}</span>
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
          maxHeight: '92vh', display: 'flex', flexDirection: 'column',
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
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span style={{ color: 'var(--servd-mute)' }}>Subtotal</span>
                <span>{fmt(subtotal)}</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span style={{ color: 'var(--servd-mute)' }}>GST ({(taxRate * 100).toFixed(0)}%)</span>
                <span>{fmt(tax)}</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontWeight: 800, fontSize: '1.05rem', marginTop: '0.4rem', paddingTop: '0.5rem', borderTop: '1px solid var(--servd-line)' }}>
                <span>Total</span>
                <span>{fmt(total)}</span>
              </div>
            </div>
            <button onClick={onCheckout} className="servd-btn-primary" style={{ width: '100%', padding: '1rem' }}>
              Checkout · {fmt(total)}
            </button>
          </footer>
        )}
      </div>
    </div>
  )
}
