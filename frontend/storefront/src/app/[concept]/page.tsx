'use client'

// Per-brand ordering page:
//   • brand-keyed hero (image + name + tagline)
//   • sticky category nav (jumps within the page)
//   • menu grid with card-per-item
//   • item customisation sheet (drag to dismiss) that flies the item into
//     the cart pill on Add
//   • basket sheet with checkout CTA
//
// Every surface paints in the brand's material through the --o-* tokens in
// components/order/order.module.css: rubber for the servd hub, sticker and
// paper for stackd, diner enamel for Flipd, linen and ceramic for simmer.
//
// Uses the public storefront API: /storefront/concepts and /storefront/:slug/menu.

import { AnimatePresence, LayoutGroup, MotionConfig, motion, useAnimationControls, useReducedMotion, type TargetAndTransition, type Transition } from 'framer-motion'
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { useParams, useRouter } from 'next/navigation'
import Link from 'next/link'
import { useCart } from '../../store/cart'
import { conceptHeroImage, formatBrandName, typeLabel } from '../../lib/concept'
import { useBrandSlug, getServdHost } from '../../lib/host'
import { encodeCartToken } from '../../lib/cartHandoff'
import { EASE_OUT, SPRING, tick } from '../../lib/tactile'
import { useSquish } from '../../components/tactile/useSquish'
import { CrowdPoster } from '../../components/characters/CrowdPoster'
import type { CharacterKind } from '../../components/characters/types'
import { BottomSheet, SheetBody, SheetDragZone, orderBrand, type OrderBrand } from '../../components/order/BottomSheet'
import { CartPill } from '../../components/order/CartPill'
import { useFlyToCart } from '../../components/order/FlyToCart'
import { OrderEmptyState } from '../../components/order/OrderEmptyState'
import { RollingNumber } from '../../components/order/RollingNumber'
import styles from '../../components/order/order.module.css'

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
function PlusIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" aria-hidden="true">
      <path d="M12 5v14M5 12h14" />
    </svg>
  )
}
function CloseIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" aria-hidden="true">
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  )
}
function CheckIcon() {
  return (
    <svg className={styles.modCheck} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M5 12.5l4.5 4.5L19 7.5" />
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
// to render a usable page from just the URL slug.
function prettifySlug(slug: string): string {
  return slug
    .split('-')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ')
}

// Fetch concept + menu. Resilient against either API hiccupping: if the
// /concepts fetch fails (Neon cold-start, transient 5xx, rate limit) we
// derive a minimal placeholder concept from the slug so the menu still
// renders. Throws only when the *menu* itself is unavailable — that's the
// one we can't fake. Pure: the page commits the result (and the retry on the
// "menu isn't online" state re-runs exactly this).
async function fetchMenu(slug: string): Promise<{ concept: Concept; categories: Category[] }> {
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
  return { concept: resolved, categories: cats }
}

// ── Press model per material ──────────────────────────────────────────────
// servd hub + stackd: the shared rubber squish. simmer: a weighted 1px press,
// no bounce. Flipd: a hard enamel clack, no overshoot.
interface PressProps {
  whileHover?: TargetAndTransition
  whileTap: TargetAndTransition
  transition: Transition
  onTapStart: () => void
}
function usePress(brand: OrderBrand, strength = 1, hover = true): PressProps {
  const squish = useSquish({ strength, hover })
  const reduced = useReducedMotion()
  return useMemo<PressProps>(() => {
    if (reduced || brand === 'hub' || brand === 'stackd') return squish
    if (brand === 'simmer') {
      return {
        whileTap: { y: 1, transition: { duration: 0.08, ease: 'easeOut' } },
        transition: { duration: 0.24, ease: EASE_OUT },
        onTapStart: squish.onTapStart,
      }
    }
    return {
      whileTap: { y: 3 * strength, scale: 0.985, transition: { duration: 0.05, ease: 'easeOut' } },
      ...(hover ? { whileHover: { y: -2 } } : {}),
      transition: { type: 'spring', stiffness: 900, damping: 40 },
      onTapStart: squish.onTapStart,
    }
  }, [brand, reduced, squish, strength, hover])
}

// Name-sticker colour for items without a photo, per brand ground.
const FLY_CHIP: Partial<Record<OrderBrand, string>> = {
  simmer: '#EDE6D3',
  stackd: '#9BD3DD',
  flipd: '#FED561',
}

function shrugCast(brand: OrderBrand): CharacterKind[] {
  if (brand === 'flipd') return ['burger', 'fries']
  if (brand === 'stackd') return ['coffee', 'croissant']
  return ['fries', 'coffee']
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
  const [bump, setBump] = useState(0)
  const [note, setNote] = useState<string | undefined>(undefined)

  const cart = useCart()
  const brandSlug = useBrandSlug()
  const brand = orderBrand(slug)
  const { fly, portal } = useFlyToCart()

  // Latest cart for the commit step, so a retry run later still sees the
  // current store, exactly like the original effect saw it at run time.
  const cartRef = useRef(cart)
  cartRef.current = cart
  const slugRef = useRef(slug)
  slugRef.current = slug

  const commit = useCallback((s: string, result: { concept: Concept; categories: Category[] }) => {
    const cats = result.categories
    setConcept(result.concept)
    setCategories(cats)
    setActiveCategory(cats[0]?.id ?? null)
    setError(null)
    const c = cartRef.current
    if (c.conceptSlug && c.conceptSlug !== s) c.clearCart()
    c.setConceptSlug(s)
  }, [])

  useEffect(() => {
    let cancelled = false
    async function load() {
      try {
        const result = await fetchMenu(slug)
        if (cancelled) return
        commit(slug, result)
      } catch (e) {
        if (!cancelled) setError((e as Error).message)
      }
    }
    void load()
    return () => { cancelled = true }
  }, [slug, commit])

  // Retry from the "menu isn't online" state: the same fetch. Resolves when
  // the menu is back (the button shows its check, then the menu takes over),
  // rejects when it's still offline (the button shakes).
  const retry = useCallback(async () => {
    const s = slug
    const result = await fetchMenu(s)
    window.setTimeout(() => {
      if (slugRef.current === s) commit(s, result)
    }, 650)
  }, [slug, commit])

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

  // Keep the active chip in view inside the horizontally-scrolling nav.
  const navRef = useRef<HTMLElement>(null)
  useEffect(() => {
    const nav = navRef.current
    if (!nav || !activeCategory) return
    const chip = nav.querySelector<HTMLElement>(`[data-cat="${CSS.escape(activeCategory)}"]`)
    if (!chip) return
    const left = chip.offsetLeft - nav.clientWidth / 2 + chip.clientWidth / 2
    nav.scrollTo({ left: Math.max(0, left), behavior: 'smooth' })
  }, [activeCategory])

  if (error) {
    return (
      <OrderEmptyState
        slug={slug}
        brandName={concept?.name ?? prettifySlug(slug)}
        onRetry={retry}
      />
    )
  }

  if (!concept || !categories) {
    // Menu skeleton — same hero stripe + category nav strip + item rows as
    // the real page, on the brand's own ground. Reserves the layout so the
    // real menu doesn't push content around on hydrate (avoids CLS).
    return (
      <div role="status" aria-label="Loading menu" className={`${styles.scope} ${styles.skel}`} data-obrand={brand}>
        <div className={`${styles.skelBlock} ${styles.skelHero}`} />
        <div className={styles.skelChips}>
          {Array.from({ length: 4 }).map((_, i) => (
            <span key={i} className={`${styles.skelBlock} ${styles.skelChip}`} />
          ))}
        </div>
        <div className={styles.skelRows}>
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className={styles.skelRow} style={{ '--i': i } as CSSProperties}>
              <div>
                <div className={`${styles.skelBlock} ${styles.skelLine}`} />
                <div className={`${styles.skelBlock} ${styles.skelLineLong}`} />
              </div>
              <div className={`${styles.skelBlock} ${styles.skelThumb}`} />
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
  const displayName = formatBrandName(concept.name)
  const calm = brand === 'simmer'

  // Per-brand skin — same class system as /[concept]/checkout. Wraps the
  // ordering surface in the brand's design language so the menu / item
  // sheet / basket feel like the brand the customer just walked into.
  const brandSkinClass =
    slug === 'simmer' ? 'simmer-ordering' :
    slug === 'stackd'   ? 'stackd-ordering'   :
    slug === 'flipd'  ? 'flipd-ordering'  :
    ''

  return (
    <MotionConfig reducedMotion="user">
      <div
        className={[brandSkinClass, styles.scope, styles.page, hasItems ? styles.pageWithPill : ''].filter(Boolean).join(' ')}
        data-obrand={brand}
      >
        {/* Hero */}
        <section
          className={styles.hero}
          style={{ backgroundColor: accent, backgroundImage: `url(${conceptHeroImage(concept)})` }}
        >
          <div aria-hidden="true" className={styles.heroScrim} />
          <div className={`container ${styles.heroInner}`}>
            <div className={styles.heroLinks}>
              <Link href={`/brand/${concept.slug}`} className={styles.heroLink}>
                <span aria-hidden="true">←</span> {displayName}
              </Link>
              <Link href="/browse" className={styles.heroLink}>
                Other brands <span aria-hidden="true">→</span>
              </Link>
            </div>
            <span className={styles.heroEyebrow}>{typeLabel(concept.type)} · order here</span>
            <motion.h1
              className={styles.heroTitle}
              initial={{ opacity: 0.35, y: calm ? 6 : 16 }}
              animate={{ opacity: 1, y: 0 }}
              transition={calm ? { duration: 0.5, ease: EASE_OUT } : SPRING.settle}
            >
              {/* simmer + stackd brand rule: the wordmark is always lowercase. */}
              {displayName}
            </motion.h1>
            {concept.description && (
              <p className={styles.heroDesc}>{concept.description}</p>
            )}
          </div>
        </section>

        {/* Sticky category nav */}
        {categories.length > 0 && (
          <LayoutGroup id="order-cats">
            <nav ref={navRef} aria-label="Menu sections" className={styles.catNav}>
              {categories.map((c) => {
                const active = activeCategory === c.id
                return (
                  <a
                    key={c.id}
                    href={`#cat-${c.id}`}
                    data-cat={c.id}
                    aria-current={active ? 'true' : undefined}
                    onClick={(e) => {
                      e.preventDefault()
                      document.getElementById(`cat-${c.id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
                      setActiveCategory(c.id)
                    }}
                    className={`${styles.catChip} ${active ? styles.catChipActive : ''}`}
                  >
                    {active && (
                      <motion.span
                        layoutId="order-cat-active"
                        className={styles.catChipBg}
                        transition={calm ? { duration: 0.22, ease: EASE_OUT } : SPRING.settle}
                      />
                    )}
                    {c.name}
                  </a>
                )
              })}
            </nav>
          </LayoutGroup>
        )}

        {/* Menu */}
        <div className={`container ${styles.menu}`}>
          {categories.length === 0 && (
            <div className={styles.noMenu}>
              {!calm && (
                <div className={styles.noMenuPoster}>
                  <CrowdPoster cast={shrugCast(brand)} mode="shrug" />
                </div>
              )}
              <h3>No menu yet</h3>
              <p>{displayName} hasn&rsquo;t published a menu. Check back soon.</p>
            </div>
          )}

          {categories.map((cat) => (
            <section key={cat.id} id={`cat-${cat.id}`} className={styles.catSection}>
              <h2 className={styles.catTitle}>
                {cat.name}
                <span className={styles.catCount} aria-label={`${cat.items.length} items`}>{cat.items.length}</span>
              </h2>
              <div className={styles.grid}>
                {cat.items.map((item, i) => (
                  <div key={item.id} className={styles.gridCell}>
                    <ItemCard item={item} index={i} brand={brand} onClick={() => setOpenItem(item)} fmt={fmt} />
                  </div>
                ))}
              </div>
            </section>
          ))}
        </div>

        {/* Item sheet */}
        <BottomSheet
          open={openItem !== null}
          onClose={() => setOpenItem(null)}
          label={openItem?.name ?? 'Item'}
          brand={brand}
        >
          {openItem && (
            <ItemDetail
              key={openItem.id}
              item={openItem}
              brand={brand}
              fmt={fmt}
              onClose={() => setOpenItem(null)}
              onAdd={(item, qty, modifiers, finalPriceCents, notes, fromRect) => {
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
                // No drawer: the pill catching the item is the confirmation.
                const land = () => { setNote(item.name); setBump((b) => b + 1) }
                if (fromRect) {
                  void fly(fromRect, {
                    imageUrl: item.imageUrl,
                    label: item.name,
                    ...(FLY_CHIP[brand] ? { color: FLY_CHIP[brand] } : {}),
                  }).then(land)
                } else {
                  land()
                }
              }}
            />
          )}
        </BottomSheet>

        {/* Cart pill */}
        <AnimatePresence>
          {hasItems && (
            <CartPill
              key="cart-pill"
              count={itemTotal}
              subtotalLabel={fmt(cart.subtotalCents())}
              onOpen={() => setCartOpen(true)}
              bump={bump}
              note={note}
              brand={brand}
            />
          )}
        </AnimatePresence>

        {/* Basket sheet */}
        <BottomSheet open={cartOpen} onClose={() => setCartOpen(false)} label="Basket" brand={brand}>
          <BasketContents
            brand={brand}
            fmt={fmt}
            onClose={() => setCartOpen(false)}
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
        </BottomSheet>

        {portal}
      </div>
    </MotionConfig>
  )
}

// ───── Components ───────────────────────────────────────────────────────────

/** A photo that fades and settles in (.96 → 1) once it has actually loaded. */
function useLoadedImage() {
  const [loaded, setLoaded] = useState(false)
  const ref = useCallback((el: HTMLImageElement | null) => {
    if (el && el.complete && el.naturalWidth > 0) setLoaded(true)
  }, [])
  return { loaded, ref, onLoad: () => setLoaded(true) }
}

function ItemCard({ item, index, brand, onClick, fmt }: {
  item: MenuItem; index: number; brand: OrderBrand; onClick: () => void; fmt: (cents: number) => string
}) {
  const disabled = !item.isAvailable
  const press = usePress(brand, 1)
  const img = useLoadedImage()
  const calm = brand === 'simmer'
  const hasBadges = (item.dietary?.length ?? 0) > 0 || (item.spiceLevel ?? 0) > 0
  const spice = Math.min(item.spiceLevel ?? 0, 3)
  const badgeIn = (i: number): Transition =>
    calm ? { duration: 0.3, ease: EASE_OUT, delay: i * 0.04 } : { ...SPRING.pop, delay: 0.12 + i * 0.04 }

  return (
    <motion.button
      type="button"
      onClick={() => !disabled && onClick()}
      disabled={disabled}
      className={`${styles.card} ${disabled ? styles.cardDisabled : ''}`}
      aria-label={`${item.name} — ${fmt(item.priceCents)}${disabled ? ' — sold out' : ''}`}
      initial={{ opacity: 0.4, y: calm ? 6 : 14 }}
      whileInView={{ opacity: 1, y: 0, transition: calm ? { duration: 0.45, ease: EASE_OUT, delay: Math.min(index, 5) * 0.05 } : { ...SPRING.settle, delay: Math.min(index, 5) * 0.05 } }}
      viewport={{ once: true, amount: 0.2 }}
      {...(disabled ? { transition: press.transition } : press)}
    >
      <div className={styles.cardMedia}>
        <span className={`${styles.placeholder} ${img.loaded || !item.imageUrl ? styles.placeholderStill : ''}`} aria-hidden="true">
          {item.name.trim().charAt(0).toUpperCase()}
        </span>
        {item.imageUrl && (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            ref={img.ref}
            src={item.imageUrl}
            alt=""
            loading="lazy"
            decoding="async"
            onLoad={img.onLoad}
            className={`${styles.cardImg} ${img.loaded ? styles.imgLoaded : ''}`}
          />
        )}
        {item.videoUrl && (
          <video
            src={item.videoUrl}
            {...(item.imageUrl ? { poster: item.imageUrl } : {})}
            autoPlay muted loop playsInline preload="metadata"
            aria-hidden="true"
            className={styles.cardVideo}
          />
        )}
        {disabled && <span className={styles.soldOut}>Sold out</span>}
      </div>
      <div className={styles.cardBody}>
        <h3 className={styles.cardName}>{item.name}</h3>
        {item.description && <p className={styles.cardDesc}>{item.description}</p>}
        {hasBadges && (
          <div className={styles.badges}>
            {(item.dietary ?? []).map((d, i) => {
              const b = DIETARY_BADGE[d]
              return (
                <motion.span
                  key={d}
                  className={styles.badge}
                  initial={{ opacity: 0.3, scale: calm ? 1 : 0.6 }}
                  whileInView={{ opacity: 1, scale: 1, transition: badgeIn(i) }}
                  viewport={{ once: true, amount: 0.2 }}
                >
                  {b?.withIcon && <LeafIcon />}
                  {b?.label ?? d}
                </motion.span>
              )
            })}
            {spice > 0 && (
              <motion.span
                aria-label={`Spice level ${spice} of 3`}
                className={`${styles.badge} ${styles.badgeSpice}`}
                initial={{ opacity: 0.3, scale: calm ? 1 : 0.6 }}
                whileInView={{ opacity: 1, scale: 1, transition: badgeIn(item.dietary?.length ?? 0) }}
                viewport={{ once: true, amount: 0.2 }}
              >
                {Array.from({ length: spice }).map((_, i) => <FlameIcon key={i} />)}
              </motion.span>
            )}
          </div>
        )}
        {(item.allergens?.length ?? 0) > 0 && (
          <p className={styles.allergens}>Contains: {(item.allergens ?? []).join(', ')}</p>
        )}
        <div className={styles.cardFoot}>
          <span className={styles.price}>{fmt(item.priceCents)}</span>
          {!disabled && <span className={styles.plus} aria-hidden="true"><PlusIcon /></span>}
        </div>
      </div>
    </motion.button>
  )
}

function ItemDetail({
  item, brand, onClose, onAdd, fmt,
}: {
  item: MenuItem
  brand: OrderBrand
  fmt: (cents: number) => string
  onClose: () => void
  onAdd: (
    item: MenuItem,
    qty: number,
    modifiers: { modifierId: string; name: string; priceDeltaCents: number }[],
    finalPriceCents: number,
    notes: string,
    fromRect: DOMRect | null,
  ) => void
}) {
  const [qty, setQty] = useState(1)
  const [notes, setNotes] = useState('')
  const [flagged, setFlagged] = useState<string | null>(null)
  const mediaRef = useRef<HTMLDivElement>(null)
  const groupRefs = useRef<Record<string, HTMLFieldSetElement | null>>({})
  const addControls = useAnimationControls()
  const reduced = useReducedMotion()
  const img = useLoadedImage()
  const calm = brand === 'simmer'

  const addPress = usePress(brand, 1.2, false)
  const stepPress = usePress(brand, 0.8, false)
  const rowPress = usePress(brand, 0.35, false)

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
  const flaggedOpen = flagged !== null && unmet.some((g) => g.id === flagged)

  // Flatten picks for price calculation + the add payload.
  const pickedModifiers = groups.flatMap((g) =>
    g.modifiers
      .filter((m) => selections[g.id]?.has(m.id))
      .map((m) => ({ modifierId: m.id, name: m.name, priceDeltaCents: m.priceDeltaCents })),
  )
  const lineUnitPriceCents = item.priceCents + pickedModifiers.reduce((s, m) => s + m.priceDeltaCents, 0)

  function handleAdd() {
    if (!canAdd) {
      // A designed "not yet": shake the button and walk the customer to the
      // group that still needs a pick.
      const first = unmet[0]
      if (first) {
        setFlagged(first.id)
        groupRefs.current[first.id]?.scrollIntoView({ behavior: reduced ? 'auto' : 'smooth', block: 'center' })
      }
      tick('error')
      if (!reduced && !calm) void addControls.start({ x: [0, -8, 7, -5, 3, 0], transition: { duration: 0.38, ease: 'easeOut' } })
      return
    }
    onAdd(item, qty, pickedModifiers, lineUnitPriceCents, notes.trim(), mediaRef.current?.getBoundingClientRect() ?? null)
  }

  const markIn: Transition = calm ? { duration: 0.16, ease: EASE_OUT } : SPRING.pop

  return (
    <>
      <SheetDragZone className={styles.media} innerRef={mediaRef}>
        <span className={`${styles.placeholder} ${img.loaded || !item.imageUrl ? styles.placeholderStill : ''}`} aria-hidden="true">
          {item.name.trim().charAt(0).toUpperCase()}
        </span>
        {item.imageUrl && (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            ref={img.ref}
            src={item.imageUrl}
            alt=""
            decoding="async"
            onLoad={img.onLoad}
            draggable={false}
            className={`${styles.mediaImg} ${img.loaded ? styles.imgLoaded : ''}`}
          />
        )}
        {item.videoUrl && (
          <video
            src={item.videoUrl}
            {...(item.imageUrl ? { poster: item.imageUrl } : {})}
            autoPlay muted loop playsInline preload="metadata"
            aria-hidden="true"
            className={styles.cardVideo}
          />
        )}
        <motion.button type="button" onClick={onClose} aria-label="Close" className={`${styles.closeBtn} ${styles.mediaClose}`} {...stepPress}>
          <CloseIcon />
        </motion.button>
      </SheetDragZone>

      <SheetBody>
        <div className={styles.detail}>
          <h2 className={styles.detailName}>{item.name}</h2>
          {item.description && <p className={styles.detailDesc}>{item.description}</p>}
          <p className={styles.detailPrice}>{fmt(item.priceCents)}</p>

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
              <fieldset
                key={g.id}
                ref={(el) => { groupRefs.current[g.id] = el }}
                className={`${styles.group} ${flaggedOpen && flagged === g.id ? styles.groupFlagged : ''}`}
              >
                <legend className={styles.groupLegend}>
                  <span className={styles.groupName}>{g.name}</span>
                  {g.isRequired && <span className={styles.required}>Required</span>}
                </legend>
                <p className={styles.groupCaption}>{caption}</p>
                <div className={styles.modList}>
                  {g.modifiers.map((m) => {
                    const checked = picked.has(m.id)
                    const reachedMax = !radio && !checked && picked.size >= g.maxSelect
                    return (
                      <motion.label
                        key={m.id}
                        className={`${styles.modRow} ${checked ? styles.modRowOn : ''} ${reachedMax ? styles.modRowOff : ''}`}
                        {...(reachedMax ? {} : rowPress)}
                      >
                        <span className={styles.modLead}>
                          <input
                            type={radio ? 'radio' : 'checkbox'}
                            name={radio ? g.id : undefined}
                            checked={checked}
                            disabled={reachedMax}
                            onChange={() => togglePick(g, m.id)}
                            className={styles.modInput}
                          />
                          <span
                            className={`${styles.modMark} ${radio ? styles.modMarkRadio : ''} ${checked ? styles.modMarkOn : ''}`}
                            aria-hidden="true"
                          >
                            <AnimatePresence initial={false}>
                              {checked && (
                                <motion.span
                                  key="on"
                                  style={{ display: 'grid', placeItems: 'center' }}
                                  initial={{ scale: 0, opacity: 0 }}
                                  animate={{ scale: 1, opacity: 1, transition: markIn }}
                                  exit={{ scale: 0, opacity: 0, transition: { duration: 0.12 } }}
                                >
                                  {radio ? <span className={styles.modDot} /> : <CheckIcon />}
                                </motion.span>
                              )}
                            </AnimatePresence>
                          </span>
                          <span>{m.name}</span>
                        </span>
                        {m.priceDeltaCents !== 0 && (
                          <span className={styles.modDelta}>
                            {m.priceDeltaCents > 0 ? '+' : ''}{fmt(m.priceDeltaCents)}
                          </span>
                        )}
                      </motion.label>
                    )
                  })}
                </div>
              </fieldset>
            )
          })}

          <label className={styles.notes}>
            <span className={styles.notesLabel}>Notes for the kitchen (optional)</span>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={2}
              maxLength={200}
              placeholder="e.g. no onions, extra spicy"
              className={styles.notesField}
            />
          </label>
        </div>
      </SheetBody>

      <div className={styles.sheetFooter}>
        <div className={styles.stepper}>
          <motion.button type="button" onClick={() => setQty(Math.max(1, qty - 1))} aria-label="Decrease quantity" className={styles.stepBtn} {...stepPress}>−</motion.button>
          <span className={styles.stepQty} aria-live="polite"><RollingNumber value={qty} /></span>
          <motion.button type="button" onClick={() => setQty(Math.min(20, qty + 1))} aria-label="Increase quantity" className={styles.stepBtn} {...stepPress}>+</motion.button>
        </div>
        <motion.div animate={addControls} style={{ flex: 1, display: 'flex', minWidth: 0 }}>
          <motion.button
            type="button"
            onClick={handleAdd}
            aria-disabled={!canAdd}
            className={`${styles.cta} ${canAdd ? '' : styles.ctaBlocked}`}
            {...addPress}
          >
            {canAdd
              ? `Add ${qty} · ${fmt(lineUnitPriceCents * qty)}`
              : `Pick ${unmet[0]?.name}`}
          </motion.button>
        </motion.div>
      </div>
    </>
  )
}

function BasketContents({
  brand, onClose, onCheckout, fmt,
}: {
  brand: OrderBrand
  onClose: () => void
  onCheckout: () => void
  fmt: (cents: number) => string
}) {
  // Tax is computed at checkout (payment-method aware), not here.
  // The basket just shows subtotal.
  const cart = useCart()
  const subtotal = cart.subtotalCents()
  const itemCount = cart.itemCount()
  const calm = brand === 'simmer'

  const stepPress = usePress(brand, 0.7, false)
  const removePress = usePress(brand, 0.6, false)
  const ctaPress = usePress(brand, 1.2, false)
  const lineExit: Transition = { duration: 0.22, ease: EASE_OUT }

  return (
    <>
      <SheetDragZone className={styles.sheetHeader}>
        <h2 className={styles.sheetTitle}>
          Your basket
          {itemCount > 0 && (
            <span className={styles.basketCount}><RollingNumber value={itemCount} decorative /></span>
          )}
        </h2>
        <motion.button type="button" onClick={onClose} aria-label="Close basket" className={styles.closeBtn} {...stepPress}>
          <CloseIcon />
        </motion.button>
      </SheetDragZone>

      <SheetBody>
        <AnimatePresence initial={false}>
          {cart.items.map((line) => (
            <motion.div
              key={line.lineId}
              layout={calm ? 'position' : true}
              className={styles.lineWrap}
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: 'auto' }}
              exit={{ x: -24, opacity: 0, height: 0, transition: lineExit }}
              transition={calm ? { duration: 0.22, ease: EASE_OUT } : SPRING.settle}
            >
              <div className={styles.line}>
                <div className={styles.lineMain}>
                  <p className={styles.lineName}>{line.name}</p>
                  {line.modifiers && line.modifiers.length > 0 && (
                    <p className={styles.lineMods}>{line.modifiers.map((m) => m.name).join(' · ')}</p>
                  )}
                  <p className={styles.lineMeta}>{fmt(line.priceCents)} · qty {line.quantity}</p>
                  <div className={`${styles.stepper} ${styles.stepperSm}`}>
                    <motion.button type="button" onClick={() => cart.updateQty(line.lineId, line.quantity - 1)} aria-label="Decrease" className={styles.stepBtn} {...stepPress}>−</motion.button>
                    <span className={styles.stepQty}><RollingNumber value={line.quantity} /></span>
                    <motion.button type="button" onClick={() => cart.updateQty(line.lineId, line.quantity + 1)} aria-label="Increase" className={styles.stepBtn} {...stepPress}>+</motion.button>
                  </div>
                </div>
                <div className={styles.lineRight}>
                  <p className={styles.lineTotal}><RollingNumber value={fmt(line.priceCents * line.quantity)} /></p>
                  <motion.button type="button" onClick={() => cart.removeItem(line.lineId)} className={styles.removeBtn} {...removePress}>
                    Remove
                  </motion.button>
                </div>
              </div>
            </motion.div>
          ))}
        </AnimatePresence>

        {cart.items.length === 0 && (
          <motion.div
            className={styles.basketEmpty}
            initial={{ opacity: 0, y: calm ? 4 : 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={calm ? { duration: 0.3, ease: EASE_OUT } : { ...SPRING.settle, delay: 0.15 }}
          >
            {!calm && (
              <div className={styles.basketPoster}>
                <CrowdPoster cast={shrugCast(brand)} mode="shrug" />
              </div>
            )}
            <p className={styles.basketNudge}>
              Nothing in here yet. The menu is right behind this, and everything on it wants a ride.
            </p>
            <motion.button type="button" onClick={onClose} className={`${styles.cta} ${styles.basketBack}`} {...ctaPress}>
              Back to the menu
            </motion.button>
          </motion.div>
        )}
      </SheetBody>

      {cart.items.length > 0 && (
        <footer className={styles.basketFoot}>
          <div className={styles.totals}>
            {/* Tax/GST is computed at checkout once the customer picks
                a payment method (8% on card-rails, 15% on cash), so
                the basket only shows subtotal here and notes that tax
                is added at the next step. */}
            <div className={styles.totRow}>
              <span className={styles.totMute}>Subtotal</span>
              <RollingNumber value={fmt(subtotal)} />
            </div>
            <div className={`${styles.totRow} ${styles.totNote}`}>
              <span>GST</span>
              <span>added at checkout</span>
            </div>
            <div className={`${styles.totRow} ${styles.totGrand}`}>
              <span>Total before tax</span>
              <RollingNumber value={fmt(subtotal)} />
            </div>
          </div>
          <motion.button type="button" onClick={onCheckout} className={`${styles.cta} ${styles.ctaWide}`} {...ctaPress}>
            Checkout · {fmt(subtotal)} + tax
          </motion.button>
        </footer>
      )}
    </>
  )
}
