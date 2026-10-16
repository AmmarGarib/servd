'use client'
// One business day: status, the live checks for its step, run / settle /
// push-through, the report, reopen and history.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import Link from 'next/link'
import { api, ApiError } from '../../../lib/api'
import { fmtPkr } from '../../../lib/money'
import { useConfirm } from '@/components/ui/ConfirmDialog'
import { DailyReportView } from './DailyReportView'
import { PushThrough } from './PushThrough'
import {
  type CloseProblem, type DailyReport, type DayDetail, type CheckLine,
  MIN_REASON, fmtDayLong, fmtWhen,
} from './types'

type Tab = 'checks' | 'report' | 'history'
const BASE = '/accounting/night-audit'

function statusChip(d: DayDetail): { cls: string; label: string } {
  if (d.status === 'closed') return { cls: 's-badge-green', label: 'Closed' }
  if (d.status === 'audited') return { cls: 's-badge-purple', label: 'Awaiting settlement' }
  return { cls: 's-badge-muted', label: 'Not run' }
}

function ProblemCard({ p, canFix, onFix, fixing }: { p: CloseProblem; canFix: boolean; onFix: (p: CloseProblem) => void; fixing: boolean }) {
  return (
    <div className="rounded-lg border border-s-border p-3 space-y-1.5">
      <div className="flex flex-wrap items-center gap-2">
        <span className={`${p.severity === 'block' ? 's-badge-red' : 's-badge-amber'} text-[11px]`}>{p.severity === 'block' ? 'Blocks' : 'Warning'}</span>
        <span className="text-sm font-medium text-s-text">{p.title}</span>
        <span className="text-xs text-s-muted">{p.count}{p.cents ? ` · ${fmtPkr(p.cents)}` : ''}</span>
      </div>
      <p className="text-xs text-s-muted">{p.detail}</p>
      <div className="flex flex-wrap items-center gap-3 text-xs">
        <Link href={p.link} className="text-primary-ink underline">Fix it</Link>
        {p.fix && canFix && (
          <button type="button" onClick={() => onFix(p)} disabled={fixing} className="s-btn-secondary text-xs">{p.fix.label}</button>
        )}
      </div>
    </div>
  )
}

function Overrides({ title, list, reason }: { title: string; list: CheckLine[] | null; reason: string | null }) {
  if (!list || list.length === 0) return null
  return (
    <p className="text-xs text-s-muted">
      {title}: {list.map((o) => o.title).join(', ')}{reason ? <> — <span className="text-s-text">{reason}</span></> : null}
    </p>
  )
}

export function DayPanel({ day, onClose, notify }: {
  day: string
  onClose: () => void
  notify: (f: { ok: boolean; msg: string }) => void
}) {
  const qc = useQueryClient()
  const confirm = useConfirm()
  const [tab, setTab] = useState<Tab>('checks')

  const key = ['night-audit', 'day', day]
  const { data: d, isLoading, error } = useQuery({
    queryKey: key,
    queryFn: () => api.get<DayDetail>(`${BASE}/${day}`),
  })
  const live = !!d && d.status === 'open'
  const { data: preview } = useQuery({
    queryKey: ['night-audit', 'report-live', day],
    queryFn: () => api.get<{ report: DailyReport; live: boolean }>(`${BASE}/${day}/report?live=1`),
    enabled: tab === 'report' && live && d!.active,
  })

  const refresh = () => void qc.invalidateQueries({ queryKey: ['night-audit'] })
  // A NOT_READY refusal carries the fresh problems: put them straight in the panel.
  const onFail = (err: Error) => {
    if (err instanceof ApiError && (err.code === 'NIGHT_AUDIT_NOT_READY' || err.code === 'SETTLEMENT_NOT_READY')) {
      const det = err.details as { problems?: CloseProblem[]; blocks?: CloseProblem[] } | undefined
      if (det?.problems && d?.checks) {
        const problems = det.problems
        qc.setQueryData<DayDetail>(key, {
          ...d,
          checks: {
            ...d.checks,
            problems,
            blocks: det.blocks ?? problems.filter((p) => p.severity === 'block'),
            warnings: problems.filter((p) => p.severity === 'warn'),
            ready: false,
          },
        })
      } else refresh()
    } else if (err instanceof ApiError && err.code === 'EARLIER_DAYS_OPEN') refresh()
    notify({ ok: false, msg: err.message || 'That did not go through' })
  }

  type Ack = { keys: string[]; reason: string }
  const run = useMutation({
    mutationFn: (ack?: Ack) => api.post<DayDetail>(`${BASE}/${day}/run`, ack ? { acknowledge: ack } : {}),
    onSuccess: (r) => { notify({ ok: true, msg: r.status === 'closed' ? `${day} audited and closed.` : `${day} audited — awaiting settlement.` }); refresh() },
    onError: onFail,
  })
  const settle = useMutation({
    mutationFn: (ack?: Ack) => api.post<DayDetail>(`${BASE}/${day}/settle`, ack ? { acknowledge: ack } : {}),
    onSuccess: () => { notify({ ok: true, msg: `${day} closed.` }); refresh() },
    onError: onFail,
  })
  const reopen = useMutation({
    mutationFn: (reason: string) => api.post<DayDetail>(`${BASE}/${day}/reopen`, { reason }),
    onSuccess: () => { notify({ ok: true, msg: `${day} reopened. Later days stay locked; run this day again.` }); refresh() },
    onError: onFail,
  })
  const fix = useMutation({
    mutationFn: (p: CloseProblem) => api.post(p.fix!.path, {}),
    onSuccess: (_x, p) => { notify({ ok: true, msg: `${p.fix!.label}: done. Checks re-read.` }); refresh() },
    onError: (e: Error) => notify({ ok: false, msg: e.message || 'That fix did not run' }),
  })

  const doReopen = async () => {
    const r = await confirm({
      title: `Reopen ${day}?`,
      body: 'The day unlocks for back-dated postings. It is audited and raised in Exceptions. Later days stay locked, and you run this day again afterwards.',
      confirmLabel: 'Reopen day',
      danger: true,
      reason: { label: 'Reason', minLength: MIN_REASON },
    })
    if (r && r.reason) reopen.mutate(r.reason.trim())
  }

  const report = live ? preview?.report ?? null : d?.report ?? null

  return (
    <div className="s-card p-4 space-y-4" id="na-day-panel">
      <div className="flex items-start justify-between gap-2 na-noprint">
        <div>
          <h3 className="text-base font-semibold text-s-text">{fmtDayLong(day)}</h3>
          {d && <span className={`${statusChip(d).cls} text-[11px] mt-1 inline-block`}>{statusChip(d).label}</span>}
        </div>
        <button type="button" onClick={onClose} className="s-btn-secondary text-xs">Close</button>
      </div>

      {isLoading && <p className="text-xs text-s-muted">Loading…</p>}
      {error && <p role="alert" className="text-xs text-s-red">{(error as Error).message}</p>}

      {d && (
        <>
          <div className="space-y-1 na-noprint">
            {d.auditedAt && <p className="text-xs text-s-muted">Night audit run {fmtWhen(d.auditedAt)}{d.auditedBy ? ` by ${d.auditedBy.name}` : ''}.</p>}
            {d.closedAt && <p className="text-xs text-s-muted">Closed {fmtWhen(d.closedAt)}{d.closedBy ? ` by ${d.closedBy.name}` : ''}{d.closedVia === 'auto' ? ' (automatically, settlement matched)' : d.closedVia === 'override' ? ' (pushed through by the CEO)' : ''}.</p>}
            <Overrides title="Night run pushed through over" list={d.nightOverrides} reason={d.nightOverrideReason} />
            <Overrides title="Settlement pushed through over" list={d.settlementOverrides} reason={d.settlementOverrideReason} />
            {d.inClosedPeriod && <p className="text-xs text-s-muted">This day is inside a closed period. Reopen the period first to change it.</p>}
            {!d.active && d.status === 'open' && <p className="text-xs text-s-muted">No trading on this day. It can still be run; there is nothing to reconcile.</p>}
          </div>

          <div role="tablist" className="flex gap-4 border-b border-s-border na-noprint">
            {(['checks', 'report', 'history'] as Tab[]).map((t) => (
              <button key={t} role="tab" aria-selected={tab === t} type="button" onClick={() => setTab(t)}
                className={`pb-2 text-sm -mb-px border-b-2 ${tab === t ? 'border-success text-s-text font-medium' : 'border-transparent text-s-muted'}`}>
                {t === 'checks' ? 'Checks' : t === 'report' ? 'Report' : 'History'}
              </button>
            ))}
          </div>

          {tab === 'checks' && (
            <div className="space-y-3 na-noprint">
              {d.status === 'open' && d.earlierOpenDays.length > 0 && (
                <div className="rounded-lg border border-s-border p-3 text-xs space-y-1">
                  <p className="font-medium text-s-text">Earlier days must be audited first</p>
                  <p className="text-s-muted flex flex-wrap gap-2">
                    {d.earlierOpenDays.map((x) => <Link key={x} href={`/finance/night-audit?month=${x.slice(0, 7)}&day=${x}`} className="text-primary-ink underline">{x}</Link>)}
                  </p>
                </div>
              )}

              {d.checks ? (
                <>
                  <p className="text-xs font-semibold text-s-text">
                    {d.checks.phase === 'night' ? 'Night run — needed tonight' : 'Settlement — card payout, bank transfers, deposits'}
                  </p>
                  {d.checks.blocks.length === 0 && d.checks.problems.length === 0 && (
                    <div className="flex items-center gap-2 text-xs"><span className="s-badge-green text-[11px]">Clear</span><span className="text-s-text">Nothing blocks this step.</span></div>
                  )}
                  {[...d.checks.blocks, ...d.checks.warnings].map((p) => (
                    <ProblemCard key={p.key} p={p} canFix={d.canRun} onFix={(x) => fix.mutate(x)} fixing={fix.isPending} />
                  ))}
                </>
              ) : (
                d.status === 'open' && <p className="text-xs text-s-muted">Today is still trading. The night run opens at midnight, Pakistan time.</p>
              )}

              {d.status === 'open' && d.checks && d.canRun && (
                <div className="space-y-2">
                  <button type="button" className="s-btn-primary text-sm w-full"
                    disabled={run.isPending || d.earlierOpenDays.length > 0 || d.inClosedPeriod || d.checks.blocks.length > 0}
                    onClick={() => run.mutate(undefined)}>
                    {run.isPending ? 'Running…' : 'Run night audit'}
                  </button>
                  {d.checks.blocks.length > 0 && d.canOverride && d.earlierOpenDays.length === 0 && !d.inClosedPeriod && (
                    <PushThrough blocks={d.checks.blocks} busy={run.isPending} label="Run night audit over these blocks" onGo={(a) => run.mutate(a)} />
                  )}
                  {d.checks.blocks.length > 0 && !d.canOverride && <p className="text-[11px] text-s-muted">Only the CEO can push the day through a block, with a written reason.</p>}
                </div>
              )}
              {d.status === 'open' && !d.canRun && <p className="text-xs text-s-muted">Finance or the CEO runs the night audit.</p>}

              {d.status === 'audited' && d.canRun && (
                <div className="space-y-2">
                  <button type="button" className="s-btn-primary text-sm w-full" disabled={settle.isPending} onClick={() => settle.mutate(undefined)}>
                    {settle.isPending ? 'Checking…' : 'Check settlement now'}
                  </button>
                  {d.checks && d.checks.blocks.length > 0 && d.canOverride && (
                    <PushThrough blocks={d.checks.blocks} busy={settle.isPending} label="Close over these blocks" onGo={(a) => settle.mutate(a)} />
                  )}
                  {d.checks && d.checks.blocks.length > 0 && !d.canOverride && <p className="text-[11px] text-s-muted">Only the CEO can close the day over a block, with a written reason.</p>}
                  <p className="text-[11px] text-s-muted">The day also closes by itself once its card payout and bank lines match.</p>
                </div>
              )}

              {d.canReopen && (
                <div className="pt-3 border-t border-s-border">
                  <button type="button" className="s-btn-danger text-sm" disabled={reopen.isPending} onClick={() => void doReopen()}>
                    {reopen.isPending ? 'Reopening…' : 'Reopen day (CEO)'}
                  </button>
                </div>
              )}
            </div>
          )}

          {tab === 'report' && (
            <div className="space-y-3">
              {report ? (
                <>
                  <button type="button" onClick={() => window.print()} className="s-btn-secondary text-xs na-noprint">Print</button>
                  <DailyReportView report={report} preview={live} />
                </>
              ) : (
                <p className="text-xs text-s-muted">{live && !d.active ? 'No trading on this day.' : live ? 'Building the preview…' : 'No report was saved for this day.'}</p>
              )}
            </div>
          )}

          {tab === 'history' && (
            <ul className="space-y-2 na-noprint">
              {d.history.length === 0 && <li className="text-xs text-s-muted">Nothing yet.</li>}
              {[...d.history].reverse().map((h, i) => (
                <li key={i} className="text-xs text-s-muted">
                  <span className="text-s-text">{h.action.replace(/_/g, ' ')}</span>{h.from && h.to ? ` (${h.from} to ${h.to})` : ''} · {fmtWhen(h.at)}{h.byName ? ` · ${h.byName}` : ' · automatic'}
                  {h.reason ? <> — <span className="text-s-text">{h.reason}</span></> : null}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  )
}
