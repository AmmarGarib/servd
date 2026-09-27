'use client'

// Per-brand ordering page: "Tray & Toss".
//   • brand-keyed hero (image + name + tagline)
//   • sticky category nav with a sliding active indicator
//   • menu grid of cards: tap to open, or the round '+' to quick-add
//   • adding an item throws it in an arc into the basket pill, which squashes
//     as it catches it while the count and subtotal roll like an odometer
//   • stackd and Flipd get a tiny food crowd perched on the pill (never simmer)
//   • cart drawer with remove + undo, item modal with modifier groups
//   • a "kitchen is napping" scene when the menu can't be shown
//
// Money paths are untouched: the addItem payload, the modal's price math, the
// checkout handoff (encodeCartToken / router.push) and the API calls are the
// same as before. The one behaviour change: adding from the modal no longer
// pops the drawer open; the item is tossed into the pill instead.
//
// Uses the public storefront API: /storefront/concepts and /storefront/:slug/menu.

import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { useParams, useRouter } from 'next/navigation'
import Link from 'next/link'
import dynamic from 'next/dynamic'
import {
  AnimatePresence,
  LayoutGroup,
  MotionConfig,
  motion,
  useAnimationControls,
  useMotionValue,
  useSpring,
  type Transition,
} from 'framer-motion'
import { MagneticButton, MagneticLink } from '@/components/ui/MagneticButton'
import { useCart, type CartItem } from '../../store/cart'
import { conceptHeroImage, formatBrandName } from '../../lib/concept'
import { useBrandSlug, getServdHost } from '../../lib/host'
import { encodeCartToken } from '../../lib/cartHandoff'
import { emptyBasketCopy } from '@/lib/basketCopy'
import { buzz, collect, hydratePlay, sfx, usePlay, usePrefersReducedMotion } from '@/lib/play'
import { emitCrowd } from '@/components/characters/crowdBus'
import type { CharacterKind } from '@/components/characters/types'
import {
  tossToBasket,
  tossesInFlight,
  useBasketCatch,
  type TossTone,
} from '@/components/play/toss/BasketToss'
import { MiniCrowd, miniCrowdCast } from '@/components/play/toss/MiniCrowd'
import { Odometer } from '@/components/play/toss/Odometer'
import { markTasted, useTasted } from '@/components/play/toss/passport'
import styles from '@/components/play/toss/toss.module.css'

const FoodCrowd = dynamic(() => import('@/components/characters/FoodCrowd').then((m) => m.FoodCrowd), { ssr: false })

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
type PickedModifier = { modifierId: string; name: string; priceDeltaCents: number }

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
function PlusIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" aria-hidden="true">
      <path d="M12 5v14M5 12h14" />
    </svg>
  )
}
function MinusIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" aria-hidden="true">
      <path d="M5 12h14" />
    </svg>
  )
}
function CloseIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden="true">
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  )
}
/** Sold-out sticker face: closed eyes and a drawn "zz" (strokes, not text). */
function NappingFace() {
  return (
    <svg viewBox="0 0 30 26" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="11" cy="15" r="9" fill="currentColor" fillOpacity="0.12" />
      <path d="M6.5 14.5q2 1.8 4 0" />
      <path d="M12.5 14.5q2 1.8 4 0" />
      <path d="M9.5 19.2q1.5.8 3 0" />
      <path d="M21 4h4l-4 4.5h4" strokeWidth="1.6" />
      <path d="M24.5 11h3l-3 3.2h3" strokeWidth="1.4" />
    </svg>
  )
}

const DIETARY_BADGE: Record<string, { label: string; color: string; withIcon: boolean }> = {
  vegetarian:  { label: 'Veg',   color: 'rgba(58,14,105,0.15)',  withIcon: true  },
  vegan:       { label: 'Vegan', color: 'rgba(58,14,105,0.15)',  withIcon: true  },
  halal:       { label: 'Halal', color: 'rgba(58,14,105,0.15)',  withIcon: false },
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

// ───── Modifier helpers (shared by the modal and the card quick-add) ───────
// One source for the default picks and the unit price, so a quick-add lands
// on exactly the line the modal would have produced with no changes made.

function seedSelections(item: MenuItem): Record<string, Set<string>> {
  const seed: Record<string, Set<string>> = {}
  for (const g of item.modifierGroups ?? []) {
    const defaults = g.modifiers.filter((m) => m.isDefault).map((m) => m.id)
    seed[g.id] = new Set(defaults.slice(0, Math.max(1, g.maxSelect)))
  }
  return seed
}

function pickedFrom(groups: ModGroup[], selections: Record<string, Set<string>>): PickedModifier[] {
  return groups.flatMap((g) =>
    g.modifiers
      .filter((m) => selections[g.id]?.has(m.id))
      .map((m) => ({ modifierId: m.id, name: m.name, priceDeltaCents: m.priceDeltaCents })),
  )
}

function unitPriceCents(item: MenuItem, picked: PickedModifier[]): number {
  return item.priceCents + picked.reduce((s, m) => s + m.priceDeltaCents, 0)
}

/** A card can skip the modal when nothing about the item needs choosing. */
function canQuickAdd(item: MenuItem): boolean {
  if (!item.isAvailable) return false
  return !(item.modifierGroups ?? []).some((g) => g.isRequired || g.minSelect > 0)
}

// ───── Brand motion ─────────────────────────────────────────────────────────

function toneFor(slug: string | null | undefined): TossTone {
  return slug === 'stackd' || slug === 'flipd' || slug === 'simmer' ? slug : 'servd'
}

const POP: Transition = { type: 'spring', stiffness: 520, damping: 18 }

/** Sheet (modal + drawer) entrance per brand. Exit mirrors it. */
function sheetTransition(tone: TossTone): Transition {
  switch (tone) {
    case 'stackd': return { type: 'spring', stiffness: 380, damping: 22 }
    case 'flipd':  return { duration: 0.16, ease: 'easeOut' }
    case 'simmer': return { duration: 0.32, ease: [0.22, 1, 0.36, 1] }
    default:       return { type: 'spring', stiffness: 300, damping: 26 }
  }
}

function sheetMotion(tone: TossTone, reduced: boolean) {
  if (reduced) {
    const t: Transition = { duration: 0.12 }
    return { initial: { opacity: 0 }, animate: { opacity: 1 }, exit: { opacity: 0 }, transition: t }
  }
  const t = sheetTransition(tone)
  return { initial: { y: '100%' }, animate: { y: 0 }, exit: { y: '100%' }, transition: t }
}

function scrimTransition(tone: TossTone, reduced: boolean): Transition {
  if (reduced) return { duration: 0.12 }
  return { duration: tone === 'simmer' ? 0.32 : 0.2, ease: 'easeOut' }
}

function useFinePointer(): boolean {
  const [fine, setFine] = useState(false)
  useEffect(() => {
    let mq: MediaQueryList
    try {
      mq = window.matchMedia('(hover: hover) and (pointer: fine)')
    } catch {
      return
    }
    const sync = () => setFine(mq.matches)
    sync()
    mq.addEventListener?.('change', sync)
    return () => mq.removeEventListener?.('change', sync)
  }, [])
  return fine
}

/** Escape closes, focus moves into the sheet and back out when it closes. */
function useSheetFocus(onClose: () => void) {
  const sheetRef = useRef<HTMLDivElement>(null)
  const closeRef = useRef(onClose)
  closeRef.current = onClose
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    sheetRef.current?.focus({ preventScroll: true })
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeRef.current()
    }
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
      if (previous && document.contains(previous)) previous.focus({ preventScroll: true })
    }
  }, [])
  return sheetRef
}

const SESSION_TOSSED = 'servd-tossed-session'

function readSessionTossed(): boolean {
  try {
    return window.sessionStorage.getItem(SESSION_TOSSED) === '1'
  } catch {
    return false
  }
}
function writeSessionTossed() {
  try {
    window.sessionStorage.setItem(SESSION_TOSSED, '1')
  } catch {
    /* ignore */
  }
}

// ───── Page ─────────────────────────────────────────────────────────────────

export default function ConceptOrderPage() {
  const { concept: slug } = useParams<{ concept: string }>()
  const router = useRouter()

  const [concept, setConcept] = useState<Concept | null>(null)
  const [categories, setCategories] = useState<Category[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [activeCategory, setActiveCategory] = useState<string | null>(null)
  const [openItem, setOpenItem] = useState<MenuItem | null>(null)
  const [cartOpen, setCartOpen] = useState(false)
  const [reloadKey, setReloadKey] = useState(0)
  const [tossedThisSession, setTossedThisSession] = useState(false)

  const cart = useCart()
  const brandSlug = useBrandSlug()
  const reduced = usePrefersReducedMotion()
  const tasted = useTasted()
  const tone = toneFor(slug)

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
        setError(null)
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
  }, [slug, reloadKey])

  // Visiting a kitchen counts toward the grand-tour sticker.
  useEffect(() => {
    try {
      usePlay.getState().markKitchen(slug)
    } catch {
      /* decorative */
    }
  }, [slug])

  // A tossed item earlier this session keeps the mini crowd on the pill.
  useEffect(() => {
    if (readSessionTossed()) setTossedThisSession(true)
  }, [])

  // ?basket=open (the nav basket links here) opens the drawer when there's
  // something in it for this kitchen, then strips the param. Read from
  // window.location, not useSearchParams, so the page needs no Suspense.
  useEffect(() => {
    try {
      const params = new URLSearchParams(window.location.search)
      if (params.get('basket') !== 'open') return
      const st = useCart.getState()
      if (st.items.length > 0 && (!st.conceptSlug || st.conceptSlug === slug)) setCartOpen(true)
      params.delete('basket')
      const q = params.toString()
      window.history.replaceState(window.history.state, '', `${window.location.pathname}${q ? `?${q}` : ''}${window.location.hash}`)
    } catch {
      /* ignore */
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Track the active category as the user scrolls (rAF-throttled).
  useEffect(() => {
    if (!categories) return
    let frame = 0
    const measure = () => {
      frame = 0
      const offset = 180  // sticky header height
      let current: string | null = null
      for (const c of categories) {
        const el = document.getElementById(`cat-${c.id}`)
        if (el && el.getBoundingClientRect().top < offset) current = c.id
      }
      if (current) setActiveCategory(current)
    }
    const handler = () => {
      if (!frame) frame = requestAnimationFrame(measure)
    }
    window.addEventListener('scroll', handler, { passive: true })
    return () => {
      window.removeEventListener('scroll', handler)
      if (frame) cancelAnimationFrame(frame)
    }
  }, [categories])

  // Every landing: first-toss sticker (once ever), a thunk, a buzz, a cheer.
  useBasketCatch((c) => {
    try {
      hydratePlay()
      if (usePlay.getState().stickers['first-toss'] == null) collect('first-toss', { x: c.x, y: c.y })
    } catch {
      /* decorative */
    }
    buzz(10)
    if (tone !== 'simmer') {
      sfx('thunk')
      emitCrowd({ type: 'cheer' })
    }
  })

  const launchToss = useCallback((from: DOMRect | null, item: MenuItem, count: number) => {
    markTasted(item.id)
    if (!tossedThisSession) {
      setTossedThisSession(true)
      writeSessionTossed()
    }
    const rect = from ?? new DOMRect(window.innerWidth / 2 - 28, window.innerHeight / 2 - 28, 56, 56)
    const n = Math.max(1, Math.min(count, 4))
    for (let i = 0; i < n; i++) {
      void tossToBasket(rect, item.imageUrl, item.name, { tone, calm: tone === 'simmer' })
    }
  }, [tone, tossedThisSession])

  const quickAdd = useCallback((item: MenuItem, from: DOMRect | null) => {
    // Same line the modal would produce untouched: default picks, no notes.
    const groups = item.modifierGroups ?? []
    const picked = pickedFrom(groups, seedSelections(item))
    cart.addItem({
      menuItemId: item.id,
      name: item.name,
      priceCents: unitPriceCents(item, picked),
      ...(picked.length > 0 && { modifiers: picked }),
    })
    launchToss(from, item, 1)
  }, [cart, launchToss])

  const onCheckout = () => {
    if (!concept) return
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
  }

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
  const pageClass = [brandSkinClass, styles.page].filter(Boolean).join(' ')

  if (error) {
    return (
      <MotionConfig reducedMotion="user">
        <div className={pageClass} data-tone={tone}>
          <KitchenNapping slug={slug} tone={tone} variant="unavailable" onRetry={() => { setError(null); setReloadKey((k) => k + 1) }} />
        </div>
      </MotionConfig>
    )
  }

  if (!concept || !categories) {
    // Menu skeleton — same hero stripe + category nav strip + 4 item rows
    // as the real page, just tinted. Reserves the layout so the real menu
    // doesn't push content around on hydrate (avoids CLS).
    return (
      <div role="status" aria-label="Loading menu" className={pageClass} data-tone={tone}>
        <div className={styles.skelHero} />
        <div style={{ padding: '1rem 1rem 0', display: 'flex', gap: '0.5rem', overflowX: 'hidden' }}>
          {Array.from({ length: 4 }).map((_, i) => (
            <span key={i} className={styles.skelBar} style={{ width: '4.5rem', height: '2rem', borderRadius: '999px', flex: 'none' }} />
          ))}
        </div>
        <div style={{ padding: '1.25rem', display: 'grid', gap: '0.85rem' }}>
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className={styles.skelBar} style={{ height: '5.5rem', borderRadius: '1rem', animationDelay: `${i * 90}ms` }} />
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
  const brandName = formatBrandName(concept.name)
  const crowdOnPill = tossedThisSession && miniCrowdCast(slug) !== null

  return (
    <MotionConfig reducedMotion="user">
      <div className={pageClass} data-tone={tone} style={{ paddingBottom: hasItems ? '8rem' : '0' }}>
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
                ← {brandName}
              </Link>
              <Link href="/browse" style={{ color: 'rgba(255,255,255,0.85)', textDecoration: 'none', fontSize: '0.85rem' }}>
                {tone === 'simmer' || tone === 'stackd' ? 'other kitchens →' : 'Other brands →'}
              </Link>
            </div>
            <h1 style={{ fontSize: 'clamp(2rem, 5vw, 3.25rem)', fontWeight: 900, letterSpacing: '-0.04em', marginBottom: '0.5rem', color: '#fff' }}>
              {brandName}
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
          <CategoryNav
            categories={categories}
            active={activeCategory}
            reduced={reduced}
            onPick={(id) => {
              document.getElementById(`cat-${id}`)?.scrollIntoView({ behavior: reduced ? 'auto' : 'smooth', block: 'start' })
              setActiveCategory(id)
            }}
          />
        )}

        {/* Menu */}
        {categories.length === 0 ? (
          <KitchenNapping slug={slug} tone={tone} variant="empty" brandName={brandName} />
        ) : (
          <div className="container" style={{ padding: 'clamp(2rem, 4vw, 3rem) 0', display: 'grid', gap: '2.5rem' }}>
            {categories.map((cat) => (
              <section key={cat.id} id={`cat-${cat.id}`} style={{ scrollMarginTop: '120px' }}>
                <h2 className={styles.catTitle}>{cat.name}</h2>
                <div className={styles.grid}>
                  {cat.items.map((item) => (
                    <ItemCard
                      key={item.id}
                      item={item}
                      tone={tone}
                      fmt={fmt}
                      tasted={tasted.has(item.id)}
                      reduced={reduced}
                      onOpen={() => setOpenItem(item)}
                      onQuickAdd={(from) => quickAdd(item, from)}
                    />
                  ))}
                </div>
              </section>
            ))}
          </div>
        )}

        {/* Item modal */}
        <AnimatePresence>
          {openItem && (
            <ItemDetailModal
              key={openItem.id}
              item={openItem}
              accent={accent}
              tone={tone}
              reduced={reduced}
              fmt={fmt}
              onClose={() => setOpenItem(null)}
              onAdd={(item, qty, modifiers, finalPriceCents, notes, from) => {
                for (let i = 0; i < qty; i++) {
                  cart.addItem({
                    menuItemId: item.id,
                    name: item.name,
                    priceCents: finalPriceCents,
                    ...(modifiers.length > 0 && { modifiers }),
                    ...(notes && { notes }),
                  })
                }
                // Close the modal, then toss into the pill. The drawer no
                // longer pops open on its own.
                setOpenItem(null)
                launchToss(from, item, qty)
              }}
            />
          )}
        </AnimatePresence>

        {/* Basket pill (bottom-centre, z 40) */}
        <AnimatePresence>
          {hasItems && (
            <BasketDock
              key="dock"
              slug={slug}
              tone={tone}
              fmt={fmt}
              count={itemTotal}
              subtotalCents={cart.subtotalCents()}
              drawerOpen={cartOpen}
              reduced={reduced}
              showCrowd={crowdOnPill}
              onOpen={() => setCartOpen(true)}
            />
          )}
        </AnimatePresence>

        {/* Cart drawer */}
        <AnimatePresence>
          {cartOpen && (
            <CartDrawer
              key="drawer"
              slug={slug}
              tone={tone}
              reduced={reduced}
              fmt={fmt}
              onClose={() => setCartOpen(false)}
              onCheckout={onCheckout}
            />
          )}
        </AnimatePresence>
      </div>
    </MotionConfig>
  )
}

// ───── Category nav ─────────────────────────────────────────────────────────

function CategoryNav({
  categories, active, reduced, onPick,
}: {
  categories: Category[]
  active: string | null
  reduced: boolean
  onPick: (id: string) => void
}) {
  const navRef = useRef<HTMLElement>(null)

  // Keep the active pill in view on narrow screens.
  useEffect(() => {
    const nav = navRef.current
    if (!nav || !active) return
    const link = nav.querySelector<HTMLElement>(`[data-cat="${CSS.escape(active)}"]`)
    if (!link) return
    const left = link.offsetLeft
    const right = left + link.offsetWidth
    if (left < nav.scrollLeft + 16 || right > nav.scrollLeft + nav.clientWidth - 16) {
      nav.scrollTo({ left: Math.max(0, left - 24), behavior: reduced ? 'auto' : 'smooth' })
    }
  }, [active, reduced])

  return (
    <nav ref={navRef} aria-label="Menu sections" className={styles.catNav}>
      <LayoutGroup id="cat-nav">
        {categories.map((c) => {
          const isActive = active === c.id
          return (
            <a
              key={c.id}
              href={`#cat-${c.id}`}
              data-cat={c.id}
              aria-current={isActive ? 'true' : undefined}
              className={styles.catLink}
              onClick={(e) => {
                e.preventDefault()
                onPick(c.id)
              }}
            >
              {isActive && (
                <motion.span
                  layoutId="cat-indicator"
                  className={styles.catIndicator}
                  transition={{ type: 'spring', stiffness: 500, damping: 40 }}
                />
              )}
              {c.name}
            </a>
          )
        })}
      </LayoutGroup>
    </nav>
  )
}

// ───── Item card ────────────────────────────────────────────────────────────

function ItemCard({
  item, tone, fmt, tasted, reduced, onOpen, onQuickAdd,
}: {
  item: MenuItem
  tone: TossTone
  fmt: (cents: number) => string
  tasted: boolean
  reduced: boolean
  onOpen: () => void
  onQuickAdd: (from: DOMRect | null) => void
}) {
  const disabled = !item.isAvailable
  const quiet = tone === 'simmer'
  const fine = useFinePointer()
  const tilt = fine && !reduced && !disabled && !quiet
  const mediaRef = useRef<HTMLDivElement>(null)

  const rx = useMotionValue(0)
  const ry = useMotionValue(0)
  const srx = useSpring(rx, { stiffness: 260, damping: 22 })
  const sry = useSpring(ry, { stiffness: 260, damping: 22 })

  const quickable = canQuickAdd(item)
  const plusLabel = quickable ? `add ${item.name}` : `choose options for ${item.name}`

  return (
    <motion.div
      className={styles.card}
      data-soldout={disabled ? 'true' : 'false'}
      // whileTap would otherwise make this wrapper a tab stop; the two
      // buttons inside are the real keyboard targets.
      tabIndex={-1}
      style={{ rotateX: srx, rotateY: sry, transformPerspective: 900 }}
      whileTap={disabled ? undefined : { scale: 0.97 }}
      whileHover={fine && !disabled ? { y: quiet ? -2 : -4 } : undefined}
      transition={quiet ? { duration: 0.24, ease: [0.22, 1, 0.36, 1] } : POP}
      onPointerMove={(e) => {
        if (!tilt || e.pointerType !== 'mouse') return
        const r = e.currentTarget.getBoundingClientRect()
        const px = (e.clientX - r.left) / r.width - 0.5
        const py = (e.clientY - r.top) / r.height - 0.5
        ry.set(Math.max(-6, Math.min(6, px * 12)))
        rx.set(Math.max(-6, Math.min(6, -py * 12)))
      }}
      onPointerLeave={() => {
        rx.set(0)
        ry.set(0)
      }}
    >
      <button
        type="button"
        className={styles.cardMain}
        onClick={() => !disabled && onOpen()}
        disabled={disabled}
        aria-label={`${item.name} — ${fmt(item.priceCents)}${disabled ? ' — sold out' : ''}`}
      >
        <div
          ref={mediaRef}
          className={styles.media}
          style={item.imageUrl ? { backgroundImage: `url(${item.imageUrl})` } : undefined}
        >
          {!item.imageUrl && <span className={styles.mediaBlank} aria-hidden="true" />}
          {item.videoUrl && (
            <video
              src={item.videoUrl}
              {...(item.imageUrl ? { poster: item.imageUrl } : {})}
              autoPlay={!reduced} muted loop playsInline preload="metadata"
              aria-hidden="true"
              className={styles.mediaVideo}
            />
          )}
          {disabled && (
            <span className={styles.napping}>
              {!quiet && <NappingFace />}
              <span>Sold out</span>
            </span>
          )}
          {tasted && !disabled && (
            <span className={styles.tasted} aria-hidden="true">tasted</span>
          )}
        </div>
        <div className={styles.cardBody}>
          <h3 className={styles.cardTitle}>{item.name}</h3>
          {item.description && <p className={styles.cardDesc}>{item.description}</p>}
          {((item.dietary?.length ?? 0) > 0 || ((item.spiceLevel ?? 0) > 0)) && (
            <div className={styles.badges}>
              {(item.dietary ?? []).map((d) => {
                const b = DIETARY_BADGE[d]
                return (
                  <span key={d} className={styles.badge} style={b ? { background: b.color } : undefined}>
                    {b?.withIcon && <LeafIcon />}
                    {b?.label ?? d}
                  </span>
                )
              })}
              {(item.spiceLevel ?? 0) > 0 && (
                <span aria-label={`Spice level ${Math.min(item.spiceLevel ?? 0, 3)} of 3`}
                  className={styles.badge}
                  style={{ gap: '0.1rem', background: 'rgba(220,38,38,0.12)', color: '#991b1b' }}>
                  {Array.from({ length: Math.min(item.spiceLevel ?? 0, 3) }).map((_, i) => (
                    <FlameIcon key={i} />
                  ))}
                </span>
              )}
            </div>
          )}
          {(item.allergens?.length ?? 0) > 0 && (
            <p className={styles.allergens}>Contains: {(item.allergens ?? []).join(', ')}</p>
          )}
          <div className={styles.priceRow}>
            <span className={styles.price}>{fmt(item.priceCents)}</span>
          </div>
        </div>
      </button>

      {!disabled && (
        <motion.button
          type="button"
          className={styles.quick}
          data-toy="tap"
          aria-label={plusLabel}
          whileTap={{ scale: quiet ? 0.94 : 0.82 }}
          whileHover={fine && !quiet ? { rotate: 90 } : undefined}
          transition={quiet ? { duration: 0.2 } : POP}
          onClick={() => {
            if (!quickable) {
              onOpen()
              return
            }
            onQuickAdd(mediaRef.current?.getBoundingClientRect() ?? null)
          }}
        >
          <PlusIcon />
        </motion.button>
      )}
    </motion.div>
  )
}

// ───── Stepper ──────────────────────────────────────────────────────────────

function StepButton({
  label, atBound, quiet, onPress, children,
}: {
  label: string
  atBound: boolean
  quiet: boolean
  onPress: () => void
  children: ReactNode
}) {
  return (
    <motion.button
      type="button"
      className={styles.stepBtn}
      aria-label={label}
      aria-disabled={atBound ? 'true' : undefined}
      onClick={onPress}
      whileTap="press"
    >
      <motion.span
        className={styles.stepChip}
        variants={{ press: { scale: quiet ? 0.94 : 0.82 } }}
        transition={quiet ? { duration: 0.16 } : POP}
      >
        {children}
      </motion.span>
    </motion.button>
  )
}

/**
 * Chunky stepper: 36px chips on 44px hit areas, a rolling number, and a
 * "no" shake + buzz when a tap would cross a bound.
 */
function Stepper({
  value, canDec, canInc, onDec, onInc, size, tone, reduced, decLabel, incLabel,
}: {
  value: number
  canDec: boolean
  canInc: boolean
  onDec: () => void
  onInc: () => void
  size: 'lg' | 'sm'
  tone: TossTone
  reduced: boolean
  decLabel: string
  incLabel: string
}) {
  const controls = useAnimationControls()
  const quiet = tone === 'simmer'
  const reject = () => {
    buzz(20)
    if (reduced) void controls.start({ opacity: [1, 0.55, 1], transition: { duration: 0.12 } })
    else void controls.start({ x: [0, -6, 5, -3, 0], transition: { duration: 0.28, ease: 'easeOut' } })
  }
  return (
    <motion.div className={styles.stepper} data-size={size} animate={controls} role="group" aria-label="quantity">
      <StepButton label={decLabel} atBound={!canDec} quiet={quiet} onPress={canDec ? onDec : reject}>
        <MinusIcon />
      </StepButton>
      <span className={styles.stepValue}><Odometer value={value} /></span>
      <StepButton label={incLabel} atBound={!canInc} quiet={quiet} onPress={canInc ? onInc : reject}>
        <PlusIcon />
      </StepButton>
    </motion.div>
  )
}

// ───── Item modal ───────────────────────────────────────────────────────────

function ItemDetailModal({
  item, accent, tone, reduced, onClose, onAdd, fmt,
}: {
  item: MenuItem
  accent: string
  tone: TossTone
  reduced: boolean
  fmt: (cents: number) => string
  onClose: () => void
  onAdd: (
    item: MenuItem,
    qty: number,
    modifiers: PickedModifier[],
    finalPriceCents: number,
    notes: string,
    from: DOMRect | null,
  ) => void
}) {
  const [qty, setQty] = useState(1)
  const [notes, setNotes] = useState('')
  const addRef = useRef<HTMLButtonElement>(null)
  const sheetRef = useSheetFocus(onClose)

  // selections[groupId] = Set of selected modifier ids. Seeded with the
  // group's isDefault picks so a "must pick exactly one" group lands on
  // the default the operator marked.
  const [selections, setSelections] = useState<Record<string, Set<string>>>(() => seedSelections(item))

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
  const pickedModifiers = pickedFrom(groups, selections)
  const lineUnitPriceCents = unitPriceCents(item, pickedModifiers)

  const sheet = sheetMotion(tone, reduced)

  return (
    <motion.div
      role="dialog"
      aria-modal="true"
      aria-label={item.name}
      onClick={onClose}
      className={styles.scrim}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={scrimTransition(tone, reduced)}
    >
      <motion.div
        ref={sheetRef}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        className={styles.sheet}
        initial={sheet.initial}
        animate={sheet.animate}
        exit={sheet.exit}
        transition={sheet.transition}
      >
        <div
          className={styles.sheetMedia}
          style={item.imageUrl ? { backgroundImage: `url(${item.imageUrl})` } : { background: `${accent}22` }}
        >
          {item.videoUrl && (
            <video
              src={item.videoUrl}
              {...(item.imageUrl ? { poster: item.imageUrl } : {})}
              autoPlay={!reduced} muted loop playsInline preload="metadata"
              aria-hidden="true"
              className={styles.mediaVideo}
            />
          )}
          <button type="button" onClick={onClose} aria-label="Close" className={styles.sheetClose}>
            <CloseIcon />
          </button>
        </div>

        <div className={styles.sheetBody}>
          <h2 style={{ fontSize: '1.4rem', fontWeight: tone === 'simmer' ? 400 : 800 }}>{item.name}</h2>
          {item.description && (
            <p style={{ color: 'var(--t-mute)', fontSize: '0.95rem', lineHeight: 1.5 }}>{item.description}</p>
          )}
          <p className={styles.price} style={{ fontSize: '1.1rem' }}>{fmt(item.priceCents)}</p>

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
              <fieldset key={g.id} className={styles.fieldset}>
                <legend style={{ padding: '0 0.4rem', display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
                  <span style={{ fontSize: '0.92rem', fontWeight: 700 }}>{g.name}</span>
                  {g.isRequired && <span className={styles.required}>Required</span>}
                </legend>
                <p style={{ fontSize: '0.75rem', color: 'var(--t-mute)', marginBottom: '0.5rem' }}>{caption}</p>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem' }}>
                  {g.modifiers.map((m) => {
                    const checked = picked.has(m.id)
                    const reachedMax = !radio && !checked && picked.size >= g.maxSelect
                    return (
                      <label
                        key={m.id}
                        className={styles.optionRow}
                        data-checked={checked ? 'true' : 'false'}
                        data-disabled={reachedMax ? 'true' : 'false'}
                      >
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.6rem', fontSize: '0.92rem' }}>
                          <input
                            type={radio ? 'radio' : 'checkbox'}
                            name={radio ? g.id : undefined}
                            checked={checked}
                            disabled={reachedMax}
                            onChange={() => togglePick(g, m.id)}
                            style={{ accentColor: 'var(--t-ink)', width: '1.05rem', height: '1.05rem' }}
                          />
                          <span>{m.name}</span>
                        </span>
                        {m.priceDeltaCents !== 0 && (
                          <span style={{ fontSize: '0.85rem', fontWeight: 700, color: 'var(--t-mute)' }}>
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
            <span style={{ fontSize: '0.85rem', fontWeight: 600, color: 'var(--t-mute)' }}>Notes for the kitchen (optional)</span>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={2}
              maxLength={200}
              placeholder="e.g. no onions, extra spicy"
              className={styles.textarea}
            />
          </label>
        </div>

        <div className={styles.sheetFoot}>
          <Stepper
            value={qty}
            canDec={qty > 1}
            canInc={qty < 20}
            onDec={() => setQty(Math.max(1, qty - 1))}
            onInc={() => setQty(Math.min(20, qty + 1))}
            size="lg"
            tone={tone}
            reduced={reduced}
            decLabel="Decrease quantity"
            incLabel="Increase quantity"
          />
          <button
            ref={addRef}
            type="button"
            onClick={() => canAdd && onAdd(item, qty, pickedModifiers, lineUnitPriceCents, notes.trim(), addRef.current?.getBoundingClientRect() ?? null)}
            disabled={!canAdd}
            className={`servd-btn-primary ${styles.addBtn}`}
            style={{ opacity: canAdd ? 1 : 0.5, cursor: canAdd ? 'pointer' : 'not-allowed' }}
          >
            {canAdd
              ? `Add ${qty} · ${fmt(lineUnitPriceCents * qty)}`
              : `Pick ${unmet[0]?.name}`}
          </button>
        </div>
      </motion.div>
    </motion.div>
  )
}

// ───── Basket dock (pill + mini crowd) ──────────────────────────────────────

function pillLabel(tone: TossTone): string {
  switch (tone) {
    case 'stackd': return 'view tray'
    case 'flipd':  return 'View ticket'
    case 'simmer': return 'view basket'
    default:       return 'View basket'
  }
}

function BasketDock({
  slug, tone, fmt, count, subtotalCents, drawerOpen, reduced, showCrowd, onOpen,
}: {
  slug: string
  tone: TossTone
  fmt: (cents: number) => string
  count: number
  subtotalCents: number
  drawerOpen: boolean
  reduced: boolean
  showCrowd: boolean
  onOpen: () => void
}) {
  const controls = useAnimationControls()
  // What the pill shows lags the cart while an item is airborne, so the
  // numbers roll the moment it lands rather than before it's thrown.
  const [shown, setShown] = useState({ count, subtotalCents })
  const latest = useRef({ count, subtotalCents })
  latest.current = { count, subtotalCents }

  useEffect(() => {
    if (tossesInFlight() === 0) setShown({ count, subtotalCents })
  }, [count, subtotalCents])

  useBasketCatch((c) => {
    setShown({ ...latest.current })
    if (reduced || c.instant) {
      void controls.start({ opacity: [1, 0.55, 1], transition: { duration: 0.15 } })
    } else if (tone === 'simmer') {
      void controls.start({ scale: [1, 1.03, 1], transition: { duration: 0.32, ease: [0.22, 1, 0.36, 1] } })
    } else {
      void controls.start({
        scaleX: [1, 1.12, 0.96, 1],
        scaleY: [1, 0.88, 1.04, 1],
        transition: { duration: 0.38, times: [0, 0.3, 0.65, 1], ease: 'easeOut' },
      })
    }
  })

  const label = `View basket — ${count} item${count === 1 ? '' : 's'}, ${fmt(subtotalCents)}`
  const enter = reduced
    ? { initial: { opacity: 0 }, animate: { opacity: drawerOpen ? 0 : 1 }, exit: { opacity: 0 }, transition: { duration: 0.12 } }
    : {
        initial: { opacity: 0, scale: 0.6 },
        animate: drawerOpen ? { opacity: 0, scale: 0.85 } : { opacity: 1, scale: 1 },
        exit: { opacity: 0, scale: 0.6 },
        transition: tone === 'simmer' ? { duration: 0.32, ease: [0.22, 1, 0.36, 1] } : POP,
      }

  return (
    <div className={styles.dock}>
      <motion.div
        className={styles.dockInner}
        initial={enter.initial}
        animate={enter.animate}
        exit={enter.exit}
        transition={enter.transition as Transition}
      >
        {showCrowd && <MiniCrowd slug={slug} hidden={drawerOpen} />}
        <motion.button
          type="button"
          data-basket-pill=""
          className={styles.pill}
          data-hidden={drawerOpen ? 'true' : 'false'}
          aria-label={label}
          aria-hidden={drawerOpen ? true : undefined}
          tabIndex={drawerOpen ? -1 : 0}
          onClick={onOpen}
          animate={controls}
          whileTap={tone === 'simmer' ? { scale: 0.97 } : { scale: 0.93 }}
        >
          <span className={styles.pillBadge}>
            <Odometer value={shown.count} srLabel={null} />
          </span>
          <span className={styles.pillLabel}>{pillLabel(tone)}</span>
          <span className={styles.pillPrice}>
            <Odometer value={fmt(shown.subtotalCents)} srLabel={null} />
          </span>
        </motion.button>
      </motion.div>
    </div>
  )
}

// ───── Cart drawer ──────────────────────────────────────────────────────────

const LINE_EXIT: Transition = { duration: 0.22, ease: [0.4, 0, 0.2, 1] }

function CartDrawer({
  slug, tone, reduced, onClose, onCheckout, fmt,
}: {
  slug: string
  tone: TossTone
  reduced: boolean
  onClose: () => void
  onCheckout: () => void
  fmt: (cents: number) => string
}) {
  // Tax is computed at checkout (payment-method aware), not here.
  // The basket just shows subtotal.
  const cart = useCart()
  const subtotal = cart.subtotalCents()
  const sheetRef = useSheetFocus(onClose)
  const sheet = sheetMotion(tone, reduced)
  const copy = emptyBasketCopy(slug)
  const quiet = tone === 'simmer'

  // Remove → an inline "removed · undo" row for 4s.
  const [removed, setRemoved] = useState<CartItem | null>(null)
  useEffect(() => {
    if (!removed) return
    const t = window.setTimeout(() => setRemoved(null), 4000)
    return () => window.clearTimeout(t)
  }, [removed])

  function removeLine(line: CartItem, viaStepper: boolean) {
    setRemoved({ ...line })
    // The stepper's minimum goes through updateQty (its existing path);
    // the Remove link through removeItem.
    if (viaStepper) cart.updateQty(line.lineId, 0)
    else cart.removeItem(line.lineId)
  }

  function undo() {
    if (!removed) return
    const line = removed
    const already = useCart.getState().items.find((i) => i.lineId === line.lineId)?.quantity ?? 0
    // Same payload shape the menu adds with; the lineId is deterministic
    // (menuItemId + modifier hash), so it lands back on the same line.
    cart.addItem({
      menuItemId: line.menuItemId,
      name: line.name,
      priceCents: line.priceCents,
      ...(line.modifiers && line.modifiers.length > 0 && { modifiers: line.modifiers }),
      ...(line.notes && { notes: line.notes }),
    })
    const target = already + line.quantity
    if (target !== already + 1) cart.updateQty(line.lineId, target)
    setRemoved(null)
  }

  const lineExit = reduced
    ? { opacity: 0, transition: { duration: 0.12 } }
    : { x: 40, opacity: 0, height: 0, transition: LINE_EXIT }

  return (
    <motion.div
      role="dialog"
      aria-modal="true"
      aria-label="Basket"
      onClick={onClose}
      className={styles.scrim}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={scrimTransition(tone, reduced)}
    >
      <motion.div
        ref={sheetRef}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        className={styles.sheet}
        initial={sheet.initial}
        animate={sheet.animate}
        exit={sheet.exit}
        transition={sheet.transition}
      >
        <header className={styles.drawerHead}>
          <h2 className={styles.drawerTitle}>{quiet ? 'your basket' : tone === 'stackd' ? 'your tray' : 'Your basket'}</h2>
          <button type="button" onClick={onClose} aria-label="Close basket" className={styles.sheetClose}>
            <CloseIcon />
          </button>
        </header>

        <div style={{ overflowY: 'auto', flex: 1 }}>
          {cart.items.length === 0 && (
            <div className={styles.empty}>
              <p className={styles.emptyTitle}>{copy.title}</p>
              <p className={styles.emptyBody}>{copy.body}</p>
              <button type="button" className={styles.textBtn} onClick={onClose}>{copy.cta}</button>
            </div>
          )}
          <AnimatePresence initial={false}>
            {cart.items.map((line) => (
              <motion.div
                key={line.lineId}
                className={styles.lineWrap}
                initial={reduced ? { opacity: 0 } : { opacity: 0, height: 0 }}
                animate={reduced ? { opacity: 1 } : { opacity: 1, height: 'auto', x: 0 }}
                exit={lineExit}
                transition={reduced ? { duration: 0.12 } : LINE_EXIT}
              >
                <div className={styles.line}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <p className={styles.lineName}>{line.name}</p>
                    {line.modifiers && line.modifiers.length > 0 && (
                      <p className={styles.lineMeta}>{line.modifiers.map((m) => m.name).join(' · ')}</p>
                    )}
                    <p className={styles.lineMeta}>{fmt(line.priceCents)} each</p>
                    <div style={{ marginTop: '0.35rem', marginLeft: '-4px' }}>
                      <Stepper
                        value={line.quantity}
                        canDec
                        canInc
                        onDec={() => {
                          if (line.quantity <= 1) removeLine(line, true)
                          else cart.updateQty(line.lineId, line.quantity - 1)
                        }}
                        onInc={() => cart.updateQty(line.lineId, line.quantity + 1)}
                        size="sm"
                        tone={tone}
                        reduced={reduced}
                        decLabel={line.quantity <= 1 ? `Remove ${line.name}` : 'Decrease'}
                        incLabel="Increase"
                      />
                    </div>
                  </div>
                  <div className={styles.lineRight}>
                    <p className={styles.lineTotal}><Odometer value={fmt(line.priceCents * line.quantity)} /></p>
                    <button type="button" className={styles.textBtn} onClick={() => removeLine(line, false)}>{quiet ? 'remove' : 'Remove'}</button>
                  </div>
                </div>
              </motion.div>
            ))}
          </AnimatePresence>
          <AnimatePresence>
            {removed && (
              <motion.div
                key="undo"
                className={styles.undo}
                initial={reduced ? { opacity: 0 } : { opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0 }}
                transition={reduced ? { duration: 0.12 } : POP}
              >
                <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  removed {quiet ? removed.name.toLowerCase() : removed.name}
                </span>
                <button type="button" className={styles.undoBtn} onClick={undo} aria-label={`undo removing ${removed.name}`}>
                  undo
                </button>
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        {cart.items.length > 0 && (
          <footer className={styles.drawerFoot}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.3rem', marginBottom: '1rem', fontSize: '0.9rem' }}>
              {/* Tax/GST is computed at checkout once the customer picks
                  a payment method (8% on card-rails, 15% on cash), so
                  the basket only shows subtotal here and notes that tax
                  is added at the next step. */}
              <div className={styles.sumRow}>
                <span style={{ color: 'var(--t-mute)' }}>Subtotal</span>
                <Odometer value={fmt(subtotal)} />
              </div>
              <div className={styles.sumRow} style={{ fontSize: '0.75rem', color: 'var(--t-mute)' }}>
                <span>GST</span>
                <span>added at checkout</span>
              </div>
              <div className={styles.sumTotal}>
                <span>Total before tax</span>
                <Odometer value={fmt(subtotal)} />
              </div>
            </div>
            <MagneticButton onClick={onCheckout} className="servd-btn-primary" style={{ width: '100%', padding: '1rem' }}>
              Checkout · {fmt(subtotal)} + tax
            </MagneticButton>
          </footer>
        )}
      </motion.div>
    </motion.div>
  )
}

// ───── Kitchen napping (menu API down / no menu published) ──────────────────

const NAP_CAST: Record<string, CharacterKind[]> = {
  stackd: ['croissant', 'coffee', 'sandwich'],
  flipd: ['fries', 'burger', 'shake'],
}

function napCopy(slug: string, tone: TossTone, variant: 'unavailable' | 'empty', brandName: string) {
  switch (tone) {
    case 'stackd':
      return {
        title: 'the kitchen’s having a little nap.',
        body: variant === 'empty'
          ? 'the counter hasn’t put its menu online yet. the sandwiches, pastries and the chiller are all there in person, so come and say hello.'
          : 'online ordering is resting for a moment. the sandwiches, pastries and the chiller are all still on the counter, so come and say hello, or save yourself a seat.',
        hint: 'poke them gently. they won’t mind.',
        menu: 'see the menu',
        reserve: 'reserve a table',
        retry: 'try again',
      }
    case 'flipd':
      return {
        title: 'Grill’s off.',
        body: variant === 'empty' ? 'No menu online yet. Back soon.' : 'Online orders are down. Menu’s up. Tables too.',
        hint: 'Poke the crew.',
        menu: 'See the menu',
        reserve: 'Reserve a table',
        retry: 'Try again',
      }
    case 'simmer':
      return {
        title: variant === 'empty' ? 'the menu isn’t online yet.' : 'ordering here isn’t open yet.',
        body: 'the menu is a short walk away, and the tables are open.',
        hint: '',
        menu: 'see the menu',
        reserve: 'reserve a table',
        retry: 'try again',
      }
    default:
      return variant === 'empty'
        ? {
            title: 'No menu yet',
            body: `${brandName || prettifySlug(slug)} hasn’t published a menu. Check back soon.`,
            hint: '', menu: 'See the menu', reserve: 'Reserve a table', retry: 'Try again',
          }
        : {
            title: 'Tableside ordering isn’t live yet.',
            body: 'The kitchen hasn’t published a menu to the order system. Flag down your server and they’ll take the order from the printed card. Reservations are open below.',
            hint: '', menu: 'See the menu', reserve: 'Reserve a table', retry: 'Try again',
          }
  }
}

function KitchenNapping({
  slug, tone, variant, brandName = '', onRetry,
}: {
  slug: string
  tone: TossTone
  variant: 'unavailable' | 'empty'
  brandName?: string
  onRetry?: () => void
}) {
  const copy = napCopy(slug, tone, variant, brandName)
  const cast = NAP_CAST[tone] ?? null
  const Title = variant === 'unavailable' ? 'h1' : 'h2'
  return (
    <div className={styles.nap} style={variant === 'empty' ? { minHeight: '60dvh', paddingTop: '3rem' } : undefined}>
      <div className={styles.napInner}>
        {cast && (
          <div className={styles.napStage}>
            <div className={styles.napCrowd}>
              <FoodCrowd cast={cast} excitement={0} />
            </div>
            <svg className={styles.napZ} viewBox="0 0 72 64" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M8 44h12L8 56h12" />
              <path d="M30 26h15L30 41h15" />
              <path d="M54 6h12L54 18h12" />
            </svg>
          </div>
        )}
        {copy.hint && <p className={styles.napHint} aria-hidden="true">{copy.hint}</p>}
        <Title className={styles.napTitle}>{copy.title}</Title>
        <p className={styles.napBody}>{copy.body}</p>
        <div className={styles.napActions}>
          <MagneticLink href={`/brand/${slug}/menu`} className={styles.napBtn}>{copy.menu}</MagneticLink>
          <MagneticLink href={`/reserve/${slug}`} className={`${styles.napBtn} ${styles.napBtnGhost}`}>{copy.reserve}</MagneticLink>
        </div>
        {onRetry && (
          <button type="button" className={styles.textBtn} onClick={onRetry}>{copy.retry}</button>
        )}
      </div>
    </div>
  )
}
