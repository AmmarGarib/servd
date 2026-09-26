'use client'
import Link from 'next/link'
import { useEffect, useMemo, useState } from 'react'
import { Search, X, SearchX, ArrowRight } from 'lucide-react'
import type { Concept } from '../../lib/concept'
import { typeLabel, conceptHeroImage, brandStory, formatBrandName } from '../../lib/concept'
import { isOpenNow } from '../../lib/hours'
import { trackSearch, trackFilterApplied, track } from '../../lib/analytics'
import { Reveal, RevealGroup, RevealItem } from '../../components/hub/motion'

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

const fmtPrice = (c: number) => `PKR ${(c / 100).toLocaleString('en-PK', { maximumFractionDigits: 0 })}`

export function BrowseClient({ concepts }: Props) {
  const [filter, setFilter] = useState<typeof FILTERS[number]['key']>('all')
  const [query, setQuery] = useState('')
  const [menuHits, setMenuHits] = useState<MenuHit[]>([])
  const [searching, setSearching] = useState(false)

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

  const isSearching = query.trim().length >= 2

  return (
    <div className="hub">

      {/* Header — grain + ambient glow, matches the hub hero language */}
      <section className="hub-section hub-grain" style={{ paddingBottom: 'clamp(2.5rem, 6vw, 3.5rem)', overflow: 'hidden' }}>
        <div aria-hidden="true" className="hub-glow" style={{ width: 480, height: 480, top: '-200px', left: '-140px', background: 'var(--hub-plum)', opacity: 0.55 }} />
        <div aria-hidden="true" className="hub-glow" style={{ width: 360, height: 360, bottom: '-160px', right: '-100px', background: 'var(--hub-lilac)', opacity: 0.16 }} />

        <div className="hub-container" style={{ position: 'relative', zIndex: 1 }}>
          <Reveal>
            <p className="hub-eyebrow hub-eyebrow--accent">Every kitchen</p>
            <h1 className="hub-display" style={{ fontSize: 'clamp(2.5rem, 7vw, 5rem)', margin: '0.75rem 0 1rem', maxWidth: '900px' }}>
              Pick your craving.<br />
              <em>{concepts.length} kitchens.</em>
            </h1>
            <p className="hub-lead">
              One app, one delivery bag. Mix and match — pick from one, two, or all of them, and we figure out the timing.
            </p>
          </Reveal>

          {/* Search + filters */}
          <Reveal delay={0.1} style={{ marginTop: '2.5rem', display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
            <div role="search">
              <label htmlFor="browse-search" className="sr-only">Search brands, cuisines, or dishes</label>
              <div style={{ position: 'relative', maxWidth: '36rem' }}>
                <Search
                  aria-hidden="true"
                  size={18}
                  style={{ position: 'absolute', left: '1.1rem', top: '50%', transform: 'translateY(-50%)', color: 'var(--hub-text-dim)', pointerEvents: 'none' }}
                />
                <input
                  id="browse-search"
                  type="text"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search brands, cuisines, dishes…"
                  style={{
                    width: '100%',
                    minHeight: '48px',
                    borderRadius: '14px',
                    border: '1px solid var(--hub-line-strong)',
                    background: 'var(--hub-surface)',
                    color: 'var(--hub-text)',
                    fontFamily: 'var(--hub-font-body)',
                    fontSize: '1rem',
                    padding: query ? '0.75rem 2.75rem' : '0.75rem 1.1rem 0.75rem 2.75rem',
                  }}
                />
                {query && (
                  <button
                    type="button"
                    onClick={() => setQuery('')}
                    aria-label="Clear search"
                    style={{
                      position: 'absolute', right: '0.2rem', top: '50%', transform: 'translateY(-50%)',
                      width: 44, height: 44, minWidth: 44, minHeight: 44,
                      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                      borderRadius: '999px', border: 'none',
                      background: 'rgba(255,255,255,0.06)', color: 'var(--hub-text-mute)',
                      cursor: 'pointer',
                    }}
                  >
                    <X size={16} aria-hidden="true" />
                  </button>
                )}
              </div>
            </div>

            <div role="group" aria-label="Filter by service type" style={{ display: 'flex', gap: '0.6rem', flexWrap: 'wrap' }}>
              {FILTERS.map((f) => {
                const active = filter === f.key
                return (
                  <button
                    key={f.key}
                    type="button"
                    onClick={() => { setFilter(f.key); trackFilterApplied('browse_type', f.key) }}
                    aria-pressed={active}
                    className={active ? 'hub-btn' : 'hub-btn-ghost'}
                    style={{ padding: '0.65rem 1.25rem', fontSize: '0.875rem' }}
                  >
                    {f.label}
                  </button>
                )
              })}
            </div>
          </Reveal>
        </div>
      </section>

      {/* Menu hits — only when typing */}
      {isSearching && (
        <section className="hub-section" style={{ paddingTop: 0, paddingBottom: menuHits.length > 0 ? 'clamp(2rem, 5vw, 3rem)' : 0 }}>
          <div className="hub-container">
            <p aria-live="polite" className="hub-meta" style={{ fontWeight: 600, color: 'var(--hub-text-mute)', marginBottom: '1.25rem' }}>
              {searching ? 'Searching dishes…' : `${menuHits.length} dish${menuHits.length === 1 ? '' : 'es'} matching "${query.trim()}"`}
            </p>
            {menuHits.length > 0 && (
              <RevealGroup style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: '1rem' }}>
                {menuHits.map((hit) => (
                  <RevealItem key={hit.id}>
                    <Link
                      href={`/${hit.concept.slug}`}
                      aria-label={`${hit.name} from ${formatBrandName(hit.concept.name)}`}
                      className="hub-card hub-card--interactive"
                      style={{ textDecoration: 'none', color: 'inherit', display: 'flex', gap: '0.9rem', padding: '0.9rem', alignItems: 'center' }}
                    >
                      <div className="hub-media" style={{ width: 64, height: 64, flexShrink: 0, borderRadius: '12px' }}>
                        {hit.imageUrl ? (
                          <img src={hit.imageUrl} alt="" loading="lazy" className="hub-media-fill" />
                        ) : (
                          <div aria-hidden="true" className="hub-media-fill" style={{ background: 'linear-gradient(135deg, var(--hub-plum), var(--hub-surface-2))' }} />
                        )}
                      </div>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <p className="hub-eyebrow" style={{ marginBottom: '0.2rem' }}>
                          {formatBrandName(hit.concept.name)}
                        </p>
                        <p style={{ fontSize: '0.95rem', fontWeight: 700, color: 'var(--hub-text)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', marginBottom: '0.2rem' }}>
                          {hit.name}
                        </p>
                        <p style={{ fontSize: '0.85rem', fontWeight: 700, color: 'var(--hub-ember)' }}>
                          {fmtPrice(hit.priceCents)}
                        </p>
                      </div>
                    </Link>
                  </RevealItem>
                ))}
              </RevealGroup>
            )}
          </div>
        </section>
      )}

      {/* Brand grid */}
      <section className="hub-section hub-section--raised">
        <div className="hub-container">
          {isSearching && filtered.length > 0 && (
            <p className="hub-eyebrow" style={{ marginBottom: '1.5rem' }}>
              Brands matching &ldquo;{query.trim()}&rdquo;
            </p>
          )}
          {filtered.length === 0 ? (
            <Reveal>
              <div style={{ textAlign: 'center', padding: '4rem 1.5rem' }}>
                <SearchX aria-hidden="true" size={40} style={{ color: 'var(--hub-text-dim)', marginBottom: '1.25rem' }} />
                <p className="hub-lead" style={{ margin: '0 auto 1.5rem', maxWidth: '32rem' }}>
                  No brands match. Try a different search, or clear the filters.
                </p>
                <button type="button" onClick={() => { setFilter('all'); setQuery('') }} className="hub-btn-ghost">
                  Clear filters
                </button>
              </div>
            </Reveal>
          ) : (
            <RevealGroup style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 280px), 1fr))', gap: '1.5rem' }}>
              {filtered.map((c) => (
                <RevealItem key={c.id}>
                  <BrowseCard concept={c} />
                </RevealItem>
              ))}
            </RevealGroup>
          )}
        </div>
      </section>
    </div>
  )
}

function BrowseCard({ concept }: { concept: Concept }) {
  const story = brandStory(concept.slug)
  const status = isOpenNow(concept.type)
  const name = formatBrandName(concept.name)
  return (
    <Link
      href={`/brand/${concept.slug}`}
      aria-label={`Visit ${name}${status.open ? ' — open now' : ' — closed'}`}
      className="hub-card hub-card--interactive"
      style={{ textDecoration: 'none', color: 'inherit', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}
      onClick={() => track('concept_switched', { slug: concept.slug })}
    >
      <div className="hub-media" style={{ aspectRatio: '16/10', borderRadius: 'calc(var(--hub-radius) - 1px) calc(var(--hub-radius) - 1px) 0 0' }}>
        <img
          src={conceptHeroImage(concept)}
          alt=""
          loading="lazy"
          className="hub-media-fill"
          style={{ filter: status.open ? undefined : 'saturate(0.4)' }}
        />
        <div aria-hidden="true" style={{ position: 'absolute', inset: 0, background: 'linear-gradient(180deg, transparent 40%, rgba(0,0,0,0.65) 100%)' }} />
        <span className="hub-pill" style={{ position: 'absolute', top: '0.85rem', left: '0.85rem' }}>
          {typeLabel(concept.type)}
        </span>
        <span className="hub-pill" style={{ position: 'absolute', top: '0.85rem', right: '0.85rem' }}>
          {status.open ? (
            <><span className="hub-pill-dot" aria-hidden="true" /> Open</>
          ) : (
            <><span aria-hidden="true" style={{ width: 7, height: 7, borderRadius: '50%', background: 'var(--hub-text-dim)' }} /> Closed</>
          )}
        </span>
      </div>
      <div style={{ padding: '1.25rem 1.4rem', flex: 1, display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
        <h3 className="hub-display" style={{ fontSize: '1.3rem' }}>{name}</h3>
        <p className="hub-meta" style={{ flex: 1, lineHeight: 1.5, fontSize: '0.9rem', color: 'var(--hub-text-mute)' }}>
          {concept.description || story.oneLiner}
        </p>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: '0.5rem' }}>
          <span className="hub-btn" style={{ minHeight: 'auto', padding: '0.55rem 1.1rem', fontSize: '0.8125rem' }}>
            Order <ArrowRight size={14} aria-hidden="true" />
          </span>
          <span className="hub-meta" style={{ display: 'inline-flex', alignItems: 'center', gap: '0.3rem' }}>
            See brand <ArrowRight size={12} aria-hidden="true" />
          </span>
        </div>
      </div>
    </Link>
  )
}
