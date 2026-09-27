'use client'
import Link from 'next/link'
import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { motion, useReducedMotion } from 'framer-motion'
import { Search, X } from 'lucide-react'
import type { Concept } from '../../lib/concept'
import { formatBrandName } from '../../lib/concept'
import { trackSearch, trackFilterApplied } from '../../lib/analytics'
import { useKitchens } from '../../lib/world/kitchens'
import { useWorld } from '../../lib/world/useWorld'
import { emptyLine, openCountLine } from '../../lib/world/voice'
import { emitCrowd } from '../../components/characters/crowdBus'
import { CrowdCameo } from '../../components/world/cast/CrowdCameo'
import { BrowseCard } from '../../components/party/browse/BrowseCard'
import { Doodles } from '../../components/party/browse/Doodles'
import s from '../../components/party/browse/browse.module.css'

const API_URL = process.env['NEXT_PUBLIC_API_URL'] ?? 'http://localhost:3001'

const FILTERS = [
  { key: 'all',        label: 'All' },
  { key: 'restaurant', label: 'Dine-in' },
  { key: 'digital',    label: 'Delivery' },
  { key: 'cart',       label: 'Walk-up' },
] as const

// When the API is down (or returns nothing) the page still shows the three
// kitchens — mirrors HomeClient's FALLBACK_BRANDS. Browse must never say
// "0 kitchens". Descriptions stay null so each card falls back to its
// brand story one-liner.
const FALLBACK_CONCEPTS: Concept[] = [
  { id: 'fallback-stackd', name: formatBrandName('stackd'), slug: 'stackd', type: 'restaurant', description: null, logoUrl: null, primaryColor: null },
  { id: 'fallback-simmer', name: formatBrandName('simmer'), slug: 'simmer', type: 'restaurant', description: null, logoUrl: null, primaryColor: null },
  { id: 'fallback-flipd',  name: formatBrandName('Flipd'),  slug: 'flipd',  type: 'restaurant', description: null, logoUrl: null, primaryColor: null },
]

/** The crowd gets curious while you type — at most once every two seconds. */
const CURIOUS_EVERY_MS = 2000

interface Props {
  concepts: Concept[]
}

interface MenuHit {
  id: string; name: string; description: string | null; priceCents: number; imageUrl: string | null
  concept: { name: string; slug: string; primaryColor: string | null }
}

// Each word drops in on its own beat, matching the home hero's headline
// motion (see components/party/PartyHero.tsx BouncyWords).
function BouncyWords({ text }: { text: string }) {
  return (
    <>
      {text.split(' ').map((w, i) => (
        <span key={`${w}-${i}`} className={s.titleWord} style={{ '--i': i } as CSSProperties}>
          {w}
        </span>
      ))}
    </>
  )
}

// Reveal hygiene: the server render is the final frame. A card that is
// already on screen at mount is never touched; one below the fold is armed
// after mount (opacity .4, a little low) and settles in ≤ 440 ms as it nears
// the viewport — so a jump-scroll never lands on an empty grid.
function Reveal({ index, children }: { index: number; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null)
  const [state, setState] = useState<'idle' | 'armed' | 'shown'>('idle')

  useEffect(() => {
    const el = ref.current
    if (!el || typeof IntersectionObserver === 'undefined') return
    try {
      if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
    } catch { /* ignore */ }
    if (el.getBoundingClientRect().top < window.innerHeight + 40) return
    setState('armed')
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setState('shown')
          io.disconnect()
        }
      },
      { rootMargin: '0px 0px 120px 0px', threshold: 0 },
    )
    io.observe(el)
    return () => io.disconnect()
  }, [])

  return (
    <div
      ref={ref}
      className={`${s.cardWrap} ${state === 'armed' ? s.armed : ''} ${state === 'shown' ? s.shown : ''}`}
      style={{ '--d': `${Math.min(index % 4, 3) * 40}ms` } as CSSProperties}
    >
      {children}
    </div>
  )
}

export function BrowseClient({ concepts }: Props) {
  const [filter, setFilter] = useState<typeof FILTERS[number]['key']>('all')
  const [query, setQuery] = useState('')
  const [menuHits, setMenuHits] = useState<MenuHit[]>([])
  const [searching, setSearching] = useState(false)
  const reduceMotion = useReducedMotion()
  const lastCurious = useRef(0)

  const { openCount, total } = useKitchens()
  const world = useWorld()

  const list = concepts.length > 0 ? concepts : FALLBACK_CONCEPTS

  // Debounced cross-menu search. Only fires when there's a query — otherwise
  // we leave the static brand grid alone. A search that finds nothing (or
  // can't reach the kitchen) makes the crowd look concerned.
  useEffect(() => {
    const q = query.trim()
    if (q.length < 2) { setMenuHits([]); setSearching(false); return }
    setSearching(true)
    const ctrl = new AbortController()
    const t = setTimeout(() => {
      fetch(`${API_URL}/api/v1/storefront/search?q=${encodeURIComponent(q)}`, { signal: ctrl.signal })
        .then((r) => r.ok ? r.json() : { items: [] })
        .then((d: { items?: MenuHit[] }) => {
          const items = d.items ?? []
          setMenuHits(items)
          trackSearch(q, items.length)
          if (items.length === 0) emitCrowd({ type: 'react', mood: 'concerned' })
        })
        .catch(() => {
          if (ctrl.signal.aborted) return
          setMenuHits([])
          emitCrowd({ type: 'react', mood: 'concerned' })
        })
        .finally(() => { if (!ctrl.signal.aborted) setSearching(false) })
    }, 250)
    return () => { ctrl.abort(); clearTimeout(t) }
  }, [query])

  function onType(v: string) {
    setQuery(v)
    const now = Date.now()
    if (v.trim() && now - lastCurious.current > CURIOUS_EVERY_MS) {
      lastCurious.current = now
      emitCrowd({ type: 'react', mood: 'curious' })
    }
  }

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return list.filter((c) => {
      if (filter !== 'all' && c.type !== filter) return false
      if (!q) return true
      return (
        c.name.toLowerCase().includes(q) ||
        c.slug.toLowerCase().includes(q) ||
        (c.description ?? '').toLowerCase().includes(q)
      )
    })
  }, [list, filter, query])

  const trimmedQuery = query.trim()
  const isSearchingDishes = trimmedQuery.length >= 2
  const hasFilters = filter !== 'all' || trimmedQuery.length > 0
  const kitchenCount = list.length

  const liveMessage = isSearchingDishes
    ? (searching
        ? 'Searching…'
        : `${menuHits.length} dish${menuHits.length === 1 ? '' : 'es'} and ${filtered.length} brand${filtered.length === 1 ? '' : 's'} found for "${trimmedQuery}"`)
    : `${filtered.length} brand${filtered.length === 1 ? '' : 's'} shown`

  function clearAll() {
    setFilter('all')
    setQuery('')
  }

  const noMatch = emptyLine('no-match')
  const noKitchens = emptyLine('no-kitchens')
  // Dishes found but no brand matched the words: the dishes are the answer,
  // so don't follow them with a "nothing here" block.
  const showEmpty = filtered.length === 0 && !(isSearchingDishes && menuHits.length > 0)

  return (
    <div className={s.page}>

      {/* Header — the day-part sky, same world as the home hero */}
      <section className={s.header}>
        <Doodles />
        <div className={s.headerInner}>
          <p className={s.eyebrow}>Every kitchen</p>
          <h1 className={s.title}>
            <BouncyWords text="Pick your craving." />
            <span className={s.titleTail}>
              {kitchenCount} kitchen{kitchenCount === 1 ? '' : 's'}.
              <svg aria-hidden className={s.underline} viewBox="0 0 220 20" preserveAspectRatio="none">
                <path d="M4 14 C 44 4, 88 18, 132 9 S 204 6, 216 12" />
              </svg>
            </span>
          </h1>
          <p className={s.liveLine}>
            <span aria-hidden className={s.liveDot} data-open={openCount > 0 ? '1' : '0'} />
            {openCountLine(openCount, total, world.dayPart)}
          </p>
          <p className={s.lead}>
            One app, one delivery bag. Mix and match — pick from one, two, or all of them, and we figure out the timing.
          </p>

          <div className={s.searchWrap} role="search">
            <Search aria-hidden size={18} className={s.searchIcon} />
            <label htmlFor="browse-search" className={s.srOnly}>Search brands, cuisines, dishes</label>
            <input
              id="browse-search"
              type="text"
              value={query}
              onChange={(e) => onType(e.target.value)}
              placeholder="Search brands, cuisines, dishes…"
              className={s.searchInput}
            />
            {query.length > 0 && (
              <button
                type="button"
                aria-label="Clear search"
                className={s.clearBtn}
                onClick={() => setQuery('')}
              >
                <X aria-hidden size={18} />
              </button>
            )}
          </div>

          <div role="group" aria-label="Filter by service type" className={s.chips}>
            {FILTERS.map((f) => {
              const active = filter === f.key
              return (
                <motion.button
                  key={f.key}
                  type="button"
                  aria-pressed={active}
                  className={`${s.chip} ${active ? s.chipActive : ''}`}
                  whileTap={reduceMotion ? undefined : { scale: 0.92 }}
                  onClick={() => { setFilter(f.key); trackFilterApplied('browse_type', f.key) }}
                >
                  {f.label}
                </motion.button>
              )
            })}
          </div>
        </div>
      </section>

      {/* Polite live region — announces result counts without duplicating
          the visible headings below. */}
      <p aria-live="polite" className={s.srOnly}>{liveMessage}</p>

      {/* Menu hits — only when typing */}
      {isSearchingDishes && (
        <section className={s.hitsSection}>
          <div className={s.inner}>
            <h2 className={s.sectionLabel}>
              {searching ? 'Searching dishes…' : `${menuHits.length} dish${menuHits.length === 1 ? '' : 'es'} matching "${trimmedQuery}"`}
            </h2>
            {menuHits.length > 0 && (
              <div className={s.hitsGrid}>
                {menuHits.map((hit) => {
                  const fmt = (c: number) => `PKR ${(c / 100).toLocaleString('en-PK', { maximumFractionDigits: 0 })}`
                  return (
                    <Link
                      key={hit.id}
                      href={`/${hit.concept.slug}`}
                      aria-label={`${hit.name} from ${formatBrandName(hit.concept.name)}`}
                      className={s.hitCard}
                    >
                      <div
                        className={s.hitThumb}
                        aria-hidden
                        style={{
                          background: hit.imageUrl
                            ? `url(${hit.imageUrl}) center/cover`
                            : `linear-gradient(135deg, ${hit.concept.primaryColor ?? 'var(--party-plum)'} 0%, var(--party-cream) 200%)`,
                        }}
                      />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <p className={s.hitConcept}>{formatBrandName(hit.concept.name)}</p>
                        <p className={s.hitName}>{hit.name}</p>
                        <p className={s.hitPrice}>{fmt(hit.priceCents)}</p>
                      </div>
                    </Link>
                  )
                })}
              </div>
            )}
          </div>
        </section>
      )}

      {/* Grid */}
      <section className={s.gridSection}>
        <div className={s.inner}>
          {isSearchingDishes && filtered.length > 0 && (
            <h2 className={s.sectionLabel}>Brands matching "{trimmedQuery}"</h2>
          )}
          {filtered.length > 0 ? (
            <div className={s.grid}>
              {filtered.map((c, i) => (
                <Reveal key={c.id} index={i}>
                  <BrowseCard concept={c} index={i} />
                </Reveal>
              ))}
            </div>
          ) : showEmpty ? (
            list.length > 0 ? (
              // (a) there are kitchens, the filters just hid them all
              <div className={s.empty}>
                <CrowdCameo kind="fries" pose="worried" size={104} className={s.emptyCameo} />
                <p className={s.emptyTitle}>{noMatch.title}</p>
                <p className={s.emptyBody}>{noMatch.body}</p>
                {hasFilters && (
                  <button type="button" onClick={clearAll} className={s.clearAllBtn}>
                    {filter !== 'all' ? 'Clear filters' : 'Clear search'}
                  </button>
                )}
              </div>
            ) : (
              // (b) no kitchens at all — unreachable with the fallbacks, kept graceful
              <div className={s.empty}>
                <CrowdCameo kind="coffee" pose="sleep" size={104} className={s.emptyCameo} />
                <p className={s.emptyTitle}>{noKitchens.title}</p>
                <p className={s.emptyBody}>{noKitchens.body}</p>
              </div>
            )
          ) : null}
        </div>
      </section>
    </div>
  )
}
