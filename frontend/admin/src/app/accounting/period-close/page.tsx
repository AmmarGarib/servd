'use client'
// Period close — THE one place books are closed and reopened (the old
// /configuration/period-locks page redirects here). Closing is CEO only and
// moves forward only; reopening (owner decision 21) is CEO only, removes the
// latest close, needs a reason, and lands on the accounting audit trail and in
// the Exceptions inbox.
//
// The checklist (GET /accounting/period-close?lockedThrough=<date>) is the
// server's ONE list of close checks for the active company: red blocks stop
// the close, amber warnings never do. The CEO may close over an overridable
// block by ticking it and giving a reason (acknowledge {keys, reason}); the
// trial balance can never be closed over. A close across the company's fiscal
// year end is a year-end close (nothing is posted — the roll-forward is
// virtual). The CEO sets the company's fiscal year end month here too.
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useEffect, useMemo, useState } from 'react'
import { api, ApiError } from '../../../lib/api'
import { fmtPkr } from '../../../lib/money'
import { useAuthStore } from '../../../store/auth'
import Link from 'next/link'
import { Select } from '@/components/ui/Select'

// The latest day that can be closed is YESTERDAY, Pakistan time — today is
// still trading, and POST /accounting/period-close refuses it with 422
// LOCK_IN_FUTURE (BOOKS-R2-01). PKT is a fixed UTC+5 (no daylight saving).
function yesterdayPktIso(): string {
  const pkt = new Date(Date.now() + 5 * 3600_000)
  pkt.setUTCDate(pkt.getUTCDate() - 1)
  return pkt.toISOString().slice(0, 10)
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']

interface CloseProblem {
  key: string
  severity: 'block' | 'warn'
  title: string
  detail: string
  count: number
  cents?: number
  months?: string[]
  link: string
  fix?: { method: 'POST'; path: string; label: string }
  overridable: boolean
}

/**
 * Who may press a check's one-click fix: the roles the fix's OWN route admits
 * (the server still decides). Finance runs the routine month-end jobs; the
 * fleet recharge stays the CEO's. A fix path not listed here is CEO-only.
 *   /accounting/fixed-assets/depreciate   fixedAssets FA_WRITER_ROLES
 *   /finance/prepaid-releases             financePlanning FA_WRITERS
 *   /reconciliation/card-payouts/rematch  cardPayoutRoutes SETTINGS_EDITORS
 *   /hr/final-settlement/post-unposted    hr PAYROLL_PAYERS (finance with accounting)
 *   /accounting/intercompany/fleet/charge ADMIN_ONLY
 */
const FIX_ROLES: Record<string, readonly string[]> = {
  '/accounting/fixed-assets/depreciate': ['admin', 'finance'],
  '/finance/prepaid-releases': ['admin', 'finance'],
  '/reconciliation/card-payouts/rematch': ['admin', 'finance'],
  '/hr/final-settlement/post-unposted': ['admin', 'finance'],
}
const fixRolesOf = (path: string): readonly string[] => FIX_ROLES[path.split('?')[0]!] ?? ['admin']

interface Override { key: string; title?: string; count?: number; cents?: number; via?: string }

interface CloseState {
  tenantId: string | null
  lockedThrough: string | null
  lockedAt: string | null
  lockedBy: string | null
  note: string | null
  overrides: Override[] | null
  overrideReason: string | null
  through: string | null
  checks: CloseProblem[]
  months: string[]
  isYearEnd: boolean
  closesFiscalYear: string | null
  fiscalYear: { endMonth: number; label: string; start: string; end: string } | null
  ready: boolean
}

interface HistoryLock {
  id: string
  lockedThrough: string
  lockedThroughLabel: string
  lockedAt: string
  lockedByName: string | null
  note: string | null
  overrides: Override[] | null
  overrideReason: string | null
}

interface FiscalYearCompany { tenantId: string; name: string; endMonth: number; label: string; currentStart: string; currentEnd: string; closedAcrossYearEnd: boolean }

function Chip({ kind, children }: { kind: 'block' | 'warn' | 'clear' | 'fixed'; children: React.ReactNode }) {
  const cls = kind === 'block' ? 's-badge-red' : kind === 'warn' ? 's-badge-amber' : kind === 'clear' ? 's-badge-green' : 's-badge-muted'
  return <span className={`${cls} text-[11px] whitespace-nowrap`}>{children}</span>
}

export default function PeriodClosePage() {
  const qc = useQueryClient()
  const isAdmin = useAuthStore((s) => s.isRole('admin'))
  const myRole = useAuthStore((s) => s.user?.role ?? null)
  const [lockedThrough, setLockedThrough] = useState(yesterdayPktIso())
  const [note, setNote] = useState('')
  const [reopenReason, setReopenReason] = useState('')
  const [feedback, setFeedback] = useState<{ ok: boolean; msg: string } | null>(null)
  // Blocks the CEO closes over, and why.
  const [ticked, setTicked] = useState<Set<string>>(new Set())
  const [overrideReason, setOverrideReason] = useState('')
  const [fyMonth, setFyMonth] = useState<number | null>(null)
  const [fyReason, setFyReason] = useState('')
  const [fyNeedsReason, setFyNeedsReason] = useState(false)

  const validDate = /^\d{4}-\d{2}-\d{2}$/.test(lockedThrough)
  const { data: state, isFetching: checking } = useQuery({
    queryKey: ['period-close', 'check', lockedThrough],
    queryFn: () => api.get<CloseState>(`/accounting/period-close?lockedThrough=${encodeURIComponent(lockedThrough)}`),
    enabled: validDate,
  })
  const { data: history } = useQuery({
    queryKey: ['period-close', 'history'],
    queryFn: () => api.get<{ locks: HistoryLock[] }>('/accounting/period-close/history'),
  })
  const { data: fiscal } = useQuery({
    queryKey: ['period-close', 'fiscal-year'],
    queryFn: () => api.get<{ companies: FiscalYearCompany[] }>('/accounting/fiscal-year'),
  })
  const myFy = fiscal?.companies.find((c) => c.tenantId === state?.tenantId) ?? null

  // A new date (or a refreshed list) drops ticks for blocks no longer there.
  useEffect(() => {
    const keys = new Set((state?.checks ?? []).filter((c) => c.severity === 'block' && c.overridable).map((c) => c.key))
    setTicked((prev) => new Set([...prev].filter((k) => keys.has(k))))
  }, [state?.checks])
  useEffect(() => {
    if (myFy && fyMonth === null) setFyMonth(myFy.endMonth)
    if (myFy) setFyNeedsReason(myFy.closedAcrossYearEnd)
  }, [myFy, fyMonth])

  const refresh = () => void qc.invalidateQueries({ queryKey: ['period-close'] })

  const blocks = useMemo(() => (state?.checks ?? []).filter((c) => c.severity === 'block'), [state?.checks])
  const warnings = useMemo(() => (state?.checks ?? []).filter((c) => c.severity === 'warn'), [state?.checks])
  const fixedOnly = blocks.filter((b) => !b.overridable)
  const untickedBlocks = blocks.filter((b) => b.overridable && !ticked.has(b.key))
  const needsReason = ticked.size > 0
  const reasonOk = !needsReason || overrideReason.trim().length >= 10
  const maxLock = yesterdayPktIso()
  const canClose = !!state && validDate && lockedThrough <= maxLock && fixedOnly.length === 0 && untickedBlocks.length === 0 && reasonOk

  const close = useMutation({
    mutationFn: () => api.post('/accounting/period-close', {
      lockedThrough,
      ...(note.trim() ? { note: note.trim() } : {}),
      ...(ticked.size > 0 ? { acknowledge: { keys: [...ticked], reason: overrideReason.trim() } } : {}),
    }),
    onSuccess: () => {
      setFeedback({
        ok: true,
        msg: `Books closed through ${lockedThrough}${ticked.size > 0 ? ` over ${ticked.size} blocking check${ticked.size === 1 ? '' : 's'} (on the audit trail and in the Exceptions inbox)` : ''}${state?.isYearEnd ? ` — year-end close of ${state.closesFiscalYear ?? 'the fiscal year'}` : ''}.`,
      })
      setNote('')
      setTicked(new Set())
      setOverrideReason('')
      refresh()
    },
    // The API's message is shown as-is (LOCK_IN_FUTURE names the latest date;
    // CLOSE_NOT_READY / RAAST_UNMATCHED name what blocks) and the list is re-read.
    onError: (err: Error) => {
      if (err instanceof ApiError && (err.code === 'CLOSE_NOT_READY' || err.code === 'RAAST_UNMATCHED')) refresh()
      setFeedback({ ok: false, msg: err.message || 'Failed to close the period' })
    },
  })

  const fix = useMutation({
    mutationFn: (p: CloseProblem) => api.post(p.fix!.path, {}),
    onSuccess: (_d, p) => { setFeedback({ ok: true, msg: `${p.fix!.label}: done. The checklist is re-read.` }); refresh() },
    onError: (err: Error) => setFeedback({ ok: false, msg: err.message || 'That fix did not run' }),
  })

  const reopen = useMutation({
    mutationFn: (reason: string) => api.post<{ lockedThrough: string | null }>('/accounting/period-close/reopen', { reason }),
    onSuccess: () => {
      setFeedback({ ok: true, msg: 'Latest close reopened — the reopening is on the audit trail and in the Exceptions inbox.' })
      setReopenReason('')
      refresh()
    },
    onError: (err: Error) => setFeedback({ ok: false, msg: err.message || 'Failed to reopen' }),
  })

  const saveFy = useMutation({
    mutationFn: () => api.patch(`/tenants/${state!.tenantId}`, { fiscalYearEndMonth: fyMonth, ...(fyReason.trim() ? { reason: fyReason.trim() } : {}) }),
    onSuccess: () => {
      setFeedback({ ok: true, msg: `Fiscal year now ends in ${MONTHS[(fyMonth ?? 6) - 1]}. Balance sheet and trial balance split on the new year end.` })
      setFyReason('')
      refresh()
    },
    onError: (err: Error) => {
      if (err instanceof ApiError && err.code === 'FY_CHANGE_AFTER_YEAR_END_CLOSE') setFyNeedsReason(true)
      setFeedback({ ok: false, msg: err.message || 'Could not change the fiscal year end' })
    },
  })

  const toggle = (key: string) => setTicked((prev) => {
    const next = new Set(prev)
    if (next.has(key)) next.delete(key)
    else next.add(key)
    return next
  })

  const lockedThroughDisplay = state?.lockedThrough
    ? history?.locks[0]?.lockedThroughLabel ?? new Date(state.lockedThrough).toLocaleDateString('en-GB', { timeZone: 'Asia/Karachi' })
    : 'Open'

  return (
    <div className="min-h-screen bg-s-bg">
      <header className="sticky top-0 z-10 bg-s-bg/80 backdrop-blur border-b border-s-border px-4 sm:px-6 py-4">
        <Link href="/accounting" className="text-xs text-s-muted hover:text-s-text">← Accounting</Link>
        <h1 className="text-xl font-bold text-s-text">Period Close</h1>
      </header>

      <div className="p-4 sm:p-6 max-w-3xl mx-auto space-y-4">
        {feedback && (
          <div role={feedback.ok ? 'status' : 'alert'} className={`s-card p-3 text-sm ${feedback.ok ? 'text-success' : 'text-s-red'}`}>
            {feedback.msg}
          </div>
        )}

        <div className="s-card p-4">
          <p className="text-xs text-s-muted">Books are currently closed through</p>
          <p className="text-2xl font-bold text-s-text">{lockedThroughDisplay}</p>
          {state?.lockedAt && (
            <p className="text-xs text-s-muted mt-2">
              Locked at {new Date(state.lockedAt).toLocaleString()} by {history?.locks[0]?.lockedByName ?? state.lockedBy}
              {state.note && <> — {state.note}</>}
            </p>
          )}
          {state?.overrides && state.overrides.length > 0 && (
            <p className="text-xs text-s-muted mt-1">
              Closed over: {state.overrides.map((o) => o.title ?? o.key).join(', ')}{state.overrideReason ? ` — ${state.overrideReason}` : ''}
            </p>
          )}
        </div>

        {/* Fiscal year (H29): the CEO sets the month the company's year ends. */}
        {state?.fiscalYear && (
          <div className="s-card p-4 space-y-2">
            <h3 className="text-sm font-semibold text-s-text">Fiscal year</h3>
            <p className="text-xs text-s-muted">
              The year ends on the last day of <strong className="text-s-text">{MONTHS[state.fiscalYear.endMonth - 1]}</strong>.
              {myFy && <> The current year, {myFy.label}, runs {myFy.currentStart} to {myFy.currentEnd}.</>}{' '}
              Nothing is posted at year end: the balance sheet shows profit before the year started as retained earnings brought forward.
            </p>
            {isAdmin && state.tenantId && (
              <div className="flex flex-col sm:flex-row gap-2 sm:items-end">
                <div className="flex-1">
                  <label htmlFor="fy-month" className="block text-xs text-s-muted">Year-end month</label>
                  <Select id="fy-month" value={fyMonth ?? state.fiscalYear.endMonth} onChange={(e) => setFyMonth(Number(e.target.value))}
                    className="w-full bg-s-card border border-s-border rounded px-3 py-2 text-sm text-s-text">
                    {MONTHS.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}
                  </Select>
                </div>
                {fyNeedsReason && (
                  <div className="flex-[2]">
                    <label htmlFor="fy-reason" className="block text-xs text-s-muted">Reason (books are already closed across a year end)</label>
                    <input id="fy-reason" type="text" value={fyReason} onChange={(e) => setFyReason(e.target.value)} placeholder="e.g. auditors moved us to a calendar year"
                      className="w-full bg-s-card border border-s-border rounded px-3 py-2 text-sm text-s-text" />
                  </div>
                )}
                <button
                  onClick={() => saveFy.mutate()}
                  disabled={saveFy.isPending || fyMonth === null || fyMonth === state.fiscalYear.endMonth || (fyNeedsReason && fyReason.trim().length < 10)}
                  className="s-btn-secondary text-sm"
                >
                  {saveFy.isPending ? 'Saving…' : 'Save year end'}
                </button>
              </div>
            )}
          </div>
        )}

        <div className="s-card p-4 space-y-3">
          <h3 className="text-sm font-semibold text-s-text">Close a new period</h3>
          <p className="text-xs text-s-muted">
            After closing, postings dated on or before the end of this day (Pakistan time) are rejected. Lock dates only move forward. Today is still trading, so the latest day you can close is yesterday ({maxLock}).
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label htmlFor="lock-through" className="block text-xs text-s-muted">Lock through (inclusive)</label>
              <input id="lock-through" type="date" value={lockedThrough} max={maxLock} onChange={(e) => setLockedThrough(e.target.value)}
                className="w-full bg-s-card border border-s-border rounded px-3 py-2 text-sm text-s-text" />
            </div>
            <div>
              <label htmlFor="lock-note" className="block text-xs text-s-muted">Note (optional)</label>
              <input id="lock-note" type="text" value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. August month-end signed off"
                className="w-full bg-s-card border border-s-border rounded px-3 py-2 text-sm text-s-text" />
            </div>
          </div>

          {state?.isYearEnd && (
            <div className="rounded-lg border border-s-border p-3 text-xs" style={{ background: 'rgb(var(--erp-primary-rgb) / 0.06)' }}>
              <p className="text-s-text font-semibold">Year-end close{state.closesFiscalYear ? ` — ${state.closesFiscalYear}` : ''}</p>
              <p className="text-s-muted mt-1">
                This close passes the company&rsquo;s fiscal year end. From then on that year&rsquo;s profit shows as retained earnings brought forward. Nothing is posted, and reopening needs nothing reversed.
              </p>
            </div>
          )}

          <div className="space-y-2">
            <div className="flex items-center justify-between gap-2">
              <p className="text-xs font-semibold text-s-text">
                Checklist{state?.months?.length ? ` (${state.months[0]}${state.months.length > 1 ? ` to ${state.months[state.months.length - 1]}` : ''})` : ''}
              </p>
              {checking && <span className="text-[11px] text-s-muted">Checking…</span>}
            </div>
            {state && blocks.length === 0 && (
              <div className="flex items-center gap-2 text-xs">
                <Chip kind="clear">Clear</Chip>
                <span className="text-s-text">Nothing blocks closing through {state.through}.</span>
              </div>
            )}
            {[...blocks, ...warnings].map((p) => {
              const tick = ticked.has(p.key)
              return (
                <div key={p.key} className="rounded-lg border border-s-border p-3 space-y-1.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <Chip kind={p.severity === 'warn' ? 'warn' : tick ? 'fixed' : 'block'}>
                      {p.severity === 'warn' ? 'Warning' : tick ? 'Closing over' : 'Blocks the close'}
                    </Chip>
                    <span className="text-sm font-medium text-s-text">{p.title}</span>
                    <span className="text-xs text-s-muted">
                      {p.count}{p.cents ? ` · ${fmtPkr(p.cents)}` : ''}{p.months?.length ? ` · ${p.months.join(', ')}` : ''}
                    </span>
                  </div>
                  <p className="text-xs text-s-muted">{p.detail}</p>
                  <div className="flex flex-wrap items-center gap-3 text-xs">
                    <Link href={p.link} className="text-primary-ink underline">Open</Link>
                    {p.fix && myRole && fixRolesOf(p.fix.path).includes(myRole) && (
                      <button onClick={() => fix.mutate(p)} disabled={fix.isPending} className="s-btn-secondary text-xs">
                        {fix.isPending && fix.variables?.key === p.key ? 'Working…' : p.fix.label}
                      </button>
                    )}
                    {p.severity === 'block' && !p.overridable && (
                      <span className="text-s-red">Must be fixed — this cannot be closed over.</span>
                    )}
                    {p.severity === 'block' && p.overridable && isAdmin && (
                      <label className="flex items-center gap-1.5 text-s-text">
                        <input type="checkbox" className="accent-primary" checked={tick} onChange={() => toggle(p.key)} />
                        Close over this (CEO, with a reason)
                      </label>
                    )}
                  </div>
                </div>
              )
            })}
          </div>

          {isAdmin && needsReason && (
            <div>
              <label htmlFor="override-reason" className="block text-xs text-s-muted">Why close over {ticked.size === 1 ? 'this check' : 'these checks'}? (at least 10 characters — kept on the close, the audit trail and the Exceptions inbox)</label>
              <textarea id="override-reason" value={overrideReason} onChange={(e) => setOverrideReason(e.target.value)} rows={2}
                className="w-full bg-s-card border border-s-border rounded px-3 py-2 text-sm text-s-text" />
            </div>
          )}

          {isAdmin ? (
            <button onClick={() => close.mutate()} disabled={close.isPending || !canClose} className="s-btn-primary text-sm w-full">
              {close.isPending ? 'Closing…' : state?.isYearEnd ? 'Close period (year end)' : 'Close period'}
            </button>
          ) : (
            <p className="text-xs text-s-muted">Only the CEO closes the books.</p>
          )}
          {isAdmin && state && !canClose && !close.isPending && (
            <p className="text-[11px] text-s-muted">
              {fixedOnly.length > 0
                ? 'Fix the checks marked "must be fixed" first.'
                : untickedBlocks.length > 0
                  ? 'Fix the blocking checks, or tick them to close over them with a reason.'
                  : !reasonOk ? 'Give a reason of at least 10 characters.' : ''}
            </p>
          )}
        </div>

        {isAdmin && state?.lockedThrough && (
          <div className="s-card p-4 space-y-3 border-l-4 border-s-red">
            <h3 className="text-sm font-semibold text-s-text">Reopen the latest close</h3>
            <p className="text-xs text-s-muted">
              Removes only the most recent close. The reopening is written to the accounting audit trail and raised in the Exceptions inbox. Say why.
            </p>
            <label htmlFor="reopen-reason" className="block text-xs text-s-muted">Reason (required)</label>
            <input id="reopen-reason" type="text" value={reopenReason} onChange={(e) => setReopenReason(e.target.value)}
              placeholder="e.g. supplier bill for August arrived late"
              className="w-full bg-s-card border border-s-border rounded px-3 py-2 text-sm text-s-text" />
            <button
              onClick={() => reopen.mutate(reopenReason.trim())}
              disabled={reopen.isPending || reopenReason.trim().length < 5}
              className="s-btn-danger text-sm w-full"
            >
              {reopen.isPending ? 'Reopening…' : 'Reopen'}
            </button>
          </div>
        )}

        <div className="s-card overflow-hidden">
          <div className="px-4 py-3 border-b border-s-border bg-s-bg-soft">
            <h3 className="text-sm font-semibold text-s-text">Close history</h3>
          </div>
          {(history?.locks ?? []).length === 0 ? (
            <p className="px-4 py-6 text-xs text-s-muted text-center">No period has been closed for this company.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-xs text-s-muted">
                  <tr>
                    <th className="px-4 py-2 text-left">Closed through</th>
                    <th className="px-4 py-2 text-left">When</th>
                    <th className="px-4 py-2 text-left">By</th>
                    <th className="px-4 py-2 text-left">Closed over</th>
                    <th className="px-4 py-2 text-left">Note</th>
                  </tr>
                </thead>
                <tbody>
                  {history!.locks.map((l) => (
                    <tr key={l.id} className="border-t border-s-border align-top">
                      <td className="px-4 py-2 font-mono text-xs text-s-text whitespace-nowrap">{l.lockedThroughLabel}</td>
                      <td className="px-4 py-2 text-xs text-s-muted whitespace-nowrap">{new Date(l.lockedAt).toLocaleString()}</td>
                      <td className="px-4 py-2 text-xs text-s-text">{l.lockedByName ?? '—'}</td>
                      <td className="px-4 py-2 text-xs text-s-muted">
                        {l.overrides && l.overrides.length > 0
                          ? <>{l.overrides.map((o) => o.title ?? o.key).join(', ')}{l.overrideReason ? <> — <span className="text-s-text">{l.overrideReason}</span></> : null}</>
                          : ''}
                      </td>
                      <td className="px-4 py-2 text-xs text-s-muted">{l.note ?? ''}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
