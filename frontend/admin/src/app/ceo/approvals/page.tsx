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
import { ApprovalActionDialog } from '../../../components/approvals/ApprovalActionDialog'
import {
  APPROVALS_INBOX_KEY, APPROVALS_ROOT, useHeadOffices,
  type ApprovalAction as Action, type ApprovalHandedOverTo, type ApprovalSectionId, type ApprovalSectionSummary, type ApprovalTypeSummary,
} from '../approvalsData'
import { useAuthStore } from '../../../store/auth'
import { useConfirm } from '../../../components/ui/ConfirmDialog'

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
  section?: ApprovalSectionId
  viaHeadOfficeId?: string | null
  /** Sent by the API when it can name the head office (delegates cannot read /head-offices). */
  viaHeadOfficeName?: string | null
  handedOverTo?: ApprovalHandedOverTo
}
interface ApprovalInbox {
  total: number; elsewhere?: number; types: ApprovalTypeSummary[]; items: Item[]
  sections?: ApprovalSectionSummary[]; handedOver?: number; handedOverItems?: Item[]
}

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
  const [doneMsg, setDoneMsg] = useState<string | null>(null)
  const qc = useQueryClient()

  const { data, isLoading, error } = useQuery({
    queryKey: APPROVALS_INBOX_KEY,
    queryFn: () => api.get<ApprovalInbox>('/approvals'),
    refetchInterval: 60_000,
  })

  const isCeo = useAuthStore((st) => st.isRole('admin'))
  const { data: offices = [] } = useHeadOffices(isCeo)
  const hoName = (id?: string | null) => id ? (offices.find((o) => o.id === id)?.name ?? null) : null
  const [section, setSection] = useState<string>('all')
  const [showHanded, setShowHanded] = useState(false)

  const sections = data?.sections ?? []
  // Section tabs only matter when there is more than one section or a hand-over.
  const showTabs = sections.length > 1 || (data?.handedOver ?? 0) > 0
  const inSection = (i: { type: string; section?: string }) =>
    section === 'all' || (i.section ?? data?.types.find((t) => t.type === i.type)?.section) === section
  const types = (data?.types ?? []).filter((t) => section === 'all' || !t.section || t.section === section)
  const items = useMemo(
    () => (data?.items ?? []).filter((i) => inSection(i) && (filter === 'all' || i.type === filter)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [data, filter, section],
  )
  const handedItems = (data?.handedOverItems ?? []).filter((i) => inSection(i))
  const groups = useMemo(() => {
    const m = new Map<string, Item[]>()
    for (const i of items) m.set(i.type, [...(m.get(i.type) ?? []), i])
    return [...m.entries()]
  }, [items])
  const companies = new Set([...(data?.items ?? []), ...(data?.handedOverItems ?? [])].map((i) => i.tenantId).filter(Boolean))
  const showCompany = companies.size > 1
  const typeLabel = (t: string) => data?.types.find((x) => x.type === t)?.label ?? t

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

      {isCeo && (
        <Link href="/ceo/approvals/hand-over" className="inline-block mt-2 text-xs font-bold hover:underline" style={{ color: 'var(--erp-primary-ink)' }}>
          Hand over approvals to head office →
        </Link>
      )}

      {showTabs && (
        <div className="mt-5 flex gap-2 overflow-x-auto sm:flex-wrap pb-1 [scrollbar-width:thin]" role="group" aria-label="Section">
          <Chip on={section === 'all'} onClick={() => { setSection('all'); setFilter('all') }} label="All" count={data?.total ?? 0} />
          {sections.filter((sc) => sc.count > 0 || section === sc.id).map((sc) => (
            <Chip key={sc.id} on={section === sc.id} onClick={() => { setSection(sc.id); setFilter('all') }}
              label={sc.id === 'ceo' ? 'CEO only' : sc.title} count={sc.count} />
          ))}
        </div>
      )}

      {/* Counts per type */}
      <div className="mt-4 flex gap-2 overflow-x-auto sm:flex-wrap pb-1 [scrollbar-width:thin]" role="group" aria-label="Type">
        <Chip on={filter === 'all'} onClick={() => setFilter('all')} label={showTabs ? 'Every type' : 'All'}
          count={section === 'all' ? (data?.total ?? 0) : (sections.find((x) => x.id === section)?.count ?? 0)} />
        {types.filter((t) => t.count > 0 || t.error || filter === t.type).map((t) => (
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
        <div role="status" aria-live="polite">
          {doneMsg && (
            <p className="rounded-xl px-3 py-2 text-sm font-bold break-words" style={{ background: 'rgb(var(--erp-accent-rgb) / 0.15)', color: 'var(--erp-success)' }}>
              {doneMsg}
            </p>
          )}
        </div>
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
        {groups.map(([type, rows]) => (
          <section key={type} className="space-y-3">
            {(groups.length > 1 || showTabs) && (
              <h2 className="text-xs font-black uppercase tracking-wider text-white/50 pt-1">
                {typeLabel(type)} <span className="text-white/35">{rows.length}</span>
              </h2>
            )}
            {rows.map((i) => (
              <ItemCard key={`${i.type}:${i.id}`} item={i} typeLabel={typeLabel(i.type)} viaName={i.viaHeadOfficeName ?? hoName(i.viaHeadOfficeId)}
                showCompany={showCompany} onDone={refresh} onDecided={setDoneMsg} onOpenHr={() => setOpenHr(i)} />
            ))}
          </section>
        ))}
        {handedItems.length > 0 && (
          <div className="rounded-2xl" style={card}>
            <button onClick={() => setShowHanded((v) => !v)} aria-expanded={showHanded}
              className="w-full flex items-center gap-2 px-4 py-3 text-left">
              <span className="text-sm font-black text-white/80">
                {handedLabel(handedItems)}
              </span>
              <span className="rounded-full px-1.5 text-[10px] font-black" style={{ background: 'rgb(var(--fg-rgb) / 0.08)', color: 'rgb(var(--fg-rgb) / 0.6)' }}>{handedItems.length}</span>
              <span className="ml-auto text-xs text-white/45">{showHanded ? 'Hide' : 'Show'}</span>
            </button>
            {showHanded && (
              <div className="px-3 pb-3 space-y-3">
                <p className="text-xs text-white/50 px-1">You can still decide these yourself; the first decision wins.</p>
                {handedItems.map((i) => (
                  <ItemCard key={`h:${i.type}:${i.id}`} item={i} typeLabel={typeLabel(i.type)} viaName={i.viaHeadOfficeName ?? hoName(i.viaHeadOfficeId)}
                    showCompany={showCompany} onDone={refresh} onDecided={setDoneMsg} onOpenHr={() => setOpenHr(i)} />
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {openHr?.record && <HrRecordModal item={openHr} onClose={() => setOpenHr(null)} onChanged={() => { setOpenHr(null); refresh() }} />}
    </div>
  )
}

function handedLabel(rows: Item[]): string {
  const names = [...new Set(rows.map((r) => r.handedOverTo?.name).filter(Boolean))]
  const ends = rows.map((r) => r.handedOverTo?.endsAt).filter((x): x is string => !!x).sort()
  const who = names.length === 1 ? names[0] : names.length > 1 ? `${names.length} people` : 'a delegate'
  const until = ends.length === rows.filter((r) => r.handedOverTo).length && ends.length > 0
    ? ` until ${new Date(ends[ends.length - 1]!).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}` : ''
  return `Handed over to ${who}${until}`
}

function Chip({ on, onClick, label, count, error }: { on: boolean; onClick: () => void; label: string; count: number; error?: boolean }) {
  return (
    <button onClick={onClick} aria-pressed={on}
      className="rounded-full px-3 py-2 text-xs font-bold flex items-center gap-1.5 whitespace-nowrap shrink-0 transition-colors"
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

function doneVerb(a: Action): string {
  return a.kind === 'approve' ? 'Approved' : a.kind === 'return' ? 'Returned' : 'Rejected'
}

function ItemCard({ item, typeLabel, viaName, showCompany, onDone, onDecided, onOpenHr }: {
  item: Item; typeLabel: string; viaName: string | null; showCompany: boolean; onDone: () => void
  onDecided: (msg: string) => void; onOpenHr: () => void
}) {
  const confirm = useConfirm()
  const [pending, setPending] = useState<Action | null>(null)
  const [err, setErr] = useState<string | null>(null)

  // A button with no input and no tick-boxes is one click; the rest open the dialog.
  const run = useMutation({
    mutationFn: (a: Action) => {
      // Pin the write to the item's company, so "All companies" view never
      // asks which company — the row already has one.
      const extra = item.tenantId ? { tenantId: item.tenantId } : undefined
      return a.method === 'PATCH' ? api.patch(a.path, a.body, extra) : api.post(a.path, a.body, extra)
    },
    onSuccess: (_r, a) => { setErr(null); onDecided(`${doneVerb(a)}: ${item.title}`); onDone() },
    onError: (e: Error) => setErr(e.message),
  })

  function click(a: Action) {
    setErr(null)
    // Buttons that need text or tick-boxes open the dialog, which already
    // shows the confirm text inline. A one-click button with a confirm text has
    // no inline copy, so it asks once, in the shared dialog.
    if (a.input || (a.options?.length ?? 0) > 0) { setPending(pending?.label === a.label ? null : a); return }
    if (a.confirm) {
      void confirm({ title: a.label, body: a.confirm, confirmLabel: a.label, danger: a.kind !== 'approve' })
        .then((r) => { if (r) run.mutate(a) })
      return
    }
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
        {item.viaHeadOfficeId && (
          <span className="text-[10px] font-bold px-1.5 py-0.5 rounded"
            style={{ background: 'rgb(var(--erp-accent-rgb) / 0.15)', color: 'var(--erp-success)' }}>via {viaName ?? 'head office'}</span>
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
              : a.kind === 'return'
                ? { background: 'transparent', border: '1px solid var(--border-strong)', color: 'rgb(var(--fg-rgb) / 0.8)' }
                : { background: 'transparent', border: '1px solid var(--erp-danger)', color: 'var(--erp-danger)' }}>
            {run.isPending && run.variables?.label === a.label
              ? (a.kind === 'approve' ? 'Approving…' : a.kind === 'return' ? 'Returning…' : 'Rejecting…')
              : a.label}
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

      {pending && (
        <ApprovalActionDialog action={pending} tenantId={item.tenantId}
          warnings={item.facts.find((f) => f.label === 'Warnings')?.value ?? null}
          onClose={() => setPending(null)} onDone={() => { onDecided(`${doneVerb(pending)}: ${item.title}`); setPending(null); onDone() }} />
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
