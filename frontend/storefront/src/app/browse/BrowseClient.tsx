'use client'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { AnimatePresence, LayoutGroup, motion, useReducedMotion } from 'framer-motion'
import { Search, X } from 'lucide-react'
import type { Concept } from '../../lib/concept'
import { formatBrandName } from '../../lib/concept'
import { trackSearch, trackFilterApplied } from '../../lib/analytics'
import { SPRING } from '../../lib/tactile'
import { HopDots } from '../../components/tactile/HopDots'
import { CrowdPoster } from '../../components/characters/CrowdPoster'
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

type FilterKey = typeof FILTERS[number]['key']

// The chip press: an explicit rubber spring, a touch bouncier than the kit's
// release so small targets feel like they give.
const CHIP_TAP = { scale: 0.9, transition: { type: 'spring', stiffness: 500, damping: 15 } } as const
const CHIP_SLIDE = { type: 'spring', stiffness: 460, damping: 32 } as const

interface Props {
  concepts: Concept[]
}

interface MenuHit {
  id: string; name: string; description: string | null; priceCents: number; imageUrl: string | null
  concept: { name: string; slug: string; primaryColor: string | null }
}

// Each word drops in on its own beat, matching the home hero's headline
// motion (see components/party/PartyHero.tsx BouncyWords).
function BouncyWords({ text, start = 0 }: { text: string; start?: number }) {
  return (
    <>
      {text.split(' ').map((w, i) => (
        <span key={`${w}-${i}`} className={s.titleWord} style={{ '--i': start + i } as CSSProperties}>
          {w}
        </span>
      ))}
    </>
  )
}

// The live kitchen count. Each change rolls the number like a counter wheel:
// up when the count grows, down when it shrinks.
function RollingCount({ value, reduce }: { value: number; reduce: boolean }) {
  const prev = useRef(value)
  const dir = value >= prev.current ? 1 : -1
  useEffect(() => { prev.current = value }, [value])
  if (reduce) return <span className={s.rollBox}><span>{value}</span></span>
  return (
    <span className={s.rollBox}>
      <AnimatePresence initial={false} custom={dir}>
        <motion.span
          key={value}
          className={s.rollDigit}
          custom={dir}
          variants={{
            enter: (d: number) => ({ y: d > 0 ? '-95%' : '95%', opacity: 0 }),
            center: { y: '0%', opacity: 1 },
            exit: (d: number) => ({ y: d > 0 ? '95%' : '-95%', opacity: 0 }),
          }}
          initial="enter"
          animate="center"
          exit="exit"
          transition={SPRING.pop}
        >
          {value}
        </motion.span>
      </AnimatePresence>
    </span>
  )
}

function Underline() {
  return (
    <svg aria-hidden className={s.underline} viewBox="0 0 220 20" preserveAspectRatio="none">
      <path d="M4 14 C 44 4, 88 18, 132 9 S 204 6, 216 12" />
    </svg>
  )
}

export function BrowseClient({ concepts }: Props) {
  const router = useRouter()
  const [filter, setFilter] = useState<FilterKey>('all')
  const [query, setQuery] = useState('')
  const [menuHits, setMenuHits] = useState<MenuHit[]>([])
  const [searching, setSearching] = useState(false)
  const reduceMotion = useReducedMotion() ?? false

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
    return concepts.filter((c) => {
      if (filter !== 'all' && c.type !== filter) return false
      if (!q) return true
      return (
        c.name.toLowerCase().includes(q) ||
        c.slug.toLowerCase().includes(q) ||
        (c.description ?? '').toLowerCase().includes(q)
      )
    })
  }, [concepts, filter, query])

  const trimmedQuery = query.trim()
  const isSearchingDishes = trimmedQuery.length >= 2
  const count = filtered.length

  // While searching, HopDots carries its own status announcement, so the live
  // region stays quiet instead of announcing twice.
  const liveMessage = isSearchingDishes
    ? (searching
        ? ''
        : `${menuHits.length} dish${menuHits.length === 1 ? '' : 'es'} and ${count} brand${count === 1 ? '' : 's'} found for "${trimmedQuery}"`)
    : `${count} brand${count === 1 ? '' : 's'} shown`

  function clearAll() {
    setFilter('all')
    setQuery('')
  }

  // No kitchens at all (the API blinked) is a different story from "your
  // filters hid them all" — say so, and offer a retry instead of a reset.
  const noKitchens = concepts.length === 0

  return (
    <div className={s.page}>

      {/* Header — butter stage, same energy as the home hero */}
      <section className={s.header}>
        <Doodles punchKey={filter} />
        <div className={s.headerInner}>
          <p className={s.eyebrow}>Every kitchen</p>
          <h1 className={s.title}>
            <BouncyWords text="Pick your craving." />
            <span className={s.titleTail} style={{ '--i': 3 } as CSSProperties}>
              {count === 0 ? (
                <>every kitchen.</>
              ) : (
                <>
                  <RollingCount value={count} reduce={reduceMotion} />
                  {' '}kitchen{count === 1 ? '' : 's'}.
                </>
              )}
              <Underline />
            </span>
          </h1>
          <p className={s.lead}>
            One app, one delivery bag. Mix and match — pick from one, two, or all of them, and we figure out the timing.
          </p>

          <div className={s.searchWrap} role="search">
            <Search
              aria-hidden
              size={18}
              className={`${s.searchIcon} ${searching ? s.searchIconBusy : ''}`}
            />
            <label htmlFor="browse-search" className={s.srOnly}>Search brands, cuisines, dishes</label>
            <input
              id="browse-search"
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search brands, cuisines, dishes…"
              className={s.searchInput}
            />
            <AnimatePresence initial={false}>
              {query.length > 0 && (
                <motion.button
                  key="clear"
                  type="button"
                  aria-label="Clear search"
                  className={s.clearBtn}
                  onClick={() => setQuery('')}
                  initial={reduceMotion ? { opacity: 0 } : { scale: 0, rotate: -90 }}
                  animate={reduceMotion ? { opacity: 1 } : { scale: 1, rotate: 0 }}
                  exit={reduceMotion ? { opacity: 0 } : { scale: 0, rotate: 90 }}
                  transition={reduceMotion ? { duration: 0.12 } : SPRING.pop}
                  whileHover={reduceMotion ? undefined : { scale: 1.08 }}
                  whileTap={reduceMotion ? undefined : { scale: 0.88 }}
                >
                  <X aria-hidden size={18} />
                </motion.button>
              )}
            </AnimatePresence>
          </div>

          <LayoutGroup id="browse-chips">
            <div role="group" aria-label="Filter by service type" className={s.chips}>
              {FILTERS.map((f) => {
                const active = filter === f.key
                return (
                  <motion.button
                    key={f.key}
                    type="button"
                    aria-pressed={active}
                    className={`${s.chip} ${active ? s.chipActive : ''}`}
                    whileHover={reduceMotion ? undefined : { y: -2 }}
                    whileTap={reduceMotion ? undefined : CHIP_TAP}
                    animate={reduceMotion ? undefined : (active ? { scale: [null, 1.1, 1] } : { scale: 1 })}
                    transition={{ duration: 0.36, ease: 'easeOut' }}
                    onClick={() => { setFilter(f.key); trackFilterApplied('browse_type', f.key) }}
                  >
                    {active && (
                      <motion.span
                        layoutId="chipActive"
                        aria-hidden
                        className={s.chipFill}
                        transition={reduceMotion ? { duration: 0 } : CHIP_SLIDE}
                      />
                    )}
                    <span className={s.chipLabel}>{f.label}</span>
                  </motion.button>
                )
              })}
            </div>
          </LayoutGroup>
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
              {searching
                ? <HopDots label="Searching dishes" size={8} gap={6} color="var(--party-plum, #4E2A4F)" />
                : `${menuHits.length} dish${menuHits.length === 1 ? '' : 'es'} matching "${trimmedQuery}"`}
            </h2>
            {searching ? (
              <div className={s.hitsGrid} aria-hidden>
                {[0, 1, 2].map((i) => (
                  <div key={i} className={`${s.hitCard} ${s.hitSkeleton}`}>
                    <span className={`${s.hitThumb} ${s.skel}`} />
                    <span className={s.skelLines}>
                      <span className={s.skel} style={{ width: '38%', height: 9 }} />
                      <span className={s.skel} style={{ width: '78%', height: 13 }} />
                      <span className={s.skel} style={{ width: '30%', height: 11 }} />
                    </span>
                  </div>
                ))}
              </div>
            ) : menuHits.length > 0 && (
              <div className={s.hitsGrid}>
                {menuHits.map((hit, i) => {
                  const fmt = (c: number) => `PKR ${(c / 100).toLocaleString('en-PK', { maximumFractionDigits: 0 })}`
                  return (
                    <motion.div
                      key={hit.id}
                      className={s.hitWrap}
                      initial={reduceMotion ? false : { opacity: 0, y: 12 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={reduceMotion ? { duration: 0 } : { ...SPRING.settle, delay: Math.min(i, 12) * 0.035 }}
                    >
                      <Link
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
                    </motion.div>
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
          {isSearchingDishes && count > 0 && (
            <h2 className={s.sectionLabel}>Brands matching &ldquo;{trimmedQuery}&rdquo;</h2>
          )}
          {count === 0 ? (
            <motion.div
              key={noKitchens ? 'none' : 'filtered'}
              className={s.empty}
              initial={reduceMotion ? { opacity: 0 } : { opacity: 0, y: 24, scale: 0.94 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              transition={reduceMotion ? { duration: 0.15 } : SPRING.pop}
            >
              <div className={s.emptyStage}>
                <CrowdPoster cast={['fries', 'coffee']} mode="shrug" />
              </div>
              <p className={s.emptyTitle}>
                {noKitchens ? 'The kitchens are still waking up.' : 'No brands match — try another craving.'}
              </p>
              {noKitchens && (
                <p className={s.emptySub}>Give it a moment and try again.</p>
              )}
              <span className="t-pop-in" style={{ display: 'inline-flex', animationDelay: '180ms' }}>
                {noKitchens ? (
                  <button type="button" onClick={() => router.refresh()} className={s.clearAllBtn}>Try again</button>
                ) : (
                  <button type="button" onClick={clearAll} className={s.clearAllBtn}>Clear filters</button>
                )}
              </span>
            </motion.div>
          ) : (
            <div className={s.grid}>
              {filtered.map((c, i) => (
                <motion.div
                  key={c.id}
                  className={s.cardWrap}
                  // Stickers dropped by hand: each lands from a slightly
                  // different height and angle, alternating left and right.
                  initial={reduceMotion ? false : { opacity: 0.35, y: 20 + (i % 3) * 5, rotate: i % 2 === 0 ? -3 : 3 }}
                  whileInView={{ opacity: 1, y: 0, rotate: 0 }}
                  viewport={{ once: true, amount: 0.15 }}
                  transition={{ type: 'spring', stiffness: 220, damping: 18, delay: reduceMotion ? 0 : (i % 6) * 0.06 }}
                >
                  <BrowseCard concept={c} index={i} />
                </motion.div>
              ))}
            </div>
          )}
        </div>
      </section>
    </div>
  )
}
