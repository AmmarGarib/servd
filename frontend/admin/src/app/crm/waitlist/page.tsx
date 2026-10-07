'use client'
// New-brand waitlist (contract: owner, 2026-10-07). ONE servd-level opt-in
// list — deliberately not company-scoped — of people who asked to be told when
// servd opens a new brand. Sign-ups are WhatsApp-verified on the storefront
// (/waitlist) and land in the customer master data. This page shows the
// shareable link (+ ?src= source links), the funnel (visits → sign-ups), and
// the sign-ups themselves with CSV export. Messaging the list is done from the
// ONE campaign composer (/crm/campaigns?audience=waitlist) — no second sender.
import { useMemo, useState } from 'react'
import Link from 'next/link'
import { useQuery } from '@tanstack/react-query'
import { api } from '../../../lib/api'

// The public link people are sent to. Production storefront on purpose: this
// is what gets shared, so a dev STOREFRONT_URL (localhost) must never leak in.
// The public servd domain (owner, 2026-10-07) — never a tunnel host.
const WAITLIST_URL = 'https://servd.pk/waitlist'
const PRESET_SOURCES = ['instagram', 'whatsapp', 'tiktok', 'facebook', 'flyer', 'qr', 'email', 'in_store']

/** Same rule the API applies to ?src=: [a-z0-9_-]{1,40}. */
const cleanSource = (s: string) => s.trim().toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_-]/g, '').slice(0, 40)

interface Stats {
  signups: number
  verified: number
  visits: number
  conversionPct: number
  bySource: Array<{ source: string | null; visits: number; signups: number }>
  byDevice?: Array<{ device: string | null; visits: number; signups?: number }> | Record<string, number>
  last7Days: Array<{ date: string; visits: number; signups: number }>
}

interface Signup {
  id: string
  name: string | null
  phone: string | null
  email: string | null
  area: string | null
  interest: string | null
  source: string | null
  createdAt: string
  unsubscribedAt: string | null
  customerId: string | null
}

type SignupPage = { rows: Signup[]; total: number; page: number; pageSize: number }

// The API returns a paginated list; accept the common envelope spellings so a
// naming difference (rows/items/data, pageSize/limit) doesn't blank the table.
function normalisePage(raw: unknown, page: number): SignupPage {
  if (Array.isArray(raw)) return { rows: raw as Signup[], total: raw.length, page, pageSize: raw.length || 50 }
  const r = (raw ?? {}) as Record<string, unknown>
  const rows = (r.rows ?? r.items ?? r.signups ?? r.data ?? []) as Signup[]
  const pageSize = Number(r.pageSize ?? r.limit ?? r.perPage ?? 50) || 50
  return { rows, total: Number(r.total ?? r.count ?? rows.length) || 0, page: Number(r.page ?? page) || page, pageSize }
}

const pct = (signups: number, visits: number) => (visits > 0 ? `${((signups / visits) * 100).toFixed(1)}%` : '—')
const srcLabel = (s: string | null) => s || 'direct'

export default function WaitlistPage() {
  const { data: stats, isLoading: statsLoading, error: statsError } = useQuery({
    queryKey: ['waitlist-stats'],
    queryFn: () => api.get<Stats>('/waitlist/stats'),
    refetchInterval: 60_000,
  })

  return (
    <div className="min-h-screen bg-s-bg">
      <header className="border-b border-s-border px-6 py-4 flex items-start justify-between gap-4 flex-wrap">
        <div>
          <Link href="/crm" className="text-s-muted text-sm hover:text-s-text">← CRM</Link>
          <h1 className="text-2xl font-black text-s-text mt-0.5">New-brand waitlist</h1>
          <p className="text-sm text-s-muted max-w-2xl">
            People who asked to hear when servd opens a new brand. One servd-wide list, opt-in and WhatsApp-verified;
            every sign-up is also a customer record.
          </p>
        </div>
        <Link href="/crm/campaigns?audience=waitlist" className="s-btn-primary">Message the waitlist</Link>
      </header>

      <div className="p-6 max-w-6xl mx-auto space-y-6">
        <ShareLink sources={stats?.bySource.map((s) => s.source).filter((s): s is string => !!s) ?? []} />

        {statsError && <p className="rounded-lg bg-s-red-dim border border-s-red/30 px-3 py-2 text-sm text-s-red">{(statsError as Error).message}</p>}

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div className="metric-card">
            <p className="metric-label">Sign-ups</p>
            <p className="metric-value">{statsLoading ? '…' : (stats?.signups ?? 0).toLocaleString()}</p>
            {stats && stats.verified !== stats.signups && <p className="text-xs text-s-muted">{stats.verified.toLocaleString()} verified</p>}
          </div>
          <div className="metric-card">
            <p className="metric-label">Page visits</p>
            <p className="metric-value">{statsLoading ? '…' : (stats?.visits ?? 0).toLocaleString()}</p>
          </div>
          <div className="metric-card">
            <p className="metric-label">Conversion</p>
            <p className="metric-value">{statsLoading ? '…' : stats ? `${(stats.conversionPct ?? 0).toFixed(1)}%` : '—'}</p>
            <p className="text-xs text-s-muted">sign-ups / visits</p>
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-5 gap-4">
          <div className="s-card overflow-hidden lg:col-span-3">
            <p className="px-4 pt-4 text-sm font-bold text-s-text">By source</p>
            <div className="overflow-x-auto">
              <table className="s-table">
                <thead><tr><th>Source</th><th className="!text-right">Visits</th><th className="!text-right">Sign-ups</th><th className="!text-right">Conversion</th></tr></thead>
                <tbody>
                  {(stats?.bySource ?? []).length === 0 && (
                    <tr><td colSpan={4} className="!text-s-muted text-center">{statsLoading ? 'Loading…' : 'No visits yet. Share the link above.'}</td></tr>
                  )}
                  {[...(stats?.bySource ?? [])].sort((a, b) => b.signups - a.signups || b.visits - a.visits).map((s) => (
                    <tr key={s.source ?? '__direct'}>
                      <td className="font-mono text-xs">{srcLabel(s.source)}</td>
                      <td className="text-right tabular-nums">{s.visits.toLocaleString()}</td>
                      <td className="text-right tabular-nums">{s.signups.toLocaleString()}</td>
                      <td className="text-right tabular-nums">{pct(s.signups, s.visits)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
          <div className="s-card p-4 lg:col-span-2">
            <LastSevenDays days={stats?.last7Days ?? []} />
            <DeviceSplit byDevice={stats?.byDevice} />
          </div>
        </div>

        <SignupsTable sources={stats?.bySource.map((s) => s.source).filter((s): s is string => !!s) ?? []} />
      </div>
    </div>
  )
}

// ─── Share link + source-link builder ───────────────────────────────────────

function CopyButton({ text }: { text: string }) {
  const [done, setDone] = useState(false)
  return (
    <button type="button" className="s-btn-secondary shrink-0"
      onClick={() => {
        navigator.clipboard.writeText(text).then(() => { setDone(true); setTimeout(() => setDone(false), 1500) }).catch(() => {})
      }}>
      {done ? 'Copied' : 'Copy'}
    </button>
  )
}

function ShareLink({ sources }: { sources: string[] }) {
  const [pick, setPick] = useState('')
  const [custom, setCustom] = useState('')
  const options = useMemo(() => [...new Set([...PRESET_SOURCES, ...sources])], [sources])
  const src = cleanSource(pick === '__custom' ? custom : pick)
  const sourceLink = src ? `${WAITLIST_URL}?src=${src}` : ''

  return (
    <div className="s-card p-4 space-y-4">
      <div>
        <p className="text-xs font-semibold uppercase tracking-wider text-s-muted mb-1.5">Shareable link</p>
        <div className="flex gap-2">
          <input readOnly value={WAITLIST_URL} className="s-input font-mono" onFocus={(e) => e.currentTarget.select()} />
          <CopyButton text={WAITLIST_URL} />
        </div>
      </div>
      <div>
        <p className="text-xs font-semibold uppercase tracking-wider text-s-muted mb-1.5">Make a source link</p>
        <p className="text-xs text-s-muted mb-2">Tag the link per place you post it, so the table below shows which one brings sign-ups.</p>
        <div className="flex gap-2 flex-wrap sm:flex-nowrap">
          <select value={pick} onChange={(e) => setPick(e.target.value)} className="s-select sm:max-w-[12rem]">
            <option value="">Pick a source…</option>
            {options.map((o) => <option key={o} value={o}>{o}</option>)}
            <option value="__custom">Other…</option>
          </select>
          {pick === '__custom' && (
            <input value={custom} onChange={(e) => setCustom(e.target.value)} placeholder="e.g. lums_flyer" className="s-input sm:max-w-[14rem]" />
          )}
          {sourceLink && (
            <>
              <input readOnly value={sourceLink} className="s-input font-mono" onFocus={(e) => e.currentTarget.select()} />
              <CopyButton text={sourceLink} />
            </>
          )}
        </div>
        {pick === '__custom' && custom && src !== custom && (
          <p className="text-[11px] text-s-dim mt-1">Letters, numbers, - and _ only (lower case, up to 40).</p>
        )}
      </div>
    </div>
  )
}

// ─── Charts ────────────────────────────────────────────────────────────────

function LastSevenDays({ days }: { days: Stats['last7Days'] }) {
  const max = Math.max(1, ...days.map((d) => Math.max(d.visits, d.signups)))
  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <p className="text-sm font-bold text-s-text">Last 7 days</p>
        <div className="flex items-center gap-3 text-[11px] text-s-muted">
          <span className="flex items-center gap-1"><span className="inline-block w-2.5 h-2.5 rounded-sm bg-s-border-strong" />Visits</span>
          <span className="flex items-center gap-1"><span className="inline-block w-2.5 h-2.5 rounded-sm bg-primary" />Sign-ups</span>
        </div>
      </div>
      {days.length === 0 ? (
        <p className="text-xs text-s-muted">No data yet.</p>
      ) : (
        <div className="flex items-end gap-2 h-32">
          {days.map((d) => (
            <div key={d.date} className="flex-1 flex flex-col items-center gap-1 min-w-0"
              title={`${d.date}: ${d.visits} visits, ${d.signups} sign-ups`}>
              <div className="flex items-end gap-0.5 h-24 w-full justify-center">
                <div className="w-1/3 rounded-t bg-s-border-strong" style={{ height: `${(d.visits / max) * 100}%` }} />
                <div className="w-1/3 rounded-t bg-primary" style={{ height: `${(d.signups / max) * 100}%` }} />
              </div>
              <span className="text-[10px] text-s-muted tabular-nums">
                {new Date(`${d.date.slice(0, 10)}T00:00:00`).toLocaleDateString('en-GB', { weekday: 'short' })}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function DeviceSplit({ byDevice }: { byDevice: Stats['byDevice'] }) {
  if (!byDevice) return null
  const rows = Array.isArray(byDevice)
    ? byDevice.map((d) => ({ device: d.device ?? 'unknown', visits: d.visits }))
    : Object.entries(byDevice).map(([device, visits]) => ({ device, visits: Number(visits) || 0 }))
  const total = rows.reduce((s, r) => s + r.visits, 0)
  if (total === 0) return null
  return (
    <div className="mt-5 pt-4 border-t border-s-border">
      <p className="text-xs font-semibold uppercase tracking-wider text-s-muted mb-2">Visits by device</p>
      <div className="space-y-1.5">
        {rows.map((r) => (
          <div key={r.device} className="flex items-center gap-2 text-xs">
            <span className="w-16 text-s-text capitalize">{r.device}</span>
            <div className="stat-bar-track flex-1"><div className="stat-bar-fill" style={{ width: `${(r.visits / total) * 100}%` }} /></div>
            <span className="w-10 text-right tabular-nums text-s-muted">{Math.round((r.visits / total) * 100)}%</span>
          </div>
        ))}
      </div>
    </div>
  )
}

// ─── Sign-ups ──────────────────────────────────────────────────────────────

function SignupsTable({ sources }: { sources: string[] }) {
  const [q, setQ] = useState('')
  const [source, setSource] = useState('')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [page, setPage] = useState(1)
  const [exportError, setExportError] = useState<string | null>(null)
  const [exporting, setExporting] = useState(false)

  const filterQs = useMemo(() => {
    const p = new URLSearchParams()
    if (q.trim()) p.set('q', q.trim())
    if (source) p.set('source', source)
    if (from) p.set('from', from)
    if (to) p.set('to', to)
    return p
  }, [q, source, from, to])

  const { data, isLoading, error } = useQuery({
    queryKey: ['waitlist-signups', filterQs.toString(), page],
    queryFn: async () => {
      const p = new URLSearchParams(filterQs); p.set('page', String(page))
      return normalisePage(await api.get<unknown>(`/waitlist/signups?${p.toString()}`), page)
    },
    placeholderData: (prev) => prev,
  })
  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1
  const resetPage = <T,>(fn: (v: T) => void) => (v: T) => { fn(v); setPage(1) }

  const exportCsv = async () => {
    setExportError(null); setExporting(true)
    try {
      const qs = filterQs.toString()
      await api.download(`/waitlist/signups.csv${qs ? `?${qs}` : ''}`, `waitlist-${new Date().toISOString().slice(0, 10)}.csv`)
    } catch (e) {
      setExportError((e as Error).message)
    } finally {
      setExporting(false)
    }
  }

  return (
    <div className="s-card overflow-hidden">
      <div className="p-4 flex items-end gap-3 flex-wrap border-b border-s-border">
        <p className="text-sm font-bold text-s-text mr-auto self-center">
          Sign-ups{data ? <span className="text-s-muted font-normal"> · {data.total.toLocaleString()}</span> : null}
        </p>
        <input value={q} onChange={(e) => resetPage(setQ)(e.target.value)} placeholder="Search name, phone, email"
          className="s-input !w-56" />
        <select value={source} onChange={(e) => resetPage(setSource)(e.target.value)} className="s-select !w-40">
          <option value="">All sources</option>
          {[...new Set(sources)].map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
        <label className="text-xs text-s-muted">From
          <input type="date" value={from} onChange={(e) => resetPage(setFrom)(e.target.value)} className="s-input !w-36 mt-0.5" />
        </label>
        <label className="text-xs text-s-muted">To
          <input type="date" value={to} onChange={(e) => resetPage(setTo)(e.target.value)} className="s-input !w-36 mt-0.5" />
        </label>
        <button type="button" onClick={() => void exportCsv()} disabled={exporting} className="s-btn-secondary">
          {exporting ? 'Exporting…' : 'Export CSV'}
        </button>
      </div>
      {(error || exportError) && (
        <p className="m-4 rounded-lg bg-s-red-dim border border-s-red/30 px-3 py-2 text-sm text-s-red">
          {exportError ?? (error as Error).message}
        </p>
      )}
      <div className="overflow-x-auto">
        <table className="s-table">
          <thead>
            <tr><th>Name</th><th>Phone</th><th>Email</th><th>Area</th><th>Interest</th><th>Source</th><th>Joined</th><th>Status</th></tr>
          </thead>
          <tbody>
            {isLoading && <tr><td colSpan={8} className="!text-s-muted text-center">Loading…</td></tr>}
            {!isLoading && data?.rows.length === 0 && (
              <tr><td colSpan={8} className="!text-s-muted text-center">No sign-ups match.</td></tr>
            )}
            {data?.rows.map((r) => (
              <tr key={r.id}>
                <td className="font-semibold">
                  {r.customerId
                    ? <Link href={`/crm?customer=${r.customerId}`} className="hover:underline">{r.name || '—'}</Link>
                    : (r.name || '—')}
                </td>
                <td className="font-mono text-xs">{r.phone ?? '—'}</td>
                <td className="text-xs">{r.email ?? '—'}</td>
                <td className="text-xs">{r.area ?? '—'}</td>
                <td className="text-xs max-w-[16rem] truncate" title={r.interest ?? undefined}>{r.interest ?? '—'}</td>
                <td className="font-mono text-xs">{srcLabel(r.source)}</td>
                <td className="text-xs text-s-muted">{new Date(r.createdAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}</td>
                <td>
                  {r.unsubscribedAt
                    ? <span className="s-badge-muted">Unsubscribed</span>
                    : <span className="s-badge-teal">On the list</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {data && pages > 1 && (
        <div className="flex items-center justify-end gap-2 p-3 border-t border-s-border text-xs text-s-muted">
          <button type="button" className="s-btn-ghost" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>Previous</button>
          <span className="tabular-nums">Page {page} of {pages}</span>
          <button type="button" className="s-btn-ghost" disabled={page >= pages} onClick={() => setPage((p) => p + 1)}>Next</button>
        </div>
      )}
    </div>
  )
}
