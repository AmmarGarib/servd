'use client'
import Link from 'next/link'
import { useEffect, useMemo, useState } from 'react'
import type { Concept } from '../../lib/concept'
import { typeLabel, typeIcon, conceptHeroImage, brandStory } from '../../lib/concept'
import { isOpenNow, fmtHourWindow } from '../../lib/hours'
import { trackSearch, trackFilterApplied, track } from '../../lib/analytics'

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

  return (
    <div style={{ background: 'var(--servd-bg)' }}>

      {/* Header — editorial, asymmetric, matches /home + brand microsites */}
      <section className="section-tight" style={{ paddingBottom: '1.5rem', borderBottom: '1px solid var(--servd-line)' }}>
        <div className="container">
          <p className="eyebrow eyebrow-accent">Every kitchen</p>
          <h1 className="display" style={{ fontSize: 'clamp(2.5rem, 7vw, 5rem)', margin: '0.5rem 0 0.75rem', maxWidth: '900px' }}>
            Pick your craving.<br />
            <span className="display-italic">{concepts.length} kitchens.</span>
          </h1>
          <p style={{ color: 'var(--servd-mute)', fontSize: '1.05rem', maxWidth: '36rem', lineHeight: 1.55 }}>
            One app, one delivery bag. Mix and match — pick from one, two, or all of them, and we figure out the timing.
          </p>

          {/* Search + filters */}
          <div style={{ marginTop: '2rem', display: 'flex', flexDirection: 'column', gap: '1rem' }}>
            <div role="search" style={{ position: 'relative' }}>
              <span aria-hidden="true" style={{
                position: 'absolute',
                left: '1.1rem',
                top: '50%',
                transform: 'translateY(-50%)',
                color: 'var(--servd-mute)',
                display: 'inline-flex',
              }}>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="11" cy="11" r="8"/>
                  <line x1="21" y1="21" x2="16.65" y2="16.65"/>
                </svg>
              </span>
              <input
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search brands, cuisines, dishes…"
                aria-label="Search brands"
                className="servd-input"
                style={{ paddingLeft: '2.6rem', borderRadius: '999px', maxWidth: '36rem' }}
              />
            </div>

            <div role="group" aria-label="Filter by service type" style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
              {FILTERS.map((f) => {
                const active = filter === f.key
                return (
                  <button
                    key={f.key}
                    onClick={() => { setFilter(f.key); trackFilterApplied('browse_type', f.key) }}
                    aria-pressed={active}
                    style={{
                      padding: '0.5rem 1rem',
                      borderRadius: '999px',
                      border: '1px solid var(--servd-line)',
                      background: active ? 'var(--servd-black)' : 'white',
                      color: active ? 'white' : 'var(--servd-ink)',
                      fontWeight: 600,
                      fontSize: '0.875rem',
                      cursor: 'pointer',
                      transition: 'background 120ms ease, color 120ms ease',
                    }}
                  >
                    {f.label}
                  </button>
                )
              })}
            </div>
          </div>
        </div>
      </section>

      {/* Menu hits — only when typing */}
      {query.trim().length >= 2 && (
        <section className="section-tight" style={{ paddingBottom: 0 }}>
          <div className="container">
            <h2 style={{ fontSize: '1.05rem', fontWeight: 700, marginBottom: '1rem' }}>
              {searching ? 'Searching dishes…' : `${menuHits.length} dish${menuHits.length === 1 ? '' : 'es'} matching "${query.trim()}"`}
            </h2>
            {menuHits.length > 0 && (
              <div style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))',
                gap: '0.85rem',
              }}>
                {menuHits.map((hit) => {
                  const fmt = (c: number) => `PKR ${(c / 100).toLocaleString('en-PK', { maximumFractionDigits: 0 })}`
                  return (
                    <Link
                      key={hit.id}
                      href={`/${hit.concept.slug}`}
                      aria-label={`${hit.name} from ${hit.concept.name}`}
                      className="servd-card"
                      style={{ textDecoration: 'none', color: 'inherit', display: 'flex', gap: '0.85rem', padding: '0.85rem', alignItems: 'center' }}
                    >
                      <div style={{
                        width: 64, height: 64, borderRadius: '0.6rem',
                        flexShrink: 0,
                        background: hit.imageUrl
                          ? `url(${hit.imageUrl}) center/cover`
                          : `linear-gradient(135deg, ${hit.concept.primaryColor ?? 'var(--servd-green)'} 0%, white 200%)`,
                      }} aria-hidden="true" />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <p style={{ fontSize: '0.7rem', fontWeight: 700, color: 'var(--servd-green-dark)', letterSpacing: '0.1em', textTransform: 'uppercase', marginBottom: '0.15rem' }}>
                          {hit.concept.name}
                        </p>
                        <p style={{ fontSize: '0.95rem', fontWeight: 700, marginBottom: '0.15rem', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                          {hit.name}
                        </p>
                        <p style={{ fontSize: '0.85rem', color: 'var(--servd-green-dark)', fontWeight: 700 }}>
                          {fmt(hit.priceCents)}
                        </p>
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
      <section className="section-tight">
        <div className="container">
          {query.trim().length >= 2 && filtered.length > 0 && (
            <h2 style={{ fontSize: '1.05rem', fontWeight: 700, marginBottom: '1rem' }}>
              Brands matching "{query.trim()}"
            </h2>
          )}
          {filtered.length === 0 ? (
            <div style={{ textAlign: 'center', padding: '4rem 2rem', color: 'var(--servd-mute)' }}>
              <p style={{ fontSize: '1.05rem', marginBottom: '0.75rem' }}>No brands match.</p>
              <button onClick={() => { setFilter('all'); setQuery('') }} className="servd-btn-secondary">Clear filters</button>
            </div>
          ) : (
            <div style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))',
              gap: '1.25rem',
            }}>
              {filtered.map((c) => <BrowseCard key={c.id} concept={c} />)}
            </div>
          )}
        </div>
      </section>
    </div>
  )
}

function BrowseCard({ concept }: { concept: Concept }) {
  const story = brandStory(concept.slug)
  const status = isOpenNow(concept.type)
  return (
    <Link
      href={`/brand/${concept.slug}`}
      aria-label={`Visit ${concept.name}${status.open ? ' — open now' : ' — closed'}`}
      className="servd-card"
      style={{ textDecoration: 'none', color: 'inherit', display: 'flex', flexDirection: 'column', position: 'relative' }}
      onClick={() => track('concept_switched', { slug: concept.slug })}
    >
      <div style={{
        aspectRatio: '16/10',
        background: `${concept.primaryColor ?? 'var(--servd-green-dark)'} url(${conceptHeroImage(concept)}) center/cover`,
        position: 'relative',
        filter: status.open ? undefined : 'saturate(0.5)',
      }}>
        <div style={{
          position: 'absolute',
          inset: 0,
          background: 'linear-gradient(180deg, transparent 40%, rgba(0,0,0,0.55) 100%)',
        }} />
        <span style={{
          position: 'absolute',
          top: '0.85rem',
          left: '0.85rem',
          background: 'rgba(255,255,255,0.92)',
          color: 'var(--servd-black)',
          fontSize: '0.7rem',
          fontWeight: 700,
          letterSpacing: '0.1em',
          textTransform: 'uppercase',
          padding: '0.3rem 0.65rem',
          borderRadius: '999px',
        }}>
          {typeIcon(concept.type)} {typeLabel(concept.type)}
        </span>
        <span style={{
          position: 'absolute',
          top: '0.85rem',
          right: '0.85rem',
          background: status.open ? 'rgba(58,14,105,0.95)' : 'rgba(0,0,0,0.7)',
          color: status.open ? 'var(--servd-black)' : 'white',
          fontSize: '0.7rem',
          fontWeight: 700,
          letterSpacing: '0.1em',
          textTransform: 'uppercase',
          padding: '0.3rem 0.65rem',
          borderRadius: '999px',
        }}>
          {status.open ? '● Open' : '○ Closed'}
        </span>
      </div>
      <div style={{ padding: '1.25rem 1.4rem', flex: 1, display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
        <h3 style={{ fontSize: '1.2rem' }}>{concept.name}</h3>
        <p style={{ color: 'var(--servd-mute)', fontSize: '0.9rem', lineHeight: 1.45, flex: 1 }}>
          {concept.description || story.oneLiner}
        </p>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: '0.5rem' }}>
          <span style={{
            display: 'inline-flex',
            alignItems: 'center',
            background: 'var(--servd-green)', color: 'white',
            fontWeight: 800,
            fontSize: '0.85rem',
            padding: '0.45rem 1rem',
            borderRadius: '999px',
          }}>
            Order →
          </span>
          <span style={{ fontSize: '0.75rem', color: 'var(--servd-dim)' }}>
            See brand →
          </span>
        </div>
      </div>
    </Link>
  )
}
