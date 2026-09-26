'use client'
import Link from 'next/link'
import { useEffect, useMemo, useState, type CSSProperties } from 'react'
import { motion, useReducedMotion } from 'framer-motion'
import { Search, X, UtensilsCrossed } from 'lucide-react'
import type { Concept } from '../../lib/concept'
import { formatBrandName } from '../../lib/concept'
import { trackSearch, trackFilterApplied, track } from '../../lib/analytics'
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

export function BrowseClient({ concepts }: Props) {
  const [filter, setFilter] = useState<typeof FILTERS[number]['key']>('all')
  const [query, setQuery] = useState('')
  const [menuHits, setMenuHits] = useState<MenuHit[]>([])
  const [searching, setSearching] = useState(false)
  const reduceMotion = useReducedMotion()

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

  return (
    <div className={s.page}>

      {/* Header — butter stage, same energy as the home hero */}
      <section className={s.header}>
        <Doodles />
        <div className={s.headerInner}>
          <p className={s.eyebrow}>Every kitchen</p>
          <h1 className={s.title}>
            <BouncyWords text="Pick your craving." />
            <span className={s.titleTail}>
              {concepts.length} kitchen{concepts.length === 1 ? '' : 's'}.
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
          {filtered.length === 0 ? (
            <div className={s.empty}>
              <UtensilsCrossed aria-hidden size={40} className={s.emptyIcon} />
              <p className={s.emptyTitle}>No brands match — try another craving.</p>
              <button type="button" onClick={clearAll} className={s.clearAllBtn}>Clear filters</button>
            </div>
          ) : (
            <div className={s.grid}>
              {filtered.map((c, i) => (
                <motion.div
                  key={c.id}
                  className={s.cardWrap}
                  initial={reduceMotion ? false : { opacity: 0, y: 26 }}
                  whileInView={{ opacity: 1, y: 0 }}
                  viewport={{ once: true, margin: '0px 0px -80px 0px' }}
                  transition={{ type: 'spring', stiffness: 220, damping: 20, delay: reduceMotion ? 0 : (i % 6) * 0.06 }}
                >
                  <BrowseCard concept={c} />
                </motion.div>
              ))}
            </div>
          )}
        </div>
      </section>
    </div>
  )
}
