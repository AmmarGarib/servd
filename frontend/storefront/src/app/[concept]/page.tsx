'use client'

// Per-brand ordering page — the film's middle act, "filling the bag".
//   • brand-keyed hero (duotone photo in the brand's colours, scroll parallax,
//     name on a title plate)
//   • sticky category nav (jumps within the page)
//   • menu grid, each card "plated" by its own scroll progress
//   • item modal → the dish flies into the basket FAB, the companion catches
//     it, a line from the brand's voice confirms it
//   • basket drawer with the checkout CTA (cuts into checkout on servd)
//   • a designed "kitchen closed" scene per brand when the menu is unavailable
//
// The page sits on the brand's own surface (components/ordering/theme.ts)
// instead of #fff: Flipd bone, stackd plum with cream stickers, simmer tiber
// with bone cards, servd cream.
//
// Uses the public storefront API: /storefront/concepts and /storefront/:slug/menu.

import { useEffect, useRef, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { MagneticButton } from '@/components/ui/MagneticButton'
import { Companion, companionKindFor } from '@/components/characters/Companion'
import { requestCut } from '@/lib/film/cut'
import { voice } from '@/lib/voice'
import { ClosedScene } from '@/components/ordering/ClosedScene'
import { OrderingHero } from '@/components/ordering/OrderingHero'
import { OrderingSkeleton } from '@/components/ordering/OrderingSkeleton'
import { Plated } from '@/components/ordering/Plated'
import { flyToBag } from '@/components/ordering/FlyToBag'
import { orderingTheme, themeVars } from '@/components/ordering/theme'
import o from '@/components/ordering/ordering.module.css'
import { useCart } from '../../store/cart'
import { conceptHeroImage, formatBrandName } from '../../lib/concept'
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
/** Line-drawn cloche for dishes without a photo — a designed empty plate
 *  instead of a gradient wash. */
function ClocheIcon() {
  return (
    <svg width="64" height="48" viewBox="0 0 64 48" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M8 38 A24 24 0 0 1 56 38 Z" />
      <path d="M32 14 v-4 M28 10 h8" />
      <path d="M4 42 H60" />
    </svg>
  )
}
function PlusIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" aria-hidden="true">
      <path d="M12 5v14M5 12h14" />
    </svg>
  )
}

const DIETARY_BADGE: Record<string, { label: string; withIcon: boolean }> = {
  vegetarian:  { label: 'Veg',   withIcon: true  },
  vegan:       { label: 'Vegan', withIcon: true  },
  halal:       { label: 'Halal', withIcon: false },
  gluten_free: { label: 'GF',    withIcon: false },
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
// to render a usable page from just the URL slug. Always rendered through
// formatBrandName, so "stackd"/"simmer" stay lowercase.
function prettifySlug(slug: string): string {
  return slug
    .split('-')
    .map((w) => w.slice(0, 1).toUpperCase() + w.slice(1))
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
  // "Added" toast: a sequence number so back-to-back adds restart it.
  const [toast, setToast] = useState<number | null>(null)
  const toastSeq = useRef(0)

  const cart = useCart()
  const brandSlug = useBrandSlug()
  const theme = orderingTheme(slug)

  // Fetch concept + menu. Resilient against either API hiccupping: if the
  // /concepts fetch fails (Neon cold-start, transient 5xx, rate limit) we
  // derive a minimal placeholder concept from the slug so the menu still
  // renders. Only show the closed scene when the *menu* itself is unavailable
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

  // The "added" toast lives 1.4s.
  useEffect(() => {
    if (toast === null) return
    const t = window.setTimeout(() => setToast(null), 1400)
    return () => window.clearTimeout(t)
  }, [toast])

  if (error) {
    return <ClosedScene slug={slug} />
  }

  if (!concept || !categories) {
    return <OrderingSkeleton slug={slug} />
  }

  const itemTotal = cart.itemCount()
  const hasItems = itemTotal > 0
  const fmt = fmtFor(slug)
  const brandName = formatBrandName(concept.name)
  const companionKind = companionKindFor(slug)
  const lines = voice(slug)

  return (
    <div
      className={`${o.page} ${o[theme.brand]}`}
      style={{ ...themeVars(theme), paddingBottom: hasItems ? '7.5rem' : '0' }}
    >
      <OrderingHero
        slug={concept.slug}
        name={brandName}
        description={concept.description}
        imageUrl={conceptHeroImage(concept)}
        theme={theme}
      />

      {/* Sticky category nav — in-page jumps, so opted out of the cut. */}
      {categories.length > 0 && (
        <nav aria-label="Menu sections" className={o.catNav}>
          {categories.map((c) => {
            const active = activeCategory === c.id
            return (
              <a
                key={c.id}
                href={`#cat-${c.id}`}
                data-no-cut
                aria-current={active ? 'true' : undefined}
                className={`${o.catLink} ${active ? o.catLinkActive : ''}`}
                onClick={(e) => {
                  e.preventDefault()
                  document.getElementById(`cat-${c.id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
                  setActiveCategory(c.id)
                }}
              >
                {c.name}
              </a>
            )
          })}
        </nav>
      )}

      {/* Menu */}
      <div className={`${o.wrap} ${o.menu}`}>
        {categories.length === 0 && (
          <div className={o.empty}>
            <h3>No menu yet</h3>
            <p>{brandName} hasn&rsquo;t published a menu. Check back soon.</p>
          </div>
        )}

        {categories.map((cat) => (
          <section key={cat.id} id={`cat-${cat.id}`} className={o.catSection}>
            <h2 className={o.catTitle}>{cat.name}</h2>
            <div className={o.grid}>
              {cat.items.map((item) => (
                <Plated key={item.id}>
                  <ItemCard item={item} onClick={() => setOpenItem(item)} fmt={fmt} />
                </Plated>
              ))}
            </div>
          </section>
        ))}
      </div>

      {/* Item modal */}
      {openItem && (
        <ItemDetailModal
          item={openItem}
          conceptSlug={concept.slug}
          fmt={fmt}
          onClose={() => setOpenItem(null)}
          onAdd={(item, qty, modifiers, finalPriceCents, notes, originRect) => {
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
            // The dish flies into the bag (skipped under reduced motion) and
            // the brand says so; the basket stays one tap away on the FAB.
            if (originRect) flyToBag(originRect, { color: theme.token, imageUrl: item.imageUrl })
            toastSeq.current += 1
            setToast(toastSeq.current)
          }}
        />
      )}

      {/* "Added" toast — always mounted so the live region is announced. */}
      <div aria-live="polite" role="status" className={o.toastRegion}>
        {toast !== null && <span key={toast} className={o.toast}>{lines.added}</span>}
      </div>

      {/* The sidekick: bottom-left, clear of the FAB; none on simmer. */}
      {companionKind && (
        <div className={o.companionDock} aria-hidden>
          <Companion kind={companionKind} placement="inline" size={96} mood="watch" />
        </div>
      )}

      {/* Cart drawer */}
      {hasItems && (
        <CartDrawer
          open={cartOpen}
          onOpen={() => setCartOpen(true)}
          onClose={() => setCartOpen(false)}
          fmt={fmt}
          onCheckout={(originRect) => {
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
            // servd host: the checkout button grows into the brand's cut.
            // requestCut returns false when the cut can't run (reduced
            // motion, SceneCut not mounted, a cut already running).
            if (requestCut('/' + slug + '/checkout', { origin: originRect })) return
            router.push(`/${concept.slug}/checkout`)
          }}
        />
      )}
    </div>
  )
}

// ───── Components ───────────────────────────────────────────────────────────

function ItemCard({ item, onClick, fmt }: { item: MenuItem; onClick: () => void; fmt: (cents: number) => string }) {
  const disabled = !item.isAvailable
  return (
    <button
      type="button"
      onClick={() => !disabled && onClick()}
      disabled={disabled}
      className={o.card}
      aria-label={`${item.name} — ${fmt(item.priceCents)}${disabled ? ' — sold out' : ''}`}
    >
      <div
        className={`${o.cardPhoto} ${item.imageUrl ? '' : o.cardPhotoEmpty}`}
        style={item.imageUrl ? { backgroundImage: `url(${item.imageUrl})` } : undefined}
      >
        {!item.imageUrl && !item.videoUrl && <ClocheIcon />}
        {item.videoUrl && (
          <video
            src={item.videoUrl}
            {...(item.imageUrl ? { poster: item.imageUrl } : {})}
            autoPlay muted loop playsInline preload="metadata"
            aria-hidden="true"
          />
        )}
        {disabled && <span className={o.soldOut}>Sold out</span>}
      </div>
      <div className={o.cardBody}>
        <h3 className={o.cardName}>{item.name}</h3>
        {item.description && <p className={o.cardDesc}>{item.description}</p>}
        {((item.dietary?.length ?? 0) > 0 || ((item.spiceLevel ?? 0) > 0)) && (
          <div className={o.badges}>
            {(item.dietary ?? []).map((d) => {
              const b = DIETARY_BADGE[d]
              return (
                <span key={d} className={o.badge}>
                  {b?.withIcon && <LeafIcon />}
                  {b?.label ?? d}
                </span>
              )
            })}
            {(item.spiceLevel ?? 0) > 0 && (
              <span className={o.badge} aria-label={`Spice level ${Math.min(item.spiceLevel ?? 0, 3)} of 3`}>
                {Array.from({ length: Math.min(item.spiceLevel ?? 0, 3) }).map((_, i) => (
                  <FlameIcon key={i} />
                ))}
              </span>
            )}
          </div>
        )}
        {(item.allergens?.length ?? 0) > 0 && (
          <p className={o.allergens}>Contains: {(item.allergens ?? []).join(', ')}</p>
        )}
        <div className={o.priceRow}>
          <span className={o.price}>{fmt(item.priceCents)}</span>
          {!disabled && <span className={o.plus} aria-hidden><PlusIcon /></span>}
        </div>
      </div>
    </button>
  )
}

function ItemDetailModal({
  item, onClose, onAdd, fmt,
}: {
  item: MenuItem
  conceptSlug: string
  fmt: (cents: number) => string
  onClose: () => void
  onAdd: (
    item: MenuItem,
    qty: number,
    modifiers: { modifierId: string; name: string; priceDeltaCents: number }[],
    finalPriceCents: number,
    notes: string,
    originRect: DOMRect | null,
  ) => void
}) {
  const [qty, setQty] = useState(1)
  const [notes, setNotes] = useState('')
  const addRef = useRef<HTMLButtonElement>(null)

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
      className={o.backdrop}
    >
      <div onClick={(e) => e.stopPropagation()} className={o.sheet}>
        <div
          className={`${o.sheetPhoto} ${item.imageUrl ? '' : o.cardPhotoEmpty}`}
          style={item.imageUrl ? { backgroundImage: `url(${item.imageUrl})` } : undefined}
        >
          {!item.imageUrl && !item.videoUrl && <ClocheIcon />}
          {item.videoUrl && (
            <video
              src={item.videoUrl}
              {...(item.imageUrl ? { poster: item.imageUrl } : {})}
              autoPlay muted loop playsInline preload="metadata"
              aria-hidden="true"
            />
          )}
          <button type="button" onClick={onClose} aria-label="Close" className={`${o.iconBtn} ${o.sheetClose}`}>×</button>
        </div>

        <div className={o.sheetBody}>
          <h2 className={o.sheetTitle}>{item.name}</h2>
          {item.description && <p className={o.sheetDesc}>{item.description}</p>}
          <p className={o.sheetPrice}>{fmt(item.priceCents)}</p>

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
              <fieldset key={g.id} className={o.fieldset}>
                <legend className={o.legend}>
                  <span className={o.legendName}>{g.name}</span>
                  {g.isRequired && <span className={o.req}>Required</span>}
                </legend>
                <p className={o.caption}>{caption}</p>
                <div className={o.opts}>
                  {g.modifiers.map((m) => {
                    const checked = picked.has(m.id)
                    const reachedMax = !radio && !checked && picked.size >= g.maxSelect
                    return (
                      <label
                        key={m.id}
                        className={`${o.opt} ${checked ? o.optOn : ''} ${reachedMax ? o.optMaxed : ''}`}
                      >
                        <span className={o.optLabel}>
                          <input
                            type={radio ? 'radio' : 'checkbox'}
                            name={radio ? g.id : undefined}
                            checked={checked}
                            disabled={reachedMax}
                            onChange={() => togglePick(g, m.id)}
                          />
                          <span>{m.name}</span>
                        </span>
                        {m.priceDeltaCents !== 0 && (
                          <span className={o.optDelta}>
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

          <label className={o.notesLabel}>
            <span>Notes for the kitchen (optional)</span>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={2}
              maxLength={200}
              placeholder="e.g. no onions, extra spicy"
              className={o.notes}
            />
          </label>
        </div>

        <div className={o.sheetFooter}>
          <div className={o.qty}>
            <button type="button" onClick={() => setQty(Math.max(1, qty - 1))} aria-label="Decrease quantity" className={o.iconBtn}>−</button>
            <span className={o.qtyN} aria-live="polite">{qty}</span>
            <button type="button" onClick={() => setQty(Math.min(20, qty + 1))} aria-label="Increase quantity" className={o.iconBtn}>+</button>
          </div>
          <button
            ref={addRef}
            type="button"
            onClick={() => {
              if (!canAdd) return
              // Measure before the modal unmounts — the flight starts here.
              const rect = addRef.current?.getBoundingClientRect() ?? null
              onAdd(item, qty, pickedModifiers, lineUnitPriceCents, notes.trim(), rect)
            }}
            disabled={!canAdd}
            className={o.cta}
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
  open, onOpen, onClose, onCheckout, fmt,
}: {
  open: boolean
  onOpen: () => void
  onClose: () => void
  onCheckout: (originRect: DOMRect | null) => void
  fmt: (cents: number) => string
}) {
  // Tax is computed at checkout (payment-method aware), not here.
  // The basket just shows subtotal.
  const cart = useCart()
  const subtotal = cart.subtotalCents()
  const itemCount = cart.itemCount()

  if (!open) {
    // Floating basket pill anchored to the bottom centre. data-cart-fab is
    // the landing target for flyToBag.
    return (
      <button
        type="button"
        data-cart-fab
        onClick={onOpen}
        aria-label={`View basket — ${itemCount} item${itemCount === 1 ? '' : 's'}, ${fmt(subtotal)}`}
        className={o.fab}
      >
        <span className={o.fabBadge}>{itemCount}</span>
        <span className={o.fabLabel}>View basket</span>
        <span className={o.fabSum}>{fmt(subtotal)}</span>
      </button>
    )
  }

  return (
    <div role="dialog" aria-modal="true" aria-label="Basket" onClick={onClose} className={o.backdrop}>
      <div onClick={(e) => e.stopPropagation()} className={o.sheet}>
        <header className={o.drawerHead}>
          <h2 className={o.drawerTitle}>Your basket</h2>
          <button type="button" onClick={onClose} aria-label="Close basket" className={o.iconBtn}>×</button>
        </header>

        <div className={o.drawerList}>
          {cart.items.length === 0 && (
            <p className={o.drawerEmpty}>Basket&rsquo;s empty.</p>
          )}
          {cart.items.map((line) => (
            <div key={line.lineId} className={o.line}>
              <div className={o.lineMain}>
                <p className={o.lineName}>{line.name}</p>
                {line.modifiers && line.modifiers.length > 0 && (
                  <p className={o.lineMods}>{line.modifiers.map((m) => m.name).join(' · ')}</p>
                )}
                <p className={o.lineMeta}>{fmt(line.priceCents)} · qty {line.quantity}</p>
                <div className={`${o.qty} ${o.lineQty}`}>
                  <button type="button" onClick={() => cart.updateQty(line.lineId, line.quantity - 1)} aria-label={`Decrease ${line.name}`} className={o.iconBtn}>−</button>
                  <span className={o.qtyN}>{line.quantity}</span>
                  <button type="button" onClick={() => cart.updateQty(line.lineId, line.quantity + 1)} aria-label={`Increase ${line.name}`} className={o.iconBtn}>+</button>
                </div>
              </div>
              <div className={o.lineEnd}>
                <p className={o.lineTotal}>{fmt(line.priceCents * line.quantity)}</p>
                <button type="button" onClick={() => cart.removeItem(line.lineId)} className={o.remove}>Remove</button>
              </div>
            </div>
          ))}
        </div>

        {cart.items.length > 0 && (
          <footer className={o.drawerFoot}>
            <div className={o.sums}>
              {/* Tax/GST is computed at checkout once the customer picks
                  a payment method (8% on card-rails, 15% on cash), so
                  the basket only shows subtotal here and notes that tax
                  is added at the next step. */}
              <div className={o.sumRow}>
                <span className={o.sumMute}>Subtotal</span>
                <span>{fmt(subtotal)}</span>
              </div>
              <div className={`${o.sumRow} ${o.sumSmall}`}>
                <span>GST</span>
                <span>added at checkout</span>
              </div>
              <div className={`${o.sumRow} ${o.sumTotal}`}>
                <span>Total before tax</span>
                <span>{fmt(subtotal)}</span>
              </div>
            </div>
            <MagneticButton
              type="button"
              onClick={(e) => onCheckout(e.currentTarget.getBoundingClientRect())}
              className={`${o.cta} ${o.ctaWide}`}
            >
              Checkout · {fmt(subtotal)} + tax
            </MagneticButton>
          </footer>
        )}
      </div>
    </div>
  )
}
