'use client'
// HR: evaluation cycles — list with counts, create, open / close.

import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { api } from '../../../lib/api'
import { btn, btnGhost, card, day } from '../../../lib/hr'
import { Modal } from '../HrShell'
import { Field, StatusChip, bpOf, errMsg, inputCls, usePerfCycles, type PerfArea, type PerfCycle } from './shared'

type CycleRow = PerfCycle & { counts: Record<string, number> }

export function CyclesView() {
  const qc = useQueryClient()
  const { data: std } = usePerfCycles()
  const { data, isLoading, error } = useQuery({ queryKey: ['perf-admin-cycles'], queryFn: () => api.get<CycleRow[]>('/hr/performance/admin/cycles') })
  const [creating, setCreating] = useState(false)
  const [err, setErr] = useState('')
  const refresh = () => { void qc.invalidateQueries({ queryKey: ['perf-admin-cycles'] }); void qc.invalidateQueries({ queryKey: ['perf-cycles'] }); void qc.invalidateQueries({ queryKey: ['perf-results'] }) }
  const toggle = useMutation({
    mutationFn: (c: CycleRow) => api.patch(`/hr/performance/admin/cycles/${c.id}`, { status: c.status === 'open' ? 'closed' : 'open' }),
    onSuccess: () => { toast.success('Cycle updated'); refresh() }, onError: (e: Error) => setErr(e.message),
  })
  const total = (c: CycleRow) => Object.values(c.counts ?? {}).reduce((s, n) => s + n, 0)
  return (
    <div className="space-y-4">
      <div className="flex justify-end"><button className={btn} onClick={() => setCreating(true)}>New cycle</button></div>
      {isLoading && <p className="text-sm text-white/50" role="status">Loading cycles…</p>}
      {error && <p className="text-sm text-s-red" role="alert">{errMsg(error)}</p>}
      {data && data.length === 0 && <div className="rounded-2xl p-8 text-center" style={card}><p className="text-sm text-white/75">No cycles yet. Create the first one — managers can then assign evaluations to their teams.</p></div>}
      <div className="grid md:grid-cols-2 gap-3">
        {(data ?? []).map((c) => (
          <div key={c.id} className="rounded-2xl p-4" style={card}>
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0"><p className="text-sm font-black text-white/90 break-words">{c.name}</p><p className="text-xs text-white/60">{day(c.periodFrom)} – {day(c.periodTo)}{c.dueDate ? ` · due ${day(c.dueDate)}` : ''}</p></div>
              <span className={c.status === 'open' ? 's-badge-green' : 's-badge-muted'}>{c.status === 'open' ? 'Open' : 'Closed'}</span>
            </div>
            <p className="text-xs text-white/65 mt-2">{bpOf(c.selfWeightBp)} self / {bpOf(10000 - c.selfWeightBp)} manager · {c.areas.length} areas · {total(c)} evaluations</p>
            {total(c) > 0 && <div className="flex flex-wrap gap-1.5 mt-2">{Object.entries(c.counts).map(([s, n]) => <span key={s} className="inline-flex items-center gap-1"><StatusChip status={s} label={std?.statusLabels[s]} /><b className="text-xs text-white/85">{n}</b></span>)}</div>}
            <div className="mt-3"><button className={btnGhost} disabled={toggle.isPending} onClick={() => { setErr(''); toggle.mutate(c) }}>{c.status === 'open' ? 'Close cycle' : 'Reopen cycle'}</button></div>
          </div>
        ))}
      </div>
      {err && <p className="text-xs text-s-red" role="alert">{err}</p>}
      {creating && <CreateCycle standard={std?.standardAreas ?? []} onClose={() => setCreating(false)} onDone={() => { setCreating(false); refresh() }} />}
    </div>
  )
}

function CreateCycle({ standard, onClose, onDone }: { standard: PerfArea[]; onClose: () => void; onDone: () => void }) {
  const [name, setName] = useState('')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [due, setDue] = useState('')
  const [selfPct, setSelfPct] = useState('30')
  const [areas, setAreas] = useState<Array<{ key: string; label: string; pct: string }>>(() => standard.map((a) => ({ key: a.key, label: a.label, pct: String(a.weightBp / 100) })))
  const [err, setErr] = useState('')
  const sum = Math.round(areas.reduce((s, a) => s + (parseFloat(a.pct) || 0) * 100, 0))
  const sp = parseFloat(selfPct)
  const valid = name.trim().length >= 2 && from && to && to >= from && sum === 10000 && sp >= 0 && sp <= 100 && areas.every((a) => a.label.trim().length >= 2 && (parseFloat(a.pct) || 0) > 0)
  const create = useMutation({
    mutationFn: () => api.post('/hr/performance/admin/cycles', {
      name: name.trim(), periodFrom: from, periodTo: to, dueDate: due || null, selfWeightBp: Math.round(sp * 100),
      areas: areas.map((a) => ({ key: a.key, label: a.label.trim(), weightBp: Math.round((parseFloat(a.pct) || 0) * 100) })),
    }),
    onSuccess: () => { toast.success('Cycle created'); onDone() }, onError: (e: Error) => setErr(e.message),
  })
  return (
    <Modal title="New evaluation cycle" wide onClose={onClose} dirty={name.length > 0}>
      <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); setErr(''); if (valid) create.mutate() }}>
        <Field label="Name"><input className={inputCls} placeholder="e.g. H2 2026 review" value={name} onChange={(e) => setName(e.target.value)} /></Field>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <Field label="Period from"><input type="date" className={inputCls} value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
          <Field label="Period to"><input type="date" className={inputCls} value={to} onChange={(e) => setTo(e.target.value)} /></Field>
          <Field label="Due date"><input type="date" className={inputCls} value={due} onChange={(e) => setDue(e.target.value)} /></Field>
          <Field label="Self weight %" hint={`Manager ${Number.isFinite(sp) ? 100 - sp : '—'}%`}><input type="number" min={0} max={100} className={inputCls} value={selfPct} onChange={(e) => setSelfPct(e.target.value)} /></Field>
        </div>
        <div>
          <p className="text-xs font-bold text-white/70 mb-1">Performance areas &amp; weights</p>
          <div className="space-y-2">
            {areas.map((a, i) => (
              <div key={a.key} className="flex gap-2 items-center">
                <input className={inputCls} aria-label={`Area ${i + 1} name`} value={a.label} onChange={(e) => setAreas((x) => x.map((r, j) => (j === i ? { ...r, label: e.target.value } : r)))} />
                <div className="flex items-center gap-1 shrink-0"><input type="number" min={0} step="0.5" className={`${inputCls} w-20`} aria-label={`${a.label} weight percent`} value={a.pct} onChange={(e) => setAreas((x) => x.map((r, j) => (j === i ? { ...r, pct: e.target.value } : r)))} /><span className="text-xs text-white/60">%</span></div>
              </div>
            ))}
          </div>
          <p className="text-sm font-black mt-2" role="status" style={{ color: sum === 10000 ? 'var(--erp-success)' : 'var(--erp-danger)' }}>Total {sum / 100}% {sum === 10000 ? '' : '— must be exactly 100%'}</p>
        </div>
        {err && <p className="text-xs text-s-red" role="alert">{err}</p>}
        <div className="flex gap-2"><button type="submit" className={btn} disabled={!valid || create.isPending}>{create.isPending ? 'Creating…' : 'Create cycle'}</button><button type="button" className={btnGhost} onClick={onClose}>Cancel</button></div>
      </form>
    </Modal>
  )
}
