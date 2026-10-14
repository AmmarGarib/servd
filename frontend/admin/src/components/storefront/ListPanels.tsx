'use client'

// Pages and Pop-ups tabs of the Storefront hub.

import { useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  contentApi, DEFAULT_POPUP_RULES, fmtDateTime, isReservedBrandPage, newPopupKey, seedBlocks, storefrontPath, STOREFRONT_BRANDS_KEY, STOREFRONT_URL,
  type ConceptLite, type LayoutSummary, type PopupRules,
} from '../../lib/content'
import { StatusBadge } from './panels'
import { useSectionCatalog } from '../../lib/sections'

const pageHref = (slug: string) => `/storefront/pages/${encodeURIComponent(slug)}`
const popupHref = (slug: string) => `/storefront/popups/${encodeURIComponent(slug.slice('popup:'.length))}`

interface Entry { slug: string; label: string; hint?: string }

function Row({ entry, row, href }: { entry: Entry; row: LayoutSummary | undefined; href: string }) {
  const path = storefrontPath(entry.slug)
  return (
    <tr>
      <td>
        <Link href={href} className="font-semibold text-s-text hover:text-primary-ink">{entry.label}</Link>
        <p className="text-[11px] text-s-muted font-mono">{entry.slug}{entry.hint ? ` · ${entry.hint}` : ''}</p>
      </td>
      <td className="text-xs">{row?.liveVersion ? `v${row.liveVersion}` : <span className="text-s-muted">Built-in / none</span>}</td>
      <td>{row ? <StatusBadge row={row} showNote /> : <span className="s-badge-muted">No draft</span>}</td>
      <td className="text-xs text-s-muted">{fmtDateTime(row?.draftUpdatedAt ?? row?.updatedAt ?? null)}</td>
      <td className="text-right">
        <div className="flex justify-end gap-3 text-xs">
          {path && row?.liveVersion && <a href={`${STOREFRONT_URL}${path}`} target="_blank" rel="noopener noreferrer" className="text-s-muted hover:text-s-text">View live</a>}
          <Link href={href} className="text-primary-ink hover:underline">Edit</Link>
        </div>
      </td>
    </tr>
  )
}

function Table({ children }: { children: React.ReactNode }) {
  return (
    <div className="s-card overflow-x-auto">
      <table className="s-table">
        <thead><tr><th>Page</th><th>Live</th><th>Draft</th><th>Last edited</th><th /></tr></thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  )
}

export function PagesPanel() {
  const router = useRouter()
  const qc = useQueryClient()
  const concepts = useQuery<ConceptLite[]>({ queryKey: STOREFRONT_BRANDS_KEY, queryFn: contentApi.brands })
  const layouts = useQuery<LayoutSummary[]>({ queryKey: ['site-layouts', 'all'], queryFn: () => contentApi.list({ status: 'all' }) })
  const [creating, setCreating] = useState(false)
  const [newSlug, setNewSlug] = useState('')
  const [newTitle, setNewTitle] = useState('')
  const [owner, setOwner] = useState('servd')
  // New pages start from the catalogue's starter sections when there are any.
  const catalog = useSectionCatalog()
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const rows = layouts.data ?? []
  const bySlug = new Map(rows.map((r) => [r.slug, r]))

  const servd: Entry[] = [
    { slug: 'servd:header', label: 'Top bar', hint: 'logo, links and the Order button on every servd page' },
    { slug: 'servd:home', label: 'Home', hint: '/home' },
    { slug: 'servd:footer', label: 'Footer', hint: 'every servd page' },
    { slug: 'servd:feedback', label: 'Feedback button', hint: 'the floating feedback button and sheet on every servd page' },
    { slug: 'servd:waitlist', label: 'Waitlist', hint: '/waitlist' },
    { slug: 'servd:press', label: 'Press', hint: '/press' },
    { slug: 'servd:reserve', label: 'Reserve', hint: '/reserve' },
    { slug: 'servd:location', label: 'Location pages', hint: 'the template for every /locations page' },
  ]
  const brandPages = (c: ConceptLite): Entry[] => [
    { slug: `brand:${c.slug}:header`, label: 'Top bar' },
    { slug: `brand:${c.slug}`, label: 'Home' },
    { slug: `brand:${c.slug}:about`, label: 'About' },
    { slug: `brand:${c.slug}:visit`, label: 'Visit' },
    { slug: `brand:${c.slug}:menu`, label: 'Menu' },
    { slug: `brand:${c.slug}:footer`, label: 'Footer' },
    ...rows
      .filter((r) => r.slug.startsWith(`brand:${c.slug}:`) && !isReservedBrandPage(r.slug.split(':')[2] ?? ''))
      .map((r) => ({ slug: r.slug, label: r.title || r.slug.split(':')[2]!, hint: `/pages/${r.slug.split(':')[2]}` })),
  ]
  const brandList = concepts.data ?? []
  const known = new Set([...servd, ...brandList.flatMap(brandPages)].map((e) => e.slug))
  const custom: Entry[] = rows.filter((r) => r.slug.startsWith('page:')).map((r) => ({ slug: r.slug, label: r.title || r.slug.slice(5), hint: `/pages/${r.slug.slice(5)}` }))
  const other: Entry[] = rows
    .filter((r) => r.kind !== 'popup' && r.kind !== 'kit' && !r.slug.startsWith('popup:') && !r.slug.startsWith('page:') && !known.has(r.slug))
    .map((r) => ({ slug: r.slug, label: r.title || r.slug }))

  // New page: a servd page (page:<x>, at servd.pk/pages/<x>) or a brand page
  // (brand:<brand>:<x>, at <brand domain>/pages/<x>).
  const create = async () => {
    const s = newSlug.trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '')
    if (!s) { setErr('Give the page an address, e.g. ramadan'); return }
    if (owner !== 'servd' && isReservedBrandPage(s)) { setErr(`"${s}" is one of the brand's built-in pages. Pick another address.`); return }
    const slug = owner === 'servd' ? `page:${s}` : `brand:${owner}:${s}`
    if (bySlug.has(slug)) { setErr('A page with that address already exists.'); return }
    setBusy(true); setErr(null)
    try {
      await contentApi.saveDraft(slug, { title: newTitle.trim() || s, kind: 'page', blocks: seedBlocks(slug) })
      void qc.invalidateQueries({ queryKey: ['site-layouts'] })
      router.push(pageHref(slug))
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const newPageForm = (
    <div className="s-card p-4 flex flex-wrap items-end gap-3">
      <label className="min-w-[160px]">
        <span className="block text-[11px] text-s-muted font-semibold mb-1 uppercase tracking-wider">Site</span>
        <select value={owner} onChange={(e) => setOwner(e.target.value)} className="s-select">
          <option value="servd">servd.pk</option>
          {brandList.map((c) => <option key={c.slug} value={c.slug}>{c.name}</option>)}
        </select>
      </label>
      <label className="flex-1 min-w-[180px]">
        <span className="block text-[11px] text-s-muted font-semibold mb-1 uppercase tracking-wider">Address</span>
        <div className="flex items-center gap-1 text-sm text-s-muted">/pages/<input value={newSlug} onChange={(e) => setNewSlug(e.target.value)} placeholder="ramadan" className="s-input" /></div>
      </label>
      <label className="flex-1 min-w-[180px]">
        <span className="block text-[11px] text-s-muted font-semibold mb-1 uppercase tracking-wider">Title</span>
        <input value={newTitle} onChange={(e) => setNewTitle(e.target.value)} placeholder="Ramadan menu" className="s-input" />
      </label>
      <button type="button" onClick={create} disabled={busy} className="s-btn-primary text-xs">{busy ? 'Creating...' : 'Create draft'}</button>
      {err && <p className="w-full text-xs text-s-red">{err}</p>}
    </div>
  )

  return (
    <div className="space-y-6">
      {layouts.isError && <p className="text-sm text-s-red">Could not load pages: {(layouts.error as Error).message}</p>}
      {catalog.isError && (
        <div role="alert" className="s-card border-s-red/40 p-4 flex flex-wrap items-center gap-3">
          <p className="flex-1 min-w-[16rem] text-xs text-s-text">
            {(catalog.error as Error).message} Pages open once it answers again.
          </p>
          <button type="button" onClick={() => void catalog.refetch()} disabled={catalog.isFetching} className="s-btn-secondary text-xs shrink-0">
            {catalog.isFetching ? 'Retrying...' : 'Retry'}
          </button>
        </div>
      )}

      <div className="flex items-center justify-between">
        <p className="text-xs text-s-muted">Every page on servd.pk and the brand sites. A page with nothing published shows its built-in design; edit it to change anything on it.</p>
        <button type="button" onClick={() => setCreating((v) => !v)} className="s-btn-primary text-xs shrink-0">New page</button>
      </div>
      {creating && newPageForm}

      <section className="space-y-2">
        <h2 className="text-sm font-bold text-s-text">servd.pk</h2>
        <Table>{servd.map((e) => <Row key={e.slug} entry={e} row={bySlug.get(e.slug)} href={pageHref(e.slug)} />)}</Table>
      </section>

      {concepts.isLoading && <p className="text-xs text-s-muted">Loading brands...</p>}
      {brandList.map((c) => (
        <section key={c.slug} className="space-y-2">
          <h2 className="text-sm font-bold text-s-text">{c.name}</h2>
          <Table>{brandPages(c).map((e) => <Row key={e.slug} entry={e} row={bySlug.get(e.slug)} href={pageHref(e.slug)} />)}</Table>
        </section>
      ))}

      <section className="space-y-2">
        <h2 className="text-sm font-bold text-s-text">servd.pk custom pages</h2>
        {custom.length === 0
          ? <p className="text-xs text-s-muted">None yet. Use New page.</p>
          : <Table>{custom.map((e) => <Row key={e.slug} entry={e} row={bySlug.get(e.slug)} href={pageHref(e.slug)} />)}</Table>}
      </section>

      {other.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-sm font-bold text-s-text">Other saved pages</h2>
          <Table>{other.map((e) => <Row key={e.slug} entry={e} row={bySlug.get(e.slug)} href={pageHref(e.slug)} />)}</Table>
        </section>
      )}
    </div>
  )
}

export function PopupsPanel() {
  const router = useRouter()
  const qc = useQueryClient()
  const layouts = useQuery<LayoutSummary[]>({ queryKey: ['site-layouts', 'popups'], queryFn: () => contentApi.list({ status: 'all', kind: 'popup' }) })
  const [creating, setCreating] = useState(false)
  const [title, setTitle] = useState('')
  const [popupKind, setPopupKind] = useState<PopupRules['popupKind']>('offer')
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const rows = (layouts.data ?? []).filter((r) => r.slug.startsWith('popup:'))

  const create = async () => {
    const slug = `popup:${newPopupKey()}`
    setBusy(true); setErr(null)
    try {
      await contentApi.saveDraft(slug, {
        title: title.trim() || `${popupKind[0]!.toUpperCase()}${popupKind.slice(1)} pop-up`,
        kind: 'popup',
        blocks: seedBlocks(slug, popupKind),
        settings: { popup: DEFAULT_POPUP_RULES(popupKind) },
      })
      void qc.invalidateQueries({ queryKey: ['site-layouts'] })
      router.push(popupHref(slug))
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-xs text-s-muted">Sign-up prompts, offers and announcements shown over the storefront, with rules for where, when and to whom.</p>
        <button type="button" onClick={() => setCreating((v) => !v)} className="s-btn-primary text-xs">New pop-up</button>
      </div>
      {creating && (
        <div className="s-card p-4 flex flex-wrap items-end gap-3">
          <label className="flex-1 min-w-[180px]">
            <span className="block text-[11px] text-s-muted font-semibold mb-1 uppercase tracking-wider">Title</span>
            <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Ramadan offer" className="s-input" />
          </label>
          <label className="min-w-[160px]">
            <span className="block text-[11px] text-s-muted font-semibold mb-1 uppercase tracking-wider">Type</span>
            <select value={popupKind} onChange={(e) => setPopupKind(e.target.value as PopupRules['popupKind'])} className="s-select">
              <option value="signup">Sign-up</option><option value="login">Log-in</option>
              <option value="offer">Offer</option><option value="announcement">Announcement</option>
            </select>
          </label>
          <button type="button" onClick={create} disabled={busy} className="s-btn-primary text-xs">{busy ? 'Creating...' : 'Create draft'}</button>
          {err && <p className="w-full text-xs text-s-red">{err}</p>}
        </div>
      )}
      {layouts.isLoading && <p className="text-xs text-s-muted">Loading...</p>}
      {layouts.isError && <p className="text-sm text-s-red">Could not load pop-ups: {(layouts.error as Error).message}</p>}
      {!layouts.isLoading && rows.length === 0 && <p className="text-xs text-s-muted">No pop-ups yet.</p>}
      {rows.length > 0 && (
        <Table>
          {rows.map((r) => (
            <Row key={r.slug} entry={{ slug: r.slug, label: r.title || 'Untitled pop-up' }} row={r} href={popupHref(r.slug)} />
          ))}
        </Table>
      )}
    </div>
  )
}
