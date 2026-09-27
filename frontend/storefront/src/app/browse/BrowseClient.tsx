'use client'
import Link from 'next/link'
import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { Search, X } from 'lucide-react'
import type { Concept } from '../../lib/concept'
import { formatBrandName } from '../../lib/concept'
import { trackSearch, trackFilterApplied } from '../../lib/analytics'
import { DealtCard } from '../../components/party/browse/BrowseCard'
import { Doodles } from '../../components/party/browse/Doodles'
import { CrowdPoster } from '@/components/party/loader/CrowdPoster'
import { useScene, usePrefersReducedMotion, EASE_SETTLE } from '@/lib/film/motion'
import s from '../../components/party/browse/browse.module.css'

const API_URL = process.env['NEXT_PUBLIC_API_URL'] ?? 'http://localhost:3001'

const FILTERS = [
  { key: 'all',        label: 'All' },
  { key: 'restaurant', label: 'Dine-in' },
  { key: 'digital',    label: 'Delivery' },
  { key: 'cart',       label: 'Walk-up' },
] as const

// When the concepts API is down or empty, browse still lists the three live
// kitchens — mirroring HomeClient's FALLBACK_BRANDS. BrowseCard fills in the
// tagline (brandStory), photo (conceptHeroImage) and accent (brandAccent)
// from the slug, so these only need identity.
const FALLBACK_CONCEPTS: Concept[] = [
  { id: 'fallback-stackd', name: 'stackd', slug: 'stackd', type: 'restaurant', description: null, logoUrl: null, primaryColor: null },
  { id: 'fallback-simmer', name: 'simmer', slug: 'simmer', type: 'restaurant', description: null, logoUrl: null, primaryColor: null },
  { id: 'fallback-flipd',  name: 'Flipd',  slug: 'flipd',  type: 'restaurant', description: null, logoUrl: null, primaryColor: null },
]

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

export function BrowseClient({ concepts: live }: Props) {
  const concepts = live.length > 0 ? live : FALLBACK_CONCEPTS
  const [filter, setFilter] = useState<typeof FILTERS[number]['key']>('all')
  const [query, setQuery] = useState('')
  const [menuHits, setMenuHits] = useState<MenuHit[]>([])
  const [searching, setSearching] = useState(false)
  const reduceMotion = usePrefersReducedMotion()

  // The header's full traversal drives the doodles.
  const headerRef = useRef<HTMLElement>(null)
  const headerPass = useScene(headerRef, 'pass')

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

  const liveMessage = isSearchingDishes
    ? (searching
        ? 'Searching…'
        : `${menuHits.length} dish${menuHits.length === 1 ? '' : 'es'} and ${filtered.length} brand${filtered.length === 1 ? '' : 's'} found for "${trimmedQuery}"`)
    : `${filtered.length} brand${filtered.length === 1 ? '' : 's'} shown`

  function clearAll() {
    setFilter('all')
    setQuery('')
  }

  // Filter swap: the outgoing grid swipes left and blurs (180ms); the new
  // cards drop in (200ms each, 40ms apart). Instant under reduced motion.
  const gridExit = reduceMotion
    ? { opacity: 0, transition: { duration: 0 } }
    : { opacity: 0, x: -40, filter: 'blur(4px)', transition: { duration: 0.18, ease: EASE_SETTLE } }
  const dropIn = (i: number) => reduceMotion
    ? {}
    : {
        initial: { opacity: 0, y: -22 },
        animate: { opacity: 1, y: 0 },
        transition: { duration: 0.2, delay: Math.min(i, 8) * 0.04, ease: EASE_SETTLE },
      }

  const count = concepts.length

  return (
    <div className={s.page}>

      {/* Header — butter stage, same energy as the home hero */}
      <section ref={headerRef} className={s.header}>
        <Doodles progress={reduceMotion ? undefined : headerPass} />
        <div className={s.headerInner}>
          <p className={s.eyebrow}>Every kitchen</p>
          <h1 className={s.title}>
            <BouncyWords text="Pick your craving." />
            <span className={s.titleTail}>
              {count} kitchen{count === 1 ? '' : 's'}.
              <svg aria-hidden className={s.underline} viewBox="0 0 220 20" preserveAspectRatio="none">
                <path d="M4 14 C 44 4, 88 18, 132 9 S 204 6, 216 12" />
              </svg>
            </span>
          </h1>
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
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search brands, cuisines, dishes…"
              className={s.searchInput}
              autoComplete="off"
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

      {/* Menu hits — only when typing. Each hit is "plated in": scale
          0.92→1 and blur 6→0, 35ms apart, done inside 400ms. */}
      {isSearchingDishes && (
        <section className={s.hitsSection}>
          <div className={s.inner}>
            <h2 className={s.sectionLabel}>
              {searching ? 'Searching dishes…' : `${menuHits.length} dish${menuHits.length === 1 ? '' : 'es'} matching "${trimmedQuery}"`}
            </h2>
            {menuHits.length > 0 && (
              <div className={s.hitsGrid}>
                {menuHits.map((hit, i) => {
                  const fmt = (c: number) => `PKR ${(c / 100).toLocaleString('en-PK', { maximumFractionDigits: 0 })}`
                  return (
                    <motion.div
                      key={hit.id}
                      className={s.hitWrap}
                      initial={reduceMotion ? false : { opacity: 0.4, scale: 0.92, filter: 'blur(6px)' }}
                      animate={{ opacity: 1, scale: 1, filter: 'blur(0px)' }}
                      transition={{ duration: 0.2, delay: Math.min(i, 5) * 0.035, ease: EASE_SETTLE }}
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
                              : (hit.concept.primaryColor ?? 'var(--party-plum)'),
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
          {isSearchingDishes && filtered.length > 0 && (
            <h2 className={s.sectionLabel}>Brands matching &ldquo;{trimmedQuery}&rdquo;</h2>
          )}
          {filtered.length === 0 ? (
            <div className={s.empty}>
              <div className={s.emptyCast} aria-hidden>
                <CrowdPoster cast={['fries']} id="browse-empty" />
              </div>
              <p className={s.emptyTitle}>nobody here by that name. try another craving.</p>
              <button type="button" onClick={clearAll} className={s.clearAllBtn}>Clear filters</button>
            </div>
          ) : (
            <div className={s.gridStage}>
              <AnimatePresence mode="popLayout" initial={false}>
                <motion.div key={filter} className={s.grid} exit={gridExit}>
                  {filtered.map((c, i) => (
                    <motion.div key={c.id} style={{ height: '100%' }} {...dropIn(i)}>
                      <DealtCard concept={c} index={i} />
                    </motion.div>
                  ))}
                </motion.div>
              </AnimatePresence>
            </div>
          )}
        </div>
      </section>
    </div>
  )
}
