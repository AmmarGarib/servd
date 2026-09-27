'use client'
import Link from 'next/link'
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent as ReactMouseEvent } from 'react'
import { AnimatePresence, animate, motion, type Variants } from 'framer-motion'
import { Search, X } from 'lucide-react'
import type { Concept } from '../../lib/concept'
import { formatBrandName } from '../../lib/concept'
import { trackSearch, trackFilterApplied, track } from '../../lib/analytics'
import { buzz, celebrate, collect, sfx, usePlay, usePrefersReducedMotion } from '@/lib/play'
import { emitCrowd } from '@/components/characters/crowdBus'
import { BrowseCard } from '../../components/party/browse/BrowseCard'
import { Doodles } from '../../components/party/browse/Doodles'
import { LuckyPull } from '../../components/party/browse/LuckyPull'
import { Stamps } from '../../components/party/browse/Stamps'
import s from '../../components/party/browse/browse.module.css'

const API_URL = process.env['NEXT_PUBLIC_API_URL'] ?? 'http://localhost:3001'

const FILTERS = [
  { key: 'all',        label: 'All' },
  { key: 'restaurant', label: 'Dine-in' },
  { key: 'digital',    label: 'Delivery' },
  { key: 'cart',       label: 'Walk-up' },
] as const

type FilterKey = typeof FILTERS[number]['key']

// The first line is the house line; from the third miss in a row the empty
// state rotates through all three.
const MISS_LINES = [
  'No brands match — try another craving.',
  'Still nothing. Even the fork is shrugging.',
  'Nothing again. Try fewer letters — or pull the lever.',
] as const

/** Roulette: this many hops, each slower than the last (60ms → 400ms). */
const HOPS = 8

interface Props {
  concepts: Concept[]
}

interface MenuHit {
  id: string; name: string; description: string | null; priceCents: number; imageUrl: string | null
  concept: { name: string; slug: string; primaryColor: string | null }
}

type Ring = { id: string; landed: boolean } | null

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

/** Fork-and-knife sticker for the empty state. It shrugs on every miss. */
function ShrugSticker() {
  return (
    <svg aria-hidden focusable="false" viewBox="0 0 72 72" className={s.emptySticker}>
      <circle cx="36" cy="36" r="31" className={s.emptyStickerBand} />
      <circle cx="36" cy="36" r="25" className={s.emptyStickerFace} />
      {/* fork */}
      <path className={s.emptyStickerInk} d="M27 20 v10 M31 20 v10 M35 20 v10 M27 30 c0 4 8 4 8 0 M31 34 v19" />
      {/* knife */}
      <path className={s.emptyStickerFill} d="M44 20 c5 3 6 11 3 17 h-3 z" />
      <path className={s.emptyStickerInk} d="M44 20 c5 3 6 11 3 17 h-3 z M45.5 37 v16" />
    </svg>
  )
}

function SkeletonCards() {
  return (
    <div className={s.grid} aria-hidden>
      {[0, 1, 2].map((i) => (
        <div key={i} className={s.cardWrap}>
          <div className={s.skelCard} style={{ '--i': i } as CSSProperties}>
            <div className={s.skelPhoto} />
            <div className={s.skelBody}>
              <span className={s.skelLine} style={{ width: '46%' }} />
              <span className={s.skelLine} />
              <span className={s.skelLine} style={{ width: '72%' }} />
              <span className={s.skelPill} />
            </div>
          </div>
        </div>
      ))}
    </div>
  )
}

export function BrowseClient({ concepts }: Props) {
  const [filter, setFilter] = useState<FilterKey>('all')
  const [query, setQuery] = useState('')
  const [menuHits, setMenuHits] = useState<MenuHit[]>([])
  const [searching, setSearching] = useState(false)
  const reduceMotion = usePrefersReducedMotion()

  // ── Concepts: never show "0 kitchens" off one failed server fetch ───────
  // If the server render came back empty (API blip), try once more from the
  // browser before admitting there's nothing. Same handling as page.tsx.
  const [list, setList] = useState<Concept[]>(concepts)
  const [loading, setLoading] = useState(concepts.length === 0)
  useEffect(() => {
    if (concepts.length > 0) { setList(concepts); setLoading(false); return }
    const ctrl = new AbortController()
    setLoading(true)
    fetch(`${API_URL}/api/v1/storefront/concepts`, { cache: 'no-store', signal: ctrl.signal })
      .then((r) => (r.ok ? r.json() : []))
      .then((d: unknown) => { if (!ctrl.signal.aborted) setList(Array.isArray(d) ? (d as Concept[]) : []) })
      .catch(() => { /* stays empty — the empty state explains */ })
      .finally(() => { if (!ctrl.signal.aborted) setLoading(false) })
    return () => ctrl.abort()
  }, [concepts])

  // Debounced cross-menu search. Only fires when there's a query — otherwise
  // we leave the static brand grid alone.
  useEffect(() => {
    const q = query.trim()
    if (q.length < 2) { setMenuHits([]); setSearching(false); return }
    setSearching(true)
    const ctrl = new AbortController()
    const t = setTimeout(() => {
      fetch(`${API_URL}/api/v1/storefront/search?q=${encodeURIComponent(q)}`, { signal: ctrl.signal })
        .then((r) => r.ok ? r.json() : { items: [] })
        .then((d: { items: MenuHit[] }) => { setMenuHits(d.items ?? []); trackSearch(q, d.items?.length ?? 0) })
        .catch(() => { /* ignore — falls back to no menu hits */ })
        .finally(() => setSearching(false))
    }, 250)
    return () => { ctrl.abort(); clearTimeout(t) }
  }, [query])

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

  // ── Consecutive misses (a settled filter/query that finds nothing) ──────
  const [misses, setMisses] = useState(0)
  const filteredCount = filtered.length
  useEffect(() => {
    if (loading || list.length === 0) return
    const t = setTimeout(() => setMisses((m) => (filteredCount === 0 ? m + 1 : 0)), 450)
    return () => clearTimeout(t)
  }, [filter, trimmedQuery, filteredCount, loading, list.length])
  const missLine = MISS_LINES[misses < 3 ? 0 : (misses - 2) % MISS_LINES.length] ?? MISS_LINES[0]

  // ── Lucky pull ──────────────────────────────────────────────────────────
  const [ring, setRing] = useState<Ring>(null)
  const [rolling, setRolling] = useState(false)
  const [luckyMsg, setLuckyMsg] = useState('')
  const timers = useRef<number[]>([])
  const hostRefs = useRef(new Map<string, HTMLDivElement>())
  const lastLanded = useRef<string | null>(null)
  const keepRingOnce = useRef(false)

  const clearTimers = useCallback(() => {
    timers.current.forEach((t) => window.clearTimeout(t))
    timers.current = []
  }, [])
  useEffect(() => clearTimers, [clearTimers])

  // A new filter or query clears the old pick (unless the lever did it).
  useEffect(() => {
    if (keepRingOnce.current) { keepRingOnce.current = false; return }
    clearTimers()
    setRolling(false)
    setRing(null)
  }, [filter, query, clearTimers])

  const later = (fn: () => void, ms: number) => { timers.current.push(window.setTimeout(fn, ms)) }

  function land(pick: Concept, attempt = 0) {
    setRing({ id: pick.id, landed: true })
    setRolling(false)
    lastLanded.current = pick.id
    // Let the ring paint (and any card that is still entering mount) first.
    later(() => {
      const el = hostRefs.current.get(pick.id)
      if (!el) {
        if (attempt < 3) later(() => land(pick, attempt + 1), 120)
        else setRing(null)
        return
      }
      const name = formatBrandName(pick.name)
      setLuckyMsg(`Feeling lucky: ${name}. A "go to ${name}" link is on its card.`)
      el.scrollIntoView({ block: 'center', behavior: reduceMotion ? 'auto' : 'smooth' })
      if (!reduceMotion) {
        el.animate(
          [
            { transform: 'scale(1)' },
            { transform: 'scale(1.08)', offset: 0.35 },
            { transform: 'scale(0.98)', offset: 0.7 },
            { transform: 'scale(1)' },
          ],
          { duration: 420, easing: 'cubic-bezier(0.34, 1.56, 0.64, 1)' },
        )
      }
      buzz(15)
      // Wait for the smooth scroll to settle so the burst sits on the card.
      later(() => {
        const r = el.getBoundingClientRect()
        const at = { x: r.left + r.width / 2, y: r.top + r.height / 2 }
        celebrate({ ...at, power: 'small', palette: 'servd' }).catch(() => { /* cosmetic */ })
        collect('lucky-pull', at)
        emitCrowd({ type: 'cheer' })
      }, reduceMotion ? 0 : 440)
    }, attempt === 0 ? 30 : 0)
  }

  function pull() {
    if (rolling || list.length === 0) return
    let pool = filtered
    if (pool.length === 0) {
      // Nothing matches — the lever clears the board and picks from everything.
      keepRingOnce.current = true
      setFilter('all')
      setQuery('')
      pool = list
    }
    clearTimers()
    setLuckyMsg('')
    let target = Math.floor(Math.random() * pool.length)
    if (pool.length > 1 && pool[target]?.id === lastLanded.current) {
      target = (target + 1 + Math.floor(Math.random() * (pool.length - 1))) % pool.length
    }
    const pick = pool[target]
    if (!pick) return

    if (reduceMotion || pool.length === 1) { land(pick); return }

    // Hop the ring across the cards, slowing down (ease-out), and finish on
    // the pick. Starting HOPS-1 cards "behind" it lands it exactly.
    setRolling(true)
    const n = pool.length
    let t = 0
    for (let k = 0; k < HOPS; k++) {
      const idx = (((target - (HOPS - 1 - k)) % n) + n) % n
      const hop = pool[idx]
      if (!hop) continue
      if (k === HOPS - 1) later(() => land(pick), t)
      else later(() => { setRing({ id: hop.id, landed: false }); sfx('pop') }, t)
      const f = k / (HOPS - 2)
      t += 60 + 340 * f * f
    }
  }

  // ── Handlers ────────────────────────────────────────────────────────────
  function clearAll() {
    setFilter('all')
    setQuery('')
    emitCrowd({ type: 'cheer' })
  }

  function thunk(e: ReactMouseEvent<HTMLButtonElement>) {
    if (reduceMotion) return
    sfx('thunk')
    animate(e.currentTarget, { scaleY: [0.85, 1.08, 1], scaleX: [1.06, 0.97, 1] }, { duration: 0.38, ease: 'easeOut' })
  }

  const liveMessage = loading
    ? 'Loading kitchens…'
    : isSearchingDishes
      ? (searching
          ? 'Searching…'
          : `${menuHits.length} dish${menuHits.length === 1 ? '' : 'es'} and ${filtered.length} brand${filtered.length === 1 ? '' : 's'} found for "${trimmedQuery}"`)
      : `${filtered.length} brand${filtered.length === 1 ? '' : 's'} shown`

  const cardVariants: Variants = reduceMotion
    ? {
        enter: { opacity: 0 },
        shown: { opacity: 1, transition: { duration: 0.12 } },
        exit: { opacity: 0, transition: { duration: 0.12 } },
      }
    : {
        enter: { opacity: 0, scale: 1.08, y: 12 },
        shown: (i: number) => ({
          opacity: 1, scale: 1, y: 0, rotate: 0,
          transition: { type: 'spring', stiffness: 520, damping: 18, delay: i * 0.04 },
        }),
        exit: (i: number) => ({
          opacity: 0, scale: 0.8, rotate: i % 2 ? 8 : -8,
          transition: { duration: 0.2, ease: 'easeIn' },
        }),
      }

  const markAndTrack = (slug: string) => {
    track('concept_switched', { slug })
    try { usePlay.getState().markKitchen(slug) } catch { /* cosmetic */ }
  }

  return (
    <div className={s.page}>

      {/* Header — butter stage, same energy as the home hero */}
      <section className={s.header}>
        <Doodles />
        <div className={s.headerInner}>
          <p className={s.eyebrow}>Every kitchen</p>
          <div className={s.titleRow}>
            <h1 className={s.title}>
              <BouncyWords text="Pick your craving." />
              <span className={s.titleTail}>
                {loading ? (
                  <>
                    <span aria-hidden className={s.countShimmer} />
                    <span className={s.srOnly}>Loading</span> kitchens.
                  </>
                ) : list.length > 0 ? (
                  <>{list.length} kitchen{list.length === 1 ? '' : 's'}.</>
                ) : (
                  <>kitchens warming up.</>
                )}
                <svg aria-hidden className={s.underline} viewBox="0 0 220 20" preserveAspectRatio="none">
                  <path d="M4 14 C 44 4, 88 18, 132 9 S 204 6, 216 12" />
                </svg>
              </span>
            </h1>
            <Stamps />
          </div>
          <p className={s.lead}>
            One app, one delivery bag. Mix and match — pick from one, two, or all of them, and we figure out the timing.
          </p>

          <div className={s.searchRow}>
            <div className={s.searchWrap} role="search">
              <Search aria-hidden size={18} className={s.searchIcon} />
              <label htmlFor="browse-search" className={s.srOnly}>Search brands, cuisines, dishes</label>
              <input
                id="browse-search"
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
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
            <LuckyPull onPull={pull} busy={rolling} disabled={loading || list.length === 0} />
          </div>

          <div role="group" aria-label="Filter by service type" className={s.chips}>
            {FILTERS.map((f) => {
              const active = filter === f.key
              return (
                <button
                  key={f.key}
                  type="button"
                  aria-pressed={active}
                  className={`${s.chip} ${active ? s.chipActive : ''}`}
                  onClick={(e) => { thunk(e); setFilter(f.key); trackFilterApplied('browse_type', f.key) }}
                >
                  {f.label}
                </button>
              )
            })}
          </div>
        </div>
      </section>

      {/* Polite live regions — result counts, and where the lever landed. */}
      <p aria-live="polite" className={s.srOnly}>{liveMessage}</p>
      <p aria-live="polite" className={s.srOnly}>{luckyMsg}</p>

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
      <section className={s.gridSection} aria-busy={loading || undefined}>
        <div className={s.inner}>
          {isSearchingDishes && filtered.length > 0 && (
            <h2 className={s.sectionLabel}>Brands matching "{trimmedQuery}"</h2>
          )}
          {loading ? (
            <SkeletonCards />
          ) : filtered.length === 0 ? (
            <div className={s.empty}>
              <span key={misses} className={s.emptyShrug}><ShrugSticker /></span>
              <p className={s.emptyTitle}>{missLine}</p>
              {list.length > 0 && (
                <button type="button" onClick={clearAll} className={s.clearAllBtn}>Clear filters</button>
              )}
            </div>
          ) : (
            <div className={s.grid}>
              <AnimatePresence mode="popLayout">
                {filtered.map((c, i) => {
                  const ringState = ring?.id === c.id ? (ring.landed ? 'landed' : 'on') : undefined
                  const name = formatBrandName(c.name)
                  return (
                    <motion.div
                      key={c.id}
                      layout={!reduceMotion}
                      className={s.cardWrap}
                      custom={i}
                      variants={cardVariants}
                      initial="enter"
                      animate="shown"
                      exit="exit"
                      transition={{ layout: { type: 'spring', stiffness: 260, damping: 22 } }}
                    >
                      <div
                        ref={(el) => { if (el) hostRefs.current.set(c.id, el); else hostRefs.current.delete(c.id) }}
                        className={s.lucky}
                        data-ring={ringState}
                      >
                        <BrowseCard concept={c} />
                        {ringState === 'landed' && (
                          <Link
                            href={`/brand/${c.slug}`}
                            className={s.luckyChip}
                            onClick={() => markAndTrack(c.slug)}
                          >
                            go to {name} <span aria-hidden>→</span>
                          </Link>
                        )}
                      </div>
                    </motion.div>
                  )
                })}
              </AnimatePresence>
            </div>
          )}
        </div>
      </section>
    </div>
  )
}
