'use client'
// Approvals — the ONE inbox (owner decision D3, 2026-10-11).
//
// Everything waiting on the signed-in person, from every module, with a count
// per type: new logins, website changes, purchase orders over the limit,
// recipes, HR requests, payroll, tip pools, stock transfers. GET /approvals
// (backend modules/approvals) reads each module's own queue as this login, so
// only what they can act on is listed, for the companies in view.
//
// Nothing is approved here by a second engine: each button calls the module's
// EXISTING route (the item carries method + path), and that route's own guard
// decides. HR requests open in the HR record view (overtime hours, swaps) —
// this page replaces "My approvals" (/hr/approvals now redirects here).

import { Suspense, useMemo, useState } from 'react'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../../../lib/api'
import type { HrFormat, HrRecord } from '../../../lib/hr'
import { Modal, useHrLookups, useHrOrg } from '../../../components/hr/HrShell'
import { RecordDetail } from '../../../components/hr/RecordDetail'
import { PENDING_LAYOUTS_KEY } from '../../../components/storefront/ApprovalsPanel'
import { APPROVALS_INBOX_KEY, APPROVALS_ROOT, type ApprovalTypeSummary } from '../approvalsData'

interface Action {
  kind: 'approve' | 'reject'
  label: string
  method: 'POST' | 'PATCH'
  path: string
  body: Record<string, unknown>
  input?: { field: string; label: string; required: boolean }
  confirm?: string
  disabledReason?: string
}
interface Item {
  type: string
  id: string
  tenantId: string | null
  companyName?: string | null
  title: string
  subtitle?: string | null
  facts: Array<{ label: string; value: string }>
  amountCents?: number | null
  waitingSince: string | null
  link: string | null
  actions: Action[]
  record?: HrRecord & { format: HrFormat; sectionTitle: string; employee?: { fullName: string } | null }
}
interface ApprovalInbox { total: number; elsewhere?: number; types: ApprovalTypeSummary[]; items: Item[] }

const card = { background: 'var(--surface)', border: '1px solid var(--border)' }

function waited(iso: string | null): string {
  if (!iso) return ''
  const ms = Date.now() - new Date(iso).getTime()
  if (Number.isNaN(ms)) return ''
  const h = Math.floor(ms / 3_600_000)
  if (h < 1) return 'just now'
  if (h < 24) return `${h}h waiting`
  const d = Math.floor(h / 24)
  return `${d} day${d === 1 ? '' : 's'} waiting`
}

export default function ApprovalsPage() {
  return (
    <Suspense fallback={<div className="p-8 text-sm text-white/40">Loading…</div>}>
      <ApprovalsInbox />
    </Suspense>
  )
}

function ApprovalsInbox() {
  const params = useSearchParams()
  const [filter, setFilter] = useState<string>(params?.get('type') ?? 'all')
  const [openHr, setOpenHr] = useState<Item | null>(null)
  const qc = useQueryClient()

  const { data, isLoading, error } = useQuery({
    queryKey: APPROVALS_INBOX_KEY,
    queryFn: () => api.get<ApprovalInbox>('/approvals'),
    refetchInterval: 60_000,
  })

  const items = useMemo(
    () => (data?.items ?? []).filter((i) => filter === 'all' || i.type === filter),
    [data, filter],
  )
  const companies = new Set((data?.items ?? []).map((i) => i.tenantId).filter(Boolean))
  const showCompany = companies.size > 1

  function refresh() {
    // The inbox, its badge, and the module queues that share a cache key.
    void qc.invalidateQueries({ queryKey: [APPROVALS_ROOT] })
    void qc.invalidateQueries({ queryKey: ['staff', 'pending'] })
    void qc.invalidateQueries({ queryKey: PENDING_LAYOUTS_KEY })
    void qc.invalidateQueries({ queryKey: ['hr-team'] })
    void qc.invalidateQueries({ queryKey: ['hr-approvals'] })
  }

  return (
    <div className="px-4 sm:px-6 py-6 max-w-6xl mx-auto">
      <p className="text-[11px] font-bold uppercase tracking-wider text-success">CEO</p>
      <h1 className="text-2xl sm:text-3xl font-black text-white/90">Approvals</h1>
      <p className="text-sm text-white/50 mt-1 max-w-3xl">
        Everything waiting on you, from every module. Each item stays in its own module — approving here does
        exactly what the module&rsquo;s own screen does, and the module still checks who you are.
      </p>

      {/* Counts per type */}
      <div className="mt-5 flex flex-wrap gap-2">
        <Chip on={filter === 'all'} onClick={() => setFilter('all')} label="All" count={data?.total ?? 0} />
        {(data?.types ?? []).map((t) => (
          <Chip key={t.type} on={filter === t.type} onClick={() => setFilter(t.type)} label={t.label} count={t.count} error={t.error} />
        ))}
      </div>
      {(() => {
        // Waiting in this login's other companies: counted, not listed.
        const n = filter === 'all' ? (data?.elsewhere ?? 0) : (data?.types.find((x) => x.type === filter)?.elsewhere ?? 0)
        if (n <= 0) return null
        return (
          <p className="mt-2 text-xs text-white/55">
            {n} more waiting in your other companies — switch the company view to All companies to see {n === 1 ? 'it' : 'them'}.
          </p>
        )
      })()}
      {filter !== 'all' && (() => {
        const t = data?.types.find((x) => x.type === filter)
        if (!t || t.link.startsWith('/ceo/approvals')) return null
        return (
          <Link href={t.link} className="inline-block mt-2 text-xs font-bold hover:underline" style={{ color: 'var(--erp-primary-ink)' }}>
            Open {t.label.toLowerCase()} in its module →
          </Link>
        )
      })()}

      <div className="mt-5 space-y-3">
        {isLoading && <p className="text-sm text-white/40">Loading…</p>}
        {error && <p className="text-sm" style={{ color: 'var(--erp-danger)' }}>Could not load approvals: {(error as Error).message}</p>}
        {!isLoading && !error && (data?.types.length ?? 0) === 0 && (
          <div className="rounded-2xl p-8 text-center" style={card}>
            <p className="text-sm font-bold text-white/70">Nothing for you to approve.</p>
            <p className="text-xs text-white/40 mt-1">Your role signs off none of the approval types, and no request is waiting on you as a manager.</p>
          </div>
        )}
        {!isLoading && !error && (data?.types.length ?? 0) > 0 && items.length === 0 && (
          <div className="rounded-2xl p-8 text-center" style={card}>
            <p className="text-sm font-bold text-success">Nothing is waiting on you.</p>
          </div>
        )}
        {(data?.types ?? []).filter((t) => t.error && (filter === 'all' || filter === t.type)).map((t) => (
          <p key={t.type} className="text-xs" style={{ color: 'var(--erp-warning)' }}>
            {t.label}: the module&rsquo;s queue could not be read just now. <Link href={t.link} className="underline">Open it directly</Link>.
          </p>
        ))}
        {items.map((i) => (
          <ItemCard key={`${i.type}:${i.id}`} item={i} typeLabel={data?.types.find((t) => t.type === i.type)?.label ?? i.type}
            showCompany={showCompany} onDone={refresh} onOpenHr={() => setOpenHr(i)} />
        ))}
      </div>

      {openHr?.record && <HrRecordModal item={openHr} onClose={() => setOpenHr(null)} onChanged={() => { setOpenHr(null); refresh() }} />}
    </div>
  )
}

function Chip({ on, onClick, label, count, error }: { on: boolean; onClick: () => void; label: string; count: number; error?: boolean }) {
  return (
    <button onClick={onClick}
      className="rounded-full px-3 py-1.5 text-xs font-bold flex items-center gap-1.5 transition-colors"
      style={on
        ? { background: 'var(--erp-accent-dim)', border: '1px solid var(--erp-accent)', color: 'var(--text)' }
        : { background: 'var(--surface)', border: '1px solid var(--border)', color: 'rgb(var(--fg-rgb) / 0.75)' }}>
      {label}
      <span className="rounded-full px-1.5 text-[10px] font-black"
        style={count > 0
          ? { background: 'var(--erp-primary)', color: 'var(--erp-on-primary)' }
          : { background: 'rgb(var(--fg-rgb) / 0.08)', color: 'rgb(var(--fg-rgb) / 0.5)' }}>
        {error ? '?' : count}
      </span>
    </button>
  )
}

function ItemCard({ item, typeLabel, showCompany, onDone, onOpenHr }: {
  item: Item; typeLabel: string; showCompany: boolean; onDone: () => void; onOpenHr: () => void
}) {
  const [pending, setPending] = useState<Action | null>(null)
  const [text, setText] = useState('')
  const [err, setErr] = useState<string | null>(null)

  const run = useMutation({
    mutationFn: (a: Action) => {
      const body = { ...a.body, ...(a.input && text.trim() ? { [a.input.field]: text.trim() } : {}) }
      // Pin the write to the item's company, so "All companies" view never
      // asks which company — the row already has one.
      const extra = item.tenantId ? { tenantId: item.tenantId } : undefined
      return a.method === 'PATCH' ? api.patch(a.path, body, extra) : api.post(a.path, body, extra)
    },
    onSuccess: () => { setPending(null); setText(''); setErr(null); onDone() },
    onError: (e: Error) => setErr(e.message),
  })

  function click(a: Action) {
    setErr(null)
    if (a.input) { setPending(pending?.label === a.label ? null : a); return }
    if (a.confirm && !window.confirm(a.confirm)) return
    run.mutate(a)
  }

  return (
    <div className="rounded-2xl p-4" style={card}>
      <div className="flex flex-wrap items-start gap-x-3 gap-y-1">
        <span className="text-[10px] font-black uppercase tracking-wider px-1.5 py-0.5 rounded"
          style={{ background: 'rgb(var(--fg-rgb) / 0.06)', color: 'rgb(var(--fg-rgb) / 0.6)' }}>{typeLabel}</span>
        {showCompany && item.companyName && (
          <span className="text-[10px] font-bold px-1.5 py-0.5 rounded"
            style={{ background: 'color-mix(in srgb, var(--erp-secondary) 10%, transparent)', color: 'var(--erp-secondary)' }}>{item.companyName}</span>
        )}
        <span className="ml-auto text-[11px] text-white/40">{waited(item.waitingSince)}</span>
      </div>
      <p className="mt-1.5 text-[15px] font-black text-white/90 break-words">{item.title}</p>
      {item.subtitle && <p className="text-xs text-white/50 break-words">{item.subtitle}</p>}

      {item.facts.length > 0 && (
        <dl className="mt-2 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-x-6 gap-y-1">
          {item.facts.map((f) => (
            <div key={f.label} className="flex gap-2 text-xs min-w-0">
              <dt className="text-white/40 shrink-0">{f.label}</dt>
              <dd className="text-white/75 font-semibold truncate" title={f.value}>{f.value}</dd>
            </div>
          ))}
        </dl>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        {item.actions.map((a) => a.disabledReason ? (
          <span key={a.label} className="text-xs" style={{ color: 'var(--erp-warning)' }}>{a.disabledReason}</span>
        ) : (
          <button key={a.label} onClick={() => click(a)} disabled={run.isPending}
            className="rounded-lg px-3 py-1.5 text-xs font-black disabled:opacity-50"
            style={a.kind === 'approve'
              ? { background: 'var(--erp-primary)', color: 'var(--erp-on-primary)' }
              : { background: 'transparent', border: '1px solid var(--erp-danger)', color: 'var(--erp-danger)' }}>
            {a.label}
          </button>
        ))}
        {item.record && (
          <button onClick={onOpenHr} className="rounded-lg px-3 py-1.5 text-xs font-bold"
            style={{ border: '1px solid var(--border-strong)', color: 'rgb(var(--fg-rgb) / 0.75)' }}>
            Open request
          </button>
        )}
        {item.link && (
          <Link href={item.link} className="text-xs font-bold hover:underline ml-1" style={{ color: 'var(--erp-primary-ink)' }}>
            {item.actions.length === 0 ? 'Review and act →' : 'Open in module →'}
          </Link>
        )}
      </div>

      {pending?.input && (
        <div className="mt-3 rounded-xl p-3" style={{ background: 'var(--elevated)' }}>
          <label className="text-[11px] font-bold text-white/60">{pending.input.label}</label>
          <textarea value={text} onChange={(e) => setText(e.target.value)} rows={2}
            className="mt-1 w-full rounded-lg px-2 py-1.5 text-sm"
            style={{ background: 'var(--surface)', border: '1px solid var(--border)', color: 'var(--text)' }} />
          <div className="mt-2 flex gap-2">
            <button disabled={run.isPending || (pending.input.required && !text.trim())}
              onClick={() => run.mutate(pending)}
              className="rounded-lg px-3 py-1.5 text-xs font-black disabled:opacity-50"
              style={pending.kind === 'approve'
                ? { background: 'var(--erp-primary)', color: 'var(--erp-on-primary)' }
                : { background: 'var(--erp-danger)', color: 'var(--erp-on-secondary)' }}>
              {pending.label}
            </button>
            <button onClick={() => { setPending(null); setText('') }} className="text-xs font-bold text-white/50 px-2">Cancel</button>
          </div>
        </div>
      )}
      {err && <p className="mt-2 text-xs" style={{ color: 'var(--erp-danger)' }}>{err}</p>}
    </div>
  )
}

/** An HR request in the same record view "My approvals" used — overtime
 *  hours, swaps and notes; it decides through the HR route itself. */
function HrRecordModal({ item, onClose, onChanged }: { item: Item; onClose: () => void; onChanged: () => void }) {
  const rec = item.record!
  const { data: lookups } = useHrLookups(rec.tenantId)
  const { data: org } = useHrOrg(rec.tenantId)
  return (
    <Modal title={`${rec.sectionTitle} — ${rec.employee?.fullName ?? ''}`} wide onClose={onClose}>
      <RecordDetail record={rec} format={rec.format} lookups={lookups} org={org} admin={false} onChanged={onChanged} />
    </Modal>
  )
}
