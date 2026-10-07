'use client'
import Link from 'next/link'
import { useEffect, useRef, useState } from 'react'
import type { Concept } from '../lib/concept'
import { formatBrandName } from '../lib/concept'
import { FALLBACK_CONCEPTS } from '../lib/fallbackBrands'
import { trackSearch } from '../lib/analytics'

// The servd search sheet — opened from the nav's search icon (or the home
// hero's "Search the menus", or /home?q=…). Searches every kitchen's menu via
// /storefront/search and matches brand names. Replaces the old /browse search.

const API_URL = process.env['NEXT_PUBLIC_API_URL'] ?? 'http://localhost:3001'
const OPEN_EVENT = 'servd:open-search'

/** Open the search sheet from anywhere, optionally pre-filled. */
export function openSearch(query = '') {
  window.dispatchEvent(new CustomEvent(OPEN_EVENT, { detail: query }))
}

interface MenuHit {
  id: string; name: string; priceCents: number; imageUrl: string | null
  concept: { name: string; slug: string }
}

const pkr = (c: number) => `Rs. ${(c / 100).toLocaleString('en-PK', { maximumFractionDigits: 0 })}`

export function SearchSheet() {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<MenuHit[]>([])
  const [searching, setSearching] = useState(false)
  const [brands, setBrands] = useState<Concept[]>(Object.values(FALLBACK_CONCEPTS))
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const onOpen = (e: Event) => { setQuery(String((e as CustomEvent).detail ?? '')); setOpen(true) }
    window.addEventListener(OPEN_EVENT, onOpen)
    return () => window.removeEventListener(OPEN_EVENT, onOpen)
  }, [])

  // While open: focus the field, lock page scroll, Esc closes, load brands once.
  useEffect(() => {
    if (!open) return
    inputRef.current?.focus()
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    window.addEventListener('keydown', onKey)
    fetch(`${API_URL}/api/v1/storefront/concepts`)
      .then((r) => (r.ok ? r.json() : null))
      .then((list: Concept[] | null) => { if (list?.length) setBrands(list) })
      .catch(() => { /* keep the fallback brands */ })
    return () => { document.body.style.overflow = prev; window.removeEventListener('keydown', onKey) }
  }, [open])

  // Debounced dish search across every kitchen.
  useEffect(() => {
    const q = query.trim()
    if (!open || q.length < 2) { setHits([]); setSearching(false); return }
    setSearching(true)
    const ctrl = new AbortController()
    const t = setTimeout(() => {
      fetch(`${API_URL}/api/v1/storefront/search?q=${encodeURIComponent(q)}`, { signal: ctrl.signal })
        .then((r) => (r.ok ? r.json() : { items: [] }))
        .then((d: { items?: MenuHit[] }) => { setHits(d.items ?? []); trackSearch(q, d.items?.length ?? 0) })
        .catch(() => { /* aborted or offline — no dish hits */ })
        .finally(() => setSearching(false))
    }, 250)
    return () => { ctrl.abort(); clearTimeout(t) }
  }, [query, open])

  if (!open) return null

  const q = query.trim().toLowerCase()
  const brandHits = brands.filter((c) => !q || c.name.toLowerCase().includes(q) || (c.description ?? '').toLowerCase().includes(q))
  const close = () => setOpen(false)

  return (
    <>
      <div className="sv-search-backdrop" onClick={close} aria-hidden />
      <div className="sv-search-sheet" role="dialog" aria-modal="true" aria-label="Search servd">
        <div className="sv-search-inner">
          <div className="sv-search-field">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
              <circle cx="11" cy="11" r="7" /><path d="M20 20l-3.5-3.5" />
            </svg>
            <input ref={inputRef} value={query} onChange={(e) => setQuery(e.target.value)}
              placeholder="Search dishes and kitchens" aria-label="Search dishes and kitchens"
              type="search" enterKeyHint="search" />
            <button type="button" onClick={close} className="sv-icon-btn" aria-label="Close search">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
                <path d="M6 6l12 12M18 6L6 18" />
              </svg>
            </button>
          </div>

          {q.length >= 2 && (
            <>
              <p className="sv-search-label">
                {searching ? 'Searching…' : hits.length ? 'Dishes' : `No dishes match “${query.trim()}”`}
              </p>
              {hits.map((h) => (
                <Link key={h.id} href={`/${h.concept.slug}`} className="sv-search-row" onClick={close}>
                  <span className="sv-search-thumb" style={h.imageUrl ? { backgroundImage: `url(${h.imageUrl})` } : undefined} aria-hidden />
                  <span style={{ flex: 1, minWidth: 0 }}>
                    <span style={{ display: 'block', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{h.name}</span>
                    <span style={{ display: 'block', fontSize: '0.82rem', color: 'var(--servd-mute)' }}>
                      {formatBrandName(h.concept.name)} · {pkr(h.priceCents)}
                    </span>
                  </span>
                </Link>
              ))}
            </>
          )}

          {brandHits.length > 0 && (
            <>
              <p className="sv-search-label">Kitchens</p>
              {brandHits.map((c) => (
                <Link key={c.slug} href={`/${c.slug}`} className="sv-search-row" onClick={close}>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden style={{ color: 'var(--servd-dim)' }}>
                    <path d="M5 12h14M13 6l6 6-6 6" />
                  </svg>
                  Order from {formatBrandName(c.name)}
                </Link>
              ))}
            </>
          )}
        </div>
      </div>
    </>
  )
}
