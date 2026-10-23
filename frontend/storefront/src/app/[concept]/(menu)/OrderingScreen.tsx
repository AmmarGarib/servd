'use client'

// Per-brand ordering page. Replaces the previous 1400-line monolith with a
// focused ordering UX:
//   • brand-keyed hero (image + name + tagline)
//   • sticky category nav (jumps within the page)
//   • menu grid with card-per-item
//   • floating cart drawer with checkout CTA
//   • item customisation modal for items with modifier groups
//
// Rendered by page.tsx (a server component), which resolves the brand first
// and passes it in as `initialConcept`, so the hero and its h1 are in the
// server HTML. page.tsx also reads the menu on the server and passes it as
// `initialMenu`, so the dishes, prices and sections are in the first HTML
// (search engines and AI tools read that). The screen still fetches the menu
// here after mount, from the public storefront API: /storefront/:slug/menu
// (and /storefront/concepts only when the server couldn't vouch for the
// slug) — that refresh keeps availability current, and is the only source
// when the server's read failed (initialMenu null → the skeleton, as before).
//
// The basket is one kitchen's at a time (store/cart.ts, localStorage
// 'servd-cart'). Opening another kitchen's menu never touches it: only when
// the customer adds an item here while it holds another kitchen's items do we
// ask — keep that basket, or start a new one for this kitchen.

import { Fragment, useCallback, useEffect, useId, useRef, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import Link from 'next/link'
import { MagneticButton, MagneticLink } from '@/components/ui/MagneticButton'
import { Skeleton } from '@/components/Status'
import { useCart } from '../../../store/cart'
import { TestCompanyStripe, isTestConcept } from '../../../components/TestCompanyStripe'
import { conceptHeroImage, heroCover, formatBrandName } from '../../../lib/concept'
import { tintColor } from '../../../lib/brandKit'
import { useBrandSlug, getServdHost } from '../../../lib/host'
import { encodeCartToken } from '../../../lib/cartHandoff'
import { brandCanonical, SERVD_LINK_ORIGIN } from '../../../lib/brandDomains'
// How a brand takes web orders (lib/fulfilment.ts — the list checkout uses
// too). A brand whose only option is dine-in can't take an order from anyone
// who isn't seated: checkout would ask for a table number and stop.
import { takesTableOrdersOnly } from '../../../lib/fulfilment'
// GA4 events (no-op without GA4 / consent) — the shared contract in lib/analytics.
import { track } from '../../../lib/analytics'
import { useDialog } from '../../../lib/useDialog'
import { smoothScrollTo, prefersReducedMotion } from '../../../lib/scroll'

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
// /storefront/concepts sends no taxRate (tax is priced at checkout); the
// field stays optional so the server's record and the placeholder both fit.
interface Concept    {
  id: string; name: string; slug: string; type: string
  description: string | null; logoUrl: string | null; primaryColor: string | null; taxRate?: number
  phone?: string | null; address?: string | null
  latitude?: number | null; longitude?: number | null
  /** false = the brand takes no bookings (hide "Book a table"). Missing = takes them. */
  reservationsEnabled?: boolean
}

/** The brand as the server resolved it — only what the hero needs, all
 *  serialisable. null when the API didn't answer and the slug isn't a bundled
 *  brand: the page then shows the slug as the name until the client lookup. */
export type OrderingConcept = Pick<Concept, 'id' | 'slug' | 'name' | 'description' | 'primaryColor' | 'type' | 'logoUrl' | 'reservationsEnabled'> & { isTestCompany?: boolean }

/** The menu as the server read it (orderingData.ts) — the same shape the
 *  screen keeps after its own fetch. Serialisable. */
export interface OrderingMenu {
  categories:    Category[]
  ordering:      { open: boolean; opensAt: string | null; message: string | null } | null
  isTestCompany: boolean
}

// ─── Table (dine-in) context ────────────────────────────────────────────────
// The customer is seated at this brand's table: the menu URL carried
// ?table=<label> (a table QR can add it), or they tapped "I'm at a table".
// Remembered for the tab's session, per brand, under `servd:at-table:<slug>`
// (value: the table label from the URL, '' when they only told us they're
// seated) so checkout can prefill the label. Browser storage can be blocked,
// so every access is guarded and the page works without it.
const tableKey = (slug: string) => `servd:at-table:${slug}`

function readAtTable(slug: string): boolean {
  try {
    const label = new URLSearchParams(window.location.search).get('table')?.trim()
    if (label) {
      try { sessionStorage.setItem(tableKey(slug), label.slice(0, 20)) } catch { /* storage blocked */ }
      return true
    }
    return sessionStorage.getItem(tableKey(slug)) !== null
  } catch {
    return false
  }
}

function rememberAtTable(slug: string): void {
  try {
    if (sessionStorage.getItem(tableKey(slug)) === null) sessionStorage.setItem(tableKey(slug), '')
  } catch { /* storage blocked — the state still carries it for this visit */ }
}

/** A line the customer asked to add, held while we ask them something first. */
interface AddRequest {
  item: MenuItem
  qty: number
  modifiers: { modifierId: string; name: string; priceDeltaCents: number }[]
  unitPriceCents: number
  notes: string
}


// The slug → placeholder concept, for when no lookup knows the brand.
function placeholderConcept(slug: string): Concept {
  return {
    id: slug, slug, name: prettifySlug(slug), type: 'restaurant',
    description: null, logoUrl: null, primaryColor: null, taxRate: 0,
  }
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

/** Display name for a brand we only know by slug (the kitchen a saved basket
 *  belongs to): 'stackd' → 'Stackd', 'garnish-station' → 'Garnish Station'. */
function brandNameForSlug(slug: string): string {
  return formatBrandName(prettifySlug(slug))
}

export default function OrderingScreen({ initialConcept, initialMenu = null, verified = false }: {
  initialConcept: OrderingConcept | null
  /** The menu the server read, so it is in the first HTML. null = the
   *  server's read failed: the skeleton shows until the client fetch. */
  initialMenu?: OrderingMenu | null
  /** The server's record is the live one (not the bundled fallback). */
  verified?: boolean
}) {
  const { concept: slug } = useParams<{ concept: string }>()
  const router = useRouter()

  const [loadedConcept, setConcept] = useState<Concept | null>(initialConcept)
  const [categories, setCategories] = useState<Category[] | null>(initialMenu?.categories ?? null)
  // The menu payload's concept carries isTestCompany (test brands order by URL only).
  const [isTestBrand, setIsTestBrand] = useState(() => isTestConcept(initialConcept) || initialMenu?.isTestCompany === true)
  const [error, setError] = useState<string | null>(null)
  // Whether the brand takes orders right now (menu.ordering, ONL-14): when it
  // is closed, checkout answers 409 BRAND_CLOSED, so the menu says so first.
  const [ordering, setOrdering] = useState<{ open: boolean; opensAt: string | null; message: string | null } | null>(initialMenu?.ordering ?? null)
  const [activeCategory, setActiveCategory] = useState<string | null>(initialMenu?.categories[0]?.id ?? null)
  const [openItem, setOpenItem] = useState<MenuItem | null>(null)
  const [cartOpen, setCartOpen] = useState(false)
  // Bumped by Retry on the error screen to fetch the menu again.
  const [attempt, setAttempt] = useState(0)
  // Seated at this brand's table (see readAtTable). Read after mount — the
  // server HTML has no URL query or session storage to go on.
  const [atTable, setAtTable] = useState(false)
  // False on the server and the first client render. The basket (localStorage)
  // and the table flag (sessionStorage) only exist in the browser, so anything
  // drawn from them waits for this — the server-rendered menu must hydrate
  // without a mismatch.
  const [mounted, setMounted] = useState(false)
  useEffect(() => { setMounted(true) }, [])
  // A menu is on screen (server-rendered or fetched): a failed refresh keeps
  // it instead of swapping it for the error page.
  const hasMenuRef = useRef(initialMenu !== null)
  // An add waiting on the customer: 'switch' = the basket holds another
  // kitchen's items; 'table' = this brand only takes orders at the table.
  const [pendingAdd, setPendingAdd] = useState<{ reason: 'switch' | 'table'; request: AddRequest } | null>(null)

  const cart = useCart()
  const brandSlug = useBrandSlug()

  useEffect(() => { setAtTable(readAtTable(slug)) }, [slug])

  // Fetch the menu (and the concept, when the server couldn't resolve it).
  // Resilient against either API hiccupping: if the /concepts fetch fails
  // (Neon cold-start, transient 5xx, rate limit) we derive a minimal
  // placeholder concept from the slug so the menu still renders. Only show
  // the error page when the *menu* itself is unavailable — that's the one we
  // can't fake. A server-resolved concept is kept as is, so the hero the
  // server painted doesn't change under the customer when the menu arrives.
  useEffect(() => {
    let cancelled = false
    async function load() {
      try {
        const [conceptsRes, menuRes] = await Promise.all([
          verified ? null : fetch(`${API_URL}/api/v1/storefront/concepts`).catch(() => null),
          fetch(`${API_URL}/api/v1/storefront/${slug}/menu`),
        ])

        // Try to enrich with real concept data; otherwise build a placeholder
        // from the slug so the page still renders with brand colour/name.
        // Resolved before the menu check, so the error state names the brand
        // too.
        let resolved: Concept = initialConcept ?? placeholderConcept(slug)
        if (conceptsRes && conceptsRes.ok) {
          const all = await conceptsRes.json().catch(() => null) as Concept[] | null
          resolved = (Array.isArray(all) ? all.find((x) => x.slug === slug) : undefined) ?? resolved
        }
        if (!cancelled) setConcept(resolved)

        if (!menuRes.ok) {
          throw new Error(menuRes.status === 404 ? 'Brand not found' : `Menu API returned ${menuRes.status}`)
        }
        // Backend returns { concept, categories } — pull the array out.
        const menuPayload = await menuRes.json() as {
          concept?: Concept; categories: Category[]
          ordering?: { open: boolean; opensAt: string | null; message: string | null }
        } | Category[]
        const cats: Category[] = Array.isArray(menuPayload) ? menuPayload : (menuPayload.categories ?? [])

        if (cancelled) return
        setOrdering(Array.isArray(menuPayload) ? null : (menuPayload.ordering ?? null))
        if (!Array.isArray(menuPayload) && isTestConcept(menuPayload.concept)) setIsTestBrand(true)
        setCategories(cats)
        hasMenuRef.current = true
        // A refresh keeps the section the customer is reading.
        setActiveCategory((prev) => (prev && cats.some((c) => c.id === prev) ? prev : cats[0]?.id ?? null))
        // The basket is left alone here, even when it holds another
        // kitchen's items — addToBasket asks before replacing it.
      } catch (e) {
        // Only when there is no menu to show: the server-rendered one stays
        // usable (checkout re-checks availability and prices anyway).
        if (!cancelled && !hasMenuRef.current) setError((e as Error).message)
      }
    }
    void load()
    return () => { cancelled = true }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug, attempt])

  function retry() {
    setError(null)
    hasMenuRef.current = false
    setCategories(null)
    setAttempt((n) => n + 1)
  }

  const tableOnly = takesTableOrdersOnly(slug)

  function markAtTable() {
    rememberAtTable(slug)
    setAtTable(true)
  }

  // Every add goes through here. `seated` skips the table check (the customer
  // just told us); `fresh` starts a new basket for this kitchen (they chose
  // "Start new"). Reads the store directly so a decision made in the same
  // tick sees the basket as it is now.
  function addToBasket(request: AddRequest, opts: { seated?: boolean; fresh?: boolean } = {}) {
    if (tableOnly && !atTable && !opts.seated) {
      setPendingAdd({ reason: 'table', request })
      return
    }
    const store = useCart.getState()
    const otherKitchen = store.items.length > 0 && store.conceptSlug !== null && store.conceptSlug !== slug
    if (otherKitchen && !opts.fresh) {
      setPendingAdd({ reason: 'switch', request })
      return
    }
    // A new basket (or an empty one left by another kitchen) gets a fresh
    // cart id, as it always has when the kitchen changes.
    if (opts.fresh || (store.items.length === 0 && store.conceptSlug !== slug)) store.clearCart()
    useCart.getState().setConceptSlug(slug)
    for (let i = 0; i < request.qty; i++) {
      useCart.getState().addItem({
        menuItemId: request.item.id,
        name: request.item.name,
        priceCents: request.unitPriceCents,
        ...(request.modifiers.length > 0 && { modifiers: request.modifiers }),
        ...(request.notes && { notes: request.notes }),
      })
    }
    track('add_to_cart', {
      currency:  'PKR',
      value:     (request.unitPriceCents * request.qty) / 100,
      item_id:   request.item.id,
      item_name: request.item.name,
      item_brand: slug,
      price:     request.unitPriceCents / 100,
      quantity:  request.qty,
    })
    setPendingAdd(null)
    setOpenItem(null)
    setCartOpen(true)
  }

  // The customer opened a dish (its detail sheet).
  function openDish(item: MenuItem) {
    track('view_item', {
      currency:  'PKR',
      value:     item.priceCents / 100,
      item_id:   item.id,
      item_name: item.name,
      item_brand: slug,
      price:     item.priceCents / 100,
    })
    setOpenItem(item)
  }

  // The customer kept what they had (or backed out): drop the pending add.
  function dismissPendingAdd() {
    setPendingAdd(null)
    setOpenItem(null)
  }

  // Sticky header = the 60px site bar + the category nav. Measured, so the
  // scroll-spy band and every section's scroll-margin follow the real height
  // (the nav grows on touch screens, where chips are 44px tall).
  const navRef = useRef<HTMLElement>(null)
  const chipsRef = useRef<HTMLDivElement>(null)
  const [stickyH, setStickyH] = useState(120)
  const [chipFade, setChipFade] = useState(false)
  // Set by a chip tap: the observer ignores the sections it passes on the way.
  const spyPausedUntil = useRef(0)
  const hasCategories = (categories?.length ?? 0) > 0
  useEffect(() => {
    const nav = navRef.current
    if (!nav) return
    const measure = () => {
      const top = parseFloat(getComputedStyle(nav).top) || 60
      setStickyH(Math.round(top + nav.getBoundingClientRect().height))
      const bar = chipsRef.current
      if (bar) setChipFade(bar.scrollLeft + bar.clientWidth < bar.scrollWidth - 4)
    }
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(measure)
    ro.observe(nav)
    return () => ro.disconnect()
  }, [hasCategories])

  // Track the active category as the user scrolls: an IntersectionObserver on
  // the sections (no scroll listener, no layout reads per frame). The "reading
  // band" runs from just under the sticky header to 45% down the viewport; the
  // active category is the last one touching it.
  useEffect(() => {
    if (!categories || typeof IntersectionObserver === 'undefined') return
    const order = categories.map((c) => c.id)
    const inBand = new Set<string>()
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        const id = e.target.id.replace(/^cat-/, '')
        if (e.isIntersecting) inBand.add(id); else inBand.delete(id)
      }
      if (Date.now() < spyPausedUntil.current) return
      let current: string | null = null
      for (const id of order) if (inBand.has(id)) current = id
      if (current) setActiveCategory(current)
    }, { rootMargin: `-${stickyH + 4}px 0px -55% 0px`, threshold: 0 })
    for (const c of categories) {
      const el = document.getElementById(`cat-${c.id}`)
      if (el) io.observe(el)
    }
    return () => io.disconnect()
  }, [categories, stickyH])

  // Keep the highlighted chip on screen inside the horizontal chip bar.
  useEffect(() => {
    const bar = chipsRef.current
    if (!bar || !activeCategory) return
    const chip = bar.querySelector<HTMLElement>(`[data-chip="${activeCategory}"]`)
    if (!chip) return
    const left = chip.offsetLeft - (bar.clientWidth - chip.offsetWidth) / 2
    bar.scrollTo({ left: Math.max(0, left), behavior: prefersReducedMotion() ? 'auto' : 'smooth' })
  }, [activeCategory])

  const onChipsScroll = useCallback(() => {
    const bar = chipsRef.current
    if (bar) setChipFade(bar.scrollLeft + bar.clientWidth < bar.scrollWidth - 4)
  }, [])

  // The states below (error / skeleton / menu) carry distinct keys so React
  // mounts each fresh instead of morphing the skeleton's DOM into the next
  // state — that morph was the page's one layout shift (CLS 0.20). The hero
  // is the exception: loading and menu share it (and the page's h1), so it is
  // in the server HTML and stays mounted when the menu arrives; only what
  // sits below it swaps.
  if (error) {
    // Most failures are the API blinking, so the way forward is Retry. Only a
    // customer seated at the brand's table has a server to turn to.
    return (
      <div key="error" className="min-h-dvh flex items-center justify-center p-6 text-center">
        <div style={{ maxWidth: '28rem' }}>
          <h1 className="text-sm font-semibold text-s-muted mb-1">
            {formatBrandName((loadedConcept ?? placeholderConcept(slug)).name)}
          </h1>
          <h2 className="text-2xl font-bold mb-2">We couldn&rsquo;t load the menu.</h2>
          <p className="text-s-muted text-sm mb-4">
            {atTable
              ? <>Please try again. If it still won&rsquo;t load, flag down your server &mdash; they&rsquo;ll take your order from the printed menu.</>
              : 'Please try again.'}
          </p>
          <MagneticButton type="button" onClick={retry} className="servd-btn-rect servd-btn-primary" style={{ minHeight: '2.75rem' }}>
            Retry
          </MagneticButton>
        </div>
      </div>
    )
  }

  // Until the menu arrives the hero shows the server's concept, or — when the
  // server couldn't vouch for the slug — a placeholder named from the slug.
  const concept = loadedConcept ?? placeholderConcept(slug)
  const accent = concept.primaryColor ?? 'var(--servd-green-dark)'
  const itemTotal = cart.itemCount()
  // Only once mounted and the menu is in: the cart lives in the browser, so
  // the server HTML (the menu or the skeleton) must not depend on it.
  const hasItems = mounted && categories !== null && itemTotal > 0
  const fmt = fmtFor(slug)
  const brandName = formatBrandName(concept.name)
  // The kitchen the basket belongs to — another one's when the customer kept
  // a basket from there; checkout goes to that kitchen.
  const basketSlug = cart.conceptSlug ?? slug
  const basketBrand = basketSlug !== slug ? brandNameForSlug(basketSlug) : null
  const takesBookings = concept.reservationsEnabled !== false
  // Booking is a servd page — absolute, so a brand-domain copy of this
  // screen doesn't link to a brand-domain copy of it.
  const reserveHref = `${SERVD_LINK_ORIGIN}/reserve/${concept.slug}`

  // Per-brand skin — same class system as /[concept]/checkout. Wraps the
  // ordering surface in the brand's design language (token remap + a few
  // targeted overrides in globals.css) so the menu / item modal / cart
  // drawer feel like the brand the customer just walked into, not the
  // generic servd treatment. The skeleton wears it too, so the hero and the
  // page colour don't change when the menu arrives.
  const brandSkinClass =
    slug === 'simmer' ? 'simmer-ordering' :
    slug === 'stackd'   ? 'stackd-ordering'   :
    slug === 'flipd'  ? 'flipd-ordering'  :
    ''

  return (
    <div key="screen" className={brandSkinClass}
      style={{ background: 'var(--servd-order-bg)', minHeight: '100dvh', paddingBottom: hasItems ? '7rem' : '0' }}>
      <style>{`
        .sv-oc-chip, .sv-oc-link { display: inline-flex; align-items: center; }
        /* Stackd forces cream headings (!important) for its dark page; the
           cream sheet needs its own ink back. */
        .stackd-ordering .sv-sheet-panel h1, .stackd-ordering .sv-sheet-panel h2, .stackd-ordering .sv-sheet-panel h3 {
          color: var(--servd-sheet-ink) !important;
        }
        @media (pointer: coarse) {
          .sv-oc-chip, .sv-oc-link { min-height: 44px; }
          .sv-oc-add { min-height: 44px; }
        }
      `}</style>
      <TestCompanyStripe show={isTestBrand} />
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
            {/* The brand's microsite is its own domain; the kitchens list
                is servd's (absolute, for the brand-domain copy). */}
            <Link href={brandCanonical(concept.slug)} className="sv-oc-link" style={{ color: 'rgba(255,255,255,0.85)', textDecoration: 'none', fontSize: '0.85rem' }}>
              ← {formatBrandName(concept.name)}
            </Link>
            <Link href={`${SERVD_LINK_ORIGIN}/home#kitchens`} className="sv-oc-link" style={{ color: 'rgba(255,255,255,0.85)', textDecoration: 'none', fontSize: '0.85rem' }}>
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

      {categories === null ? (
        // Menu skeleton — the category nav strip + 5 item rows of the real
        // page, shimmer-tinted, under the real hero. Reserves the layout so
        // the menu doesn't push content around when it arrives (avoids CLS).
        <div key="skeleton" role="status" aria-label="Loading menu">
          <div style={{ padding: '1rem 1rem 0', display: 'flex', gap: '0.5rem', overflowX: 'hidden' }}>
            {Array.from({ length: 4 }).map((_, i) => (
              <span key={i} style={{ flex: 'none' }}><Skeleton width="4.5rem" height="2rem" radius="999px" /></span>
            ))}
          </div>
          <div style={{ padding: '1.25rem', display: 'grid', gap: '0.85rem' }}>
            {Array.from({ length: 5 }).map((_, i) => (
              // Painted like the ItemCard it stands in for (white card, the
              // line token as its border), so nothing flips colour when the
              // menu arrives under a brand skin.
              <div key={i} style={{
                display: 'grid', gridTemplateColumns: '1fr 5rem', gap: '0.75rem',
                padding: '0.85rem', borderRadius: '0.85rem',
                background: 'var(--servd-order-card)', border: '1px solid var(--servd-line)',
              }}>
                <div style={{ display: 'grid', gap: '0.4rem', alignContent: 'start' }}>
                  <Skeleton height="0.95rem" width="60%" radius="4px" />
                  <Skeleton height="0.75rem" width="90%" radius="4px" />
                </div>
                <Skeleton height="4rem" radius="0.6rem" />
              </div>
            ))}
          </div>
          <span className="sr-only">Loading menu…</span>
        </div>
      ) : (
        <Fragment key="menu">
          {/* Closed right now: say when it opens, before a basket is built
              that checkout would refuse. Pre-orders for an open time still go
              through at checkout. */}
          {ordering && !ordering.open && categories.length > 0 && (
            <section
              role="status"
              aria-live="polite"
              style={{
                background: 'var(--servd-surface)',
                color: 'var(--servd-ink)',
                borderBottom: '1px solid var(--servd-line)',
              }}
            >
              <div className="container" style={{ paddingTop: '1rem', paddingBottom: '1rem', display: 'flex', gap: '0.75rem', alignItems: 'flex-start' }}>
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
                  strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flex: 'none', marginTop: '0.15rem' }}>
                  <circle cx="12" cy="12" r="10" />
                  <polyline points="12 6 12 12 16 14" />
                </svg>
                <p style={{ fontSize: '0.95rem', fontWeight: 700, lineHeight: 1.45 }}>
                  {ordering.message ?? `${brandName} is closed right now.`}
                </p>
              </div>
            </section>
          )}
          {/* A brand that only takes orders at the table says so up front,
              instead of letting a customer at home fill a basket checkout
              can't take. Seated customers say so and carry on. */}
          {tableOnly && mounted && !atTable && categories.length > 0 && (
            <section
              aria-labelledby="table-only-title"
              style={{
                background: 'var(--servd-surface)',
                color: 'var(--servd-ink)',
                borderBottom: '1px solid var(--servd-line)',
              }}
            >
              <div className="container" style={{ paddingTop: '1.25rem', paddingBottom: '1.25rem', display: 'grid', gap: '0.85rem' }}>
                <div style={{ display: 'grid', gap: '0.3rem' }}>
                  <h2 id="table-only-title" style={{ fontSize: '1.1rem', fontWeight: 800, lineHeight: 1.3 }}>
                    {brandName} takes orders at the table.
                  </h2>
                  <p style={{ color: 'var(--servd-mute)', fontSize: '0.92rem', lineHeight: 1.5, maxWidth: '40rem' }}>
                    There&rsquo;s no pickup or delivery from {brandName}.{' '}
                    {takesBookings
                      ? 'Book a table, then order from your phone once you’re seated.'
                      : 'Order from your phone once you’re seated.'}
                  </p>
                </div>
                <div style={{ display: 'flex', gap: '0.6rem', flexWrap: 'wrap' }}>
                  {takesBookings && (
                    <MagneticLink href={reserveHref} className="servd-btn-rect servd-btn-primary" style={{ minHeight: '2.75rem' }}>
                      Book a table
                    </MagneticLink>
                  )}
                  <button type="button" onClick={markAtTable} style={{ ...OUTLINE_BTN, flex: 'none' }}>
                    I&rsquo;m at a table
                  </button>
                </div>
              </div>
            </section>
          )}

          {/* Sticky category nav */}
          {categories.length > 0 && (
            <nav
              ref={navRef}
              aria-label="Menu sections"
              style={{
                position: 'sticky',
                top: '60px',
                zIndex: 30,
                background: 'var(--servd-order-nav-bg)',
                backdropFilter: 'blur(14px)',
                WebkitBackdropFilter: 'blur(14px)',
                borderBottom: '1px solid var(--servd-line)',
              }}
            >
              {/* The scroller sits inside the nav so the right-edge fade masks
                  only the chips, not the nav's own background and border. */}
              <div
                ref={chipsRef}
                onScroll={onChipsScroll}
                className="no-scrollbar"
                style={{
                  display: 'flex',
                  gap: '0.25rem',
                  overflowX: 'auto',
                  overscrollBehaviorX: 'contain',
                  padding: '0.5rem clamp(1rem, 4vw, 2rem)',
                  ...(chipFade && {
                    WebkitMaskImage: 'linear-gradient(to right, #000 calc(100% - 2rem), transparent)',
                    maskImage: 'linear-gradient(to right, #000 calc(100% - 2rem), transparent)',
                  }),
                }}
              >
                {categories.map((c) => {
                  const active = activeCategory === c.id
                  return (
                    <a
                      key={c.id}
                      href={`#cat-${c.id}`}
                      data-chip={c.id}
                      aria-current={active ? 'true' : undefined}
                      className="sv-oc-chip"
                      onClick={(e) => {
                        e.preventDefault()
                        spyPausedUntil.current = Date.now() + 900
                        smoothScrollTo(document.getElementById(`cat-${c.id}`))
                        setActiveCategory(c.id)
                      }}
                      style={{
                        whiteSpace: 'nowrap',
                        padding: '0.45rem 0.95rem',
                        fontWeight: active ? 800 : 500,
                        fontSize: '0.875rem',
                        color: active ? 'var(--servd-order-chip-ink)' : 'var(--servd-mute)',
                        textDecoration: 'none',
                        borderRadius: 'var(--servd-btn-radius)',
                        background: active ? 'var(--servd-order-chip-bg)' : 'transparent',
                      }}
                    >
                      {c.name}
                    </a>
                  )
                })}
              </div>
            </nav>
          )}

          {/* Menu */}
          {/* Top/bottom only: .container's side padding is the page gutter. */}
          <div className="container" style={{ paddingTop: 'clamp(2rem, 4vw, 3rem)', paddingBottom: 'clamp(2rem, 4vw, 3rem)', display: 'grid', gap: '2.5rem' }}>
            {categories.length === 0 && (
              <div className="text-center py-12">
                <h3 className="text-lg font-semibold mb-2">No menu yet</h3>
                <p className="text-s-muted">{formatBrandName(concept.name)} hasn&rsquo;t published a menu. Check back soon.</p>
              </div>
            )}

            {categories.map((cat) => (
              <section key={cat.id} id={`cat-${cat.id}`} style={{ scrollMarginTop: `${stickyH + 8}px` }}>
                <h2 style={{ fontSize: 'clamp(1.4rem, 3vw, 1.85rem)', marginBottom: '1.25rem' }}>{cat.name}</h2>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 260px), 1fr))', gap: '1rem' }}>
                  {cat.items.map((item) => <ItemCard key={item.id} item={item} onClick={() => openDish(item)} accent={accent} fmt={fmt} />)}
                </div>
              </section>
            ))}
          </div>

          {/* Item modal */}
          {openItem && !pendingAdd && (
            <ItemDetailModal
              item={openItem}
              conceptSlug={concept.slug}
              accent={accent}
              fmt={fmt}
              onClose={() => setOpenItem(null)}
              onAdd={(item, qty, modifiers, finalPriceCents, notes) => {
                addToBasket({ item, qty, modifiers, unitPriceCents: finalPriceCents, notes })
              }}
            />
          )}

          {/* The basket holds another kitchen's items: ask before replacing
              it. Keep = leave it as it is (this item isn't added). */}
          {pendingAdd?.reason === 'switch' && (
            <ChoiceSheet
              stackd={slug === 'stackd'}
              title="Start a new basket?"
              body={<>Your basket has items from {basketBrand ?? 'another kitchen'}. Start a new basket for {brandName}?</>}
              onDismiss={dismissPendingAdd}
            >
              <button type="button" data-autofocus onClick={dismissPendingAdd} style={OUTLINE_BTN}>
                Keep
              </button>
              <MagneticButton type="button" className="servd-btn-rect servd-btn-primary" style={{ flex: 1, minHeight: '2.75rem' }}
                onClick={() => addToBasket(pendingAdd.request, { seated: true, fresh: true })}>
                Start new
              </MagneticButton>
            </ChoiceSheet>
          )}

          {/* Table-only brand, customer hasn't said they're seated. */}
          {pendingAdd?.reason === 'table' && (
            <ChoiceSheet
              stackd={slug === 'stackd'}
              title={`${brandName} takes orders at the table`}
              body={<>There&rsquo;s no pickup or delivery from {brandName}. If you&rsquo;re seated now, carry on &mdash; you&rsquo;ll add your table number at checkout.</>}
              onDismiss={dismissPendingAdd}
            >
              {takesBookings && (
                <a href={reserveHref} style={OUTLINE_BTN}>Book a table</a>
              )}
              <MagneticButton type="button" data-autofocus className="servd-btn-rect servd-btn-primary" style={{ flex: 1, minHeight: '2.75rem' }}
                onClick={() => { markAtTable(); addToBasket(pendingAdd.request, { seated: true }) }}>
                I&rsquo;m at a table
              </MagneticButton>
            </ChoiceSheet>
          )}

          {/* Cart drawer */}
          {mounted && (itemTotal > 0 || cartOpen) && (
            <CartDrawer
              stackd={slug === 'stackd'}
              open={cartOpen}
              onOpen={() => setCartOpen(true)}
              onClose={() => setCartOpen(false)}
              basketBrand={basketBrand}
              fmt={fmtFor(basketSlug)}
              onCheckout={() => {
                // Checkout is the basket's kitchen — another one's when the
                // customer kept a basket from there.
                //
                // On a brand custom domain (stackd.pk, stackd.localhost:3002…),
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
                  window.location.href = `${servdHost}/${basketSlug}/checkout?cart=${encodeURIComponent(token)}`
                  return
                }
                router.push(`/${basketSlug}/checkout`)
              }}
            />
          )}
        </Fragment>
      )}
    </div>
  )
}

// ───── Components ───────────────────────────────────────────────────────────

// Secondary action next to a servd-btn-primary: outlined in the text colour,
// so it reads on any brand skin. 44px tall — a comfortable tap target.
const OUTLINE_BTN: React.CSSProperties = {
  flex: 1,
  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
  minHeight: '2.75rem', padding: '0.7rem 1.25rem',
  borderRadius: 'var(--servd-btn-radius)', border: '1.5px solid currentColor',
  background: 'transparent', color: 'inherit',
  fontWeight: 700, fontSize: '0.95rem', textDecoration: 'none', cursor: 'pointer',
}

// Dietary / spice badges and the allergen line — shared by both card shapes.
function ItemTags({ item }: { item: MenuItem }) {
  return (
    <>
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
    </>
  )
}

const SOLD_OUT_TAG: React.CSSProperties = {
  background: 'rgba(0,0,0,0.7)', color: 'white',
  fontSize: '0.7rem', fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase',
  padding: '0.2rem 0.55rem', borderRadius: '999px',
}

function ItemCard({ item, onClick, accent, fmt }: { item: MenuItem; onClick: () => void; accent: string; fmt: (cents: number) => string }) {
  const disabled = !item.isAvailable
  const frame: React.CSSProperties = {
    textAlign: 'left',
    background: 'var(--servd-order-card)',
    border: '1px solid var(--servd-line)',
    borderRadius: '0.85rem',
    padding: 0,
    cursor: disabled ? 'not-allowed' : 'pointer',
    opacity: disabled ? 0.55 : 1,
    overflow: 'hidden',
    transition: 'transform 180ms cubic-bezier(0.22,1,0.36,1), box-shadow 180ms',
  }
  const hover = {
    onMouseEnter: (e: React.MouseEvent<HTMLButtonElement>) => { if (!disabled) e.currentTarget.style.transform = 'translateY(-2px)'; if (!disabled) e.currentTarget.style.boxShadow = '0 8px 24px rgba(0,0,0,0.08)' },
    onMouseLeave: (e: React.MouseEvent<HTMLButtonElement>) => { e.currentTarget.style.transform = 'translateY(0)'; e.currentTarget.style.boxShadow = 'none' },
  }
  const label = `${item.name} — ${fmt(item.priceCents)}${disabled ? ' — sold out' : ''}`

  // No photo or video: a compact text card — name, description, price, Add —
  // instead of an empty 4:3 picture box. In a row beside photo cards it
  // stretches to their height with the price row at the foot.
  if (!item.imageUrl && !item.videoUrl) {
    return (
      <button
        type="button"
        onClick={() => !disabled && onClick()}
        disabled={disabled}
        style={{ ...frame, padding: '0.95rem 1rem', display: 'flex', flexDirection: 'column', gap: '0.4rem' }}
        {...hover}
        aria-label={label}
      >
        <h3 style={{ fontSize: '1rem', fontWeight: 700, lineHeight: 1.3 }}>{item.name}</h3>
        {item.description && (
          <p style={{ color: 'var(--servd-mute)', fontSize: '0.85rem', lineHeight: 1.4, display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
            {item.description}
          </p>
        )}
        <ItemTags item={item} />
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.75rem', marginTop: 'auto', paddingTop: '0.4rem' }}>
          <span style={{ fontWeight: 800, color: 'var(--servd-green-dark)' }}>{fmt(item.priceCents)}</span>
          {disabled ? (
            <span style={SOLD_OUT_TAG}>Sold out</span>
          ) : (
            <span aria-hidden="true" className="sv-oc-add" style={{
              display: 'inline-flex', alignItems: 'center', gap: '0.2rem',
              padding: '0.3rem 0.85rem', borderRadius: 'var(--servd-btn-radius)',
              border: '1.5px solid currentColor', color: 'var(--servd-green-dark)',
              fontSize: '0.85rem', fontWeight: 800,
            }}>+ Add</span>
          )}
        </div>
      </button>
    )
  }

  return (
    <button
      type="button"
      onClick={() => !disabled && onClick()}
      disabled={disabled}
      style={frame}
      {...hover}
      aria-label={label}
    >
      <div style={{
        aspectRatio: '4/3',
        background: item.imageUrl ? undefined : `linear-gradient(135deg, ${tintColor(accent, '22')} 0%, white 200%)`,
        position: 'relative',
        overflow: 'hidden',
      }}>
        {/* A real image, not a CSS background, so the dish photo has alt text
            and can be found in image search. Same box, same crop. */}
        {item.imageUrl && (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={item.imageUrl}
            alt={item.name}
            loading="lazy"
            decoding="async"
            style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover', objectPosition: 'center' }}
          />
        )}
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
          <span style={{ ...SOLD_OUT_TAG, position: 'absolute', top: '0.6rem', left: '0.6rem' }}>Sold out</span>
        )}
      </div>
      <div style={{ padding: '0.95rem 1rem', display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
        <h3 style={{ fontSize: '1rem', fontWeight: 700, lineHeight: 1.3 }}>{item.name}</h3>
        {item.description && (
          <p style={{ color: 'var(--servd-mute)', fontSize: '0.85rem', lineHeight: 1.4, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
            {item.description}
          </p>
        )}
        <ItemTags item={item} />
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: '0.4rem' }}>
          <span style={{ fontWeight: 800, color: 'var(--servd-green-dark)' }}>{fmt(item.priceCents)}</span>
          {!disabled && <span style={{ fontSize: '1.25rem', color: 'var(--servd-green-dark)', fontWeight: 700 }}>+</span>}
        </div>
      </div>
    </button>
  )
}

// The one modal wrapper for the item sheet, the basket and the choice sheet:
// Escape closes, focus moves in and comes back, Tab stays inside, the page
// behind is inert and does not scroll (useDialog), and the panel wears the
// sheet surface. On Stackd --servd-ink / --servd-mute are cream, which is
// unreadable on a sheet, so inside the panel they follow the sheet's own ink.
function Sheet({
  onClose, stackd, z = 60, role = 'dialog', label, labelledBy, describedBy, panelStyle, children,
}: {
  onClose: () => void
  stackd: boolean
  z?: number
  role?: 'dialog' | 'alertdialog'
  label?: string
  labelledBy?: string
  describedBy?: string
  panelStyle?: React.CSSProperties
  children: React.ReactNode
}) {
  const panelRef = useRef<HTMLDivElement>(null)
  useDialog({
    open: true,
    ref: panelRef,
    onClose,
    initialFocus: () => panelRef.current?.querySelector<HTMLElement>('[data-autofocus]') ?? undefined,
  })
  const vars = stackd
    ? ({
        '--servd-ink': 'var(--servd-sheet-ink)',
        '--servd-mute': 'color-mix(in srgb, var(--servd-sheet-ink) 68%, transparent)',
        '--servd-line': 'color-mix(in srgb, var(--servd-sheet-ink) 18%, transparent)',
        // Stackd's green is cream (for the dark page): on the cream sheet the
        // primary button, the Required pill and the prices turn plum.
        '--servd-green': 'var(--stackd-plum)',
        '--servd-green-hover': 'var(--stackd-plum-dark)',
        '--servd-green-dark': 'var(--stackd-plum)',
        '--servd-on-green': 'var(--stackd-cream)',
      } as React.CSSProperties)
    : {}
  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, zIndex: z,
        background: 'rgba(0,0,0,0.45)',
        display: 'flex', alignItems: 'flex-end', justifyContent: 'center',
        overscrollBehavior: 'contain',
      }}
    >
      <div
        ref={panelRef}
        className="sv-sheet-panel"
        role={role}
        aria-modal="true"
        {...(label ? { 'aria-label': label } : {})}
        {...(labelledBy ? { 'aria-labelledby': labelledBy } : {})}
        {...(describedBy ? { 'aria-describedby': describedBy } : {})}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        style={{
          ...vars,
          background: 'var(--servd-sheet-bg)',
          color: 'var(--servd-ink)',
          width: '100%', maxWidth: '34rem',
          borderRadius: '1.25rem 1.25rem 0 0',
          maxHeight: '92dvh',
          display: 'flex', flexDirection: 'column',
          outline: 'none',
          animation: 'fadeUp 200ms cubic-bezier(0.22,1,0.36,1) both',
          ...panelStyle,
        }}
      >
        {children}
      </div>
    </div>
  )
}

const MAX_QTY = 20

function ItemDetailModal({
  item, accent, onClose, onAdd, fmt, conceptSlug,
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
  // Set once Add was tapped with a required group unmet: the groups that are
  // still unmet say "Choose one" until they are filled.
  const [showUnmet, setShowUnmet] = useState(false)
  const [flashId, setFlashId] = useState<string | null>(null)
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => { if (flashTimer.current) clearTimeout(flashTimer.current) }, [])
  const uid = useId()

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

  // Add with a group still unmet: take the customer to it (the button stays
  // enabled and says what is missing instead of looking broken).
  function onAddTap() {
    if (canAdd) {
      onAdd(item, qty, pickedModifiers, lineUnitPriceCents, notes.trim())
      return
    }
    setShowUnmet(true)
    const first = unmet[0]
    if (!first) return
    const el = document.getElementById(`${uid}-grp-${first.id}`)
    smoothScrollTo(el, { block: 'center' })
    setFlashId(first.id)
    if (flashTimer.current) clearTimeout(flashTimer.current)
    flashTimer.current = setTimeout(() => setFlashId(null), 1400)
    el?.querySelector<HTMLElement>('input')?.focus({ preventScroll: true })
  }

  const closeBtn = (photo: boolean): React.CSSProperties => photo
    ? {
        position: 'absolute', top: '0.6rem', right: '0.6rem',
        background: 'rgba(255,255,255,0.95)', border: 'none', borderRadius: 'var(--servd-btn-radius)', color: '#261038',
        width: '2.75rem', height: '2.75rem', fontSize: '1.3rem', cursor: 'pointer',
      }
    : {
        background: 'transparent', border: 'none', borderRadius: 'var(--servd-btn-radius)', color: 'var(--servd-mute)',
        width: '2.75rem', height: '2.75rem', fontSize: '1.4rem', cursor: 'pointer',
      }

  return (
    <Sheet onClose={onClose} stackd={conceptSlug === 'stackd'} label={item.name} panelStyle={{ overflow: 'hidden' }}>
        {item.imageUrl || item.videoUrl ? (
          <div style={{
            aspectRatio: '16/10',
            background: item.imageUrl ? `url(${item.imageUrl}) center/cover` : `linear-gradient(135deg, ${tintColor(accent, '22')} 0%, white 200%)`,
            position: 'relative',
            overflow: 'hidden',
            flex: 'none',
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
            <button type="button" onClick={onClose} aria-label="Close" style={closeBtn(true)}>×</button>
          </div>
        ) : (
          // No photo: no picture box, just the close button above the name.
          <div style={{ display: 'flex', justifyContent: 'flex-end', padding: '0.5rem 0.5rem 0' }}>
            <button type="button" onClick={onClose} aria-label="Close" style={closeBtn(false)}>×</button>
          </div>
        )}

        <div style={{ overflowY: 'auto', overscrollBehavior: 'contain', padding: '1.5rem', display: 'flex', flexDirection: 'column', gap: '1rem' }}>
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
            const isUnmet = unmet.some((u) => u.id === g.id)
            const flashing = flashId === g.id
            const caption =
              g.isRequired
                ? `Required · pick ${g.minSelect === g.maxSelect ? g.minSelect : `${g.minSelect}–${g.maxSelect}`}`
                : g.maxSelect > 1
                  ? `Pick up to ${g.maxSelect}`
                  : 'Optional'
            return (
              <fieldset
                key={g.id}
                id={`${uid}-grp-${g.id}`}
                style={{
                  border: '1px solid var(--servd-line)', borderRadius: '0.75rem', padding: '0.85rem 1rem 0.6rem', margin: 0,
                  scrollMarginTop: '1rem',
                  ...(flashing && { outline: '3px solid var(--servd-danger)', outlineOffset: '2px' }),
                  ...(showUnmet && isUnmet && !flashing && { borderColor: 'var(--servd-danger)' }),
                  transition: prefersReducedMotion() ? 'none' : 'outline-color 200ms',
                }}
              >
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
                <p style={{ fontSize: '0.75rem', color: 'var(--servd-mute)', marginBottom: '0.5rem' }}>
                  {caption}
                  {showUnmet && isUnmet && (
                    <span role="alert" style={{ marginLeft: '0.5rem', color: 'var(--servd-danger)', fontWeight: 800 }}>
                      {g.minSelect > 1 ? `Choose at least ${g.minSelect}` : 'Choose one'}
                    </span>
                  )}
                </p>
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
                            name={radio ? `${uid}-${g.id}` : undefined}
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
            <span style={{ display: 'flex', justifyContent: 'space-between', gap: '0.75rem', fontSize: '0.85rem', fontWeight: 600, color: 'var(--servd-mute)' }}>
              <span>Notes for the kitchen (optional)</span>
              <span aria-live="polite" style={{ fontVariantNumeric: 'tabular-nums', fontWeight: 500 }}>{notes.length}/200</span>
            </span>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={2}
              maxLength={200}
              enterKeyHint="done"
              autoComplete="off"
              placeholder="e.g. no onions, extra spicy"
              style={{
                marginTop: '0.4rem', width: '100%', padding: '0.65rem 0.85rem',
                border: '1px solid var(--servd-line)', borderRadius: '0.6rem', fontFamily: 'inherit',
                // 16px: below that iOS Safari zooms the page when it is focused.
                fontSize: '16px',
                background: 'transparent', color: 'inherit',
              }}
            />
          </label>
        </div>

        <div style={{ padding: '1rem 1.5rem 1.25rem', borderTop: '1px solid var(--servd-line)', display: 'flex', gap: '0.75rem', alignItems: 'center' }}>
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '0.15rem' }}>
            <div style={{ display: 'inline-flex', alignItems: 'center', gap: '0.15rem', border: '1px solid var(--servd-line)', borderRadius: 'var(--servd-btn-radius)', padding: '0.1rem' }}>
              <button type="button" onClick={() => setQty(Math.max(1, qty - 1))} aria-label="Decrease quantity"
                style={QTY_BTN}>−</button>
              <span aria-live="polite" style={{ minWidth: '1.5rem', textAlign: 'center', fontWeight: 700 }}>{qty}</span>
              <button type="button" onClick={() => setQty(Math.min(MAX_QTY, qty + 1))} aria-label="Increase quantity"
                aria-disabled={qty >= MAX_QTY}
                style={{ ...QTY_BTN, opacity: qty >= MAX_QTY ? 0.4 : 1 }}>+</button>
            </div>
            {qty >= MAX_QTY && (
              <span role="status" style={{ fontSize: '0.7rem', fontWeight: 700, color: 'var(--servd-mute)' }}>Max {MAX_QTY}</span>
            )}
          </div>
          <button
            type="button"
            onClick={onAddTap}
            className="servd-btn-rect servd-btn-primary"
            style={{ flex: 1, padding: '0.85rem 1rem', minHeight: '2.75rem' }}
          >
            {canAdd
              ? `Add ${qty} · ${fmt(lineUnitPriceCents * qty)}`
              : `Pick ${unmet[0]?.name}`}
          </button>
        </div>
    </Sheet>
  )
}

// Quantity steppers (item modal + basket): 44px tap targets; the visible
// pill around them stays slim.
const QTY_BTN: React.CSSProperties = {
  width: '2.75rem', height: '2.75rem', borderRadius: 'var(--servd-btn-radius)', border: 'none',
  background: 'transparent', color: 'inherit', fontSize: '1.1rem', cursor: 'pointer',
  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
}

type CartLine = ReturnType<typeof useCart.getState>['items'][number]

function CartDrawer({
  open, onOpen, onClose, onCheckout, fmt, basketBrand, stackd,
}: {
  open: boolean
  onOpen: () => void
  onClose: () => void
  onCheckout: () => void
  fmt: (cents: number) => string
  /** The basket's kitchen when it isn't the one on screen (the customer kept
   *  a basket from there); null when it's this kitchen's. */
  basketBrand: string | null
  stackd: boolean
}) {
  // Tax is computed at checkout (payment-method aware), not here.
  // The basket just shows subtotal.
  const cart = useCart()
  const subtotal = cart.subtotalCents()
  const itemCount = cart.itemCount()

  // A removed line, held for a few seconds so Undo can put it back through
  // the cart's own addItem (same menu item + modifiers = the same line).
  const [undo, setUndo] = useState<CartLine | null>(null)
  const undoTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => { if (undoTimer.current) clearTimeout(undoTimer.current) }, [])

  function removeLine(line: CartLine) {
    useCart.getState().removeItem(line.lineId)
    setUndo(line)
    if (undoTimer.current) clearTimeout(undoTimer.current)
    undoTimer.current = setTimeout(() => setUndo(null), 5000)
  }
  function undoRemove() {
    if (!undo) return
    const store = useCart.getState()
    for (let i = 0; i < undo.quantity; i++) {
      store.addItem({
        menuItemId: undo.menuItemId,
        name: undo.name,
        priceCents: undo.priceCents,
        ...(undo.modifiers && undo.modifiers.length > 0 && { modifiers: undo.modifiers }),
        ...(undo.notes && { notes: undo.notes }),
      })
    }
    setUndo(null)
    if (undoTimer.current) clearTimeout(undoTimer.current)
  }

  if (!open) {
    if (itemCount === 0) return null
    // Floating CTA pill anchored to bottom of screen — the primary action, so
    // the house primary: green fill, purple ink (never white on green). The
    // count chip inverts it.
    return (
      <button
        type="button"
        onClick={onOpen}
        aria-label={`View ${basketBrand ? `${basketBrand} ` : ''}basket — ${itemCount} item${itemCount === 1 ? '' : 's'}, ${fmt(subtotal)}`}
        style={{
          position: 'fixed', bottom: 'calc(1.25rem + env(safe-area-inset-bottom))', left: '50%', transform: 'translateX(-50%)', zIndex: 40,
          background: 'var(--servd-green)', color: 'var(--servd-on-green)', border: 'none',
          borderRadius: 'var(--servd-btn-radius)', padding: '0.85rem 1.5rem',
          display: 'flex', alignItems: 'center', gap: '0.85rem',
          boxShadow: '0 12px 40px rgba(0,0,0,0.25)', cursor: 'pointer',
          fontWeight: 800, whiteSpace: 'nowrap', maxWidth: 'calc(100vw - 2rem)',
        }}
      >
        <span style={{
          background: 'var(--servd-on-green)', color: 'var(--servd-green)',
          minWidth: '1.6rem', height: '1.6rem', borderRadius: 'var(--servd-btn-radius)', padding: '0 0.4rem',
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          fontWeight: 900, fontSize: '0.85rem',
        }}>
          {itemCount}
        </span>
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{basketBrand ? `${basketBrand} basket` : 'View basket'}</span>
        <span>{fmt(subtotal)}</span>
      </button>
    )
  }

  return (
    <Sheet onClose={onClose} stackd={stackd} label="Basket">
        <header style={{ padding: '0.75rem 0.75rem 0.75rem 1.5rem', borderBottom: '1px solid var(--servd-line)', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '1rem' }}>
          <div>
            <h2 style={{ fontSize: '1.2rem', fontWeight: 800 }}>Your basket</h2>
            {basketBrand && (
              <p style={{ color: 'var(--servd-mute)', fontSize: '0.8rem', marginTop: '0.15rem' }}>
                From {basketBrand} &mdash; checkout is with {basketBrand}.
              </p>
            )}
          </div>
          <button type="button" onClick={onClose} aria-label="Close basket"
            style={{ background: 'transparent', border: 'none', fontSize: '1.4rem', cursor: 'pointer', color: 'var(--servd-mute)', width: '2.75rem', height: '2.75rem', borderRadius: 'var(--servd-btn-radius)', flex: 'none' }}>×</button>
        </header>

        <div style={{ overflowY: 'auto', overscrollBehavior: 'contain', flex: 1 }}>
          {cart.items.length === 0 && (
            <p style={{ padding: '3rem 1.5rem', textAlign: 'center', color: 'var(--servd-mute)' }}>Basket&rsquo;s empty.</p>
          )}
          {cart.items.map((line) => (
            <div key={line.lineId} style={{ padding: '1rem 1.5rem', borderBottom: '1px solid var(--servd-line)', display: 'flex', gap: '1rem', alignItems: 'flex-start' }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <p style={{ fontWeight: 700, marginBottom: '0.25rem' }}>{line.name}</p>
                {line.modifiers && line.modifiers.length > 0 && (
                  <p style={{ color: 'var(--servd-mute)', fontSize: '0.78rem', lineHeight: 1.4, marginBottom: '0.2rem' }}>
                    {line.modifiers.map((m) => m.name).join(' · ')}
                  </p>
                )}
                {line.notes && (
                  <p style={{ color: 'var(--servd-mute)', fontSize: '0.78rem', lineHeight: 1.4, marginBottom: '0.2rem', fontStyle: 'italic', overflowWrap: 'anywhere' }}>
                    Note: {line.notes}
                  </p>
                )}
                <p style={{ color: 'var(--servd-mute)', fontSize: '0.85rem' }}>{fmt(line.priceCents)}</p>
                <div style={{ display: 'inline-flex', alignItems: 'center', gap: '0.15rem', marginTop: '0.5rem', border: '1px solid var(--servd-line)', borderRadius: 'var(--servd-btn-radius)', padding: '0.1rem' }}>
                  <button type="button"
                    onClick={() => (line.quantity <= 1 ? removeLine(line) : cart.updateQty(line.lineId, line.quantity - 1))}
                    aria-label={line.quantity <= 1 ? `Remove ${line.name}` : `Decrease ${line.name}`}
                    style={QTY_BTN}>−</button>
                  <span style={{ minWidth: '1.2rem', textAlign: 'center', fontWeight: 700, fontSize: '0.85rem' }}>{line.quantity}</span>
                  <button type="button" onClick={() => cart.updateQty(line.lineId, line.quantity + 1)} aria-label={`Increase ${line.name}`}
                    style={QTY_BTN}>+</button>
                </div>
              </div>
              <div style={{ textAlign: 'right' }}>
                <p style={{ fontWeight: 700 }}>{fmt(line.priceCents * line.quantity)}</p>
                <button type="button" onClick={() => removeLine(line)} aria-label={`Remove ${line.name}`}
                  style={{ background: 'transparent', border: 'none', color: 'var(--servd-mute)', fontSize: '0.75rem', marginTop: '0.15rem', minHeight: '2.75rem', padding: '0 0 0 0.75rem', cursor: 'pointer' }}>Remove</button>
              </div>
            </div>
          ))}
        </div>

        {undo && (
          <div role="status" style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.75rem',
            margin: '0.5rem 1rem 0', padding: '0 0.5rem 0 1rem', minHeight: '2.75rem', borderRadius: '0.75rem',
            background: 'var(--servd-sheet-ink)', color: 'var(--servd-sheet-bg)', fontSize: '0.9rem', fontWeight: 600,
          }}>
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>Removed · {undo.name}</span>
            <button type="button" onClick={undoRemove}
              style={{ background: 'transparent', border: 'none', color: 'inherit', fontWeight: 800, textDecoration: 'underline', minHeight: '2.75rem', padding: '0 0.75rem', cursor: 'pointer' }}>
              Undo
            </button>
          </div>
        )}

        {cart.items.length > 0 && (
          <footer style={{ padding: '1rem 1.5rem calc(1.25rem + env(safe-area-inset-bottom))', borderTop: '1px solid var(--servd-line)', marginTop: undo ? '0.5rem' : 0 }}>
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
            {/* servd-btn-primary: green fill, var(--servd-on-green) ink. */}
            <MagneticButton type="button" onClick={onCheckout} className="servd-btn-rect servd-btn-primary" style={{ width: '100%', padding: '1rem' }}>
              Checkout · {fmt(subtotal)} + tax
            </MagneticButton>
          </footer>
        )}
    </Sheet>
  )
}

// A small bottom sheet that asks one question before an add goes through
// (start a new basket? / are you at a table?). Not window.confirm: it wears
// the brand skin, and Escape or a tap outside means "no change". Focus moves
// to the button marked data-autofocus and returns where it was on close.
function ChoiceSheet({ title, body, onDismiss, stackd, children }: {
  title: string
  body: React.ReactNode
  onDismiss: () => void
  stackd: boolean
  children: React.ReactNode
}) {
  const id = useId()
  return (
    <Sheet
      onClose={onDismiss}
      stackd={stackd}
      z={70}
      role="alertdialog"
      labelledBy={`${id}-title`}
      describedBy={`${id}-body`}
      panelStyle={{
        padding: '1.5rem 1.5rem calc(1.25rem + env(safe-area-inset-bottom))',
        display: 'grid', gap: '0.6rem', maxHeight: 'none',
      }}
    >
      <h2 id={`${id}-title`} style={{ fontSize: '1.2rem', fontWeight: 800, lineHeight: 1.3 }}>{title}</h2>
      <p id={`${id}-body`} style={{ color: 'var(--servd-mute)', fontSize: '0.95rem', lineHeight: 1.5 }}>{body}</p>
      <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap', marginTop: '0.6rem' }}>
        {children}
      </div>
    </Sheet>
  )
}
