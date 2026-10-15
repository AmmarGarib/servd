'use client'
// Head office → Cost split: the versions, the total and the % retained, and
// "New split from <month>" (a version per month; ≤ 100%, the rest stays here).

import { useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { toast } from 'sonner'
import { deleteWithUndo } from '../../../../lib/api'
import { Select } from '../../../../components/ui/Select'
import {
  headOfficeApi, bpsToPct, pctToBps, monthLabel, monthRange, addMonthsTo, currentMonthPkt,
  type HeadOfficeDetail, type SplitVersion,
} from '../../../../lib/headOfficeApi'
import { Modal, errText } from './CompaniesTab'

function NewSplit({ hoId, detail, current, onClose, onDone }: { hoId: string; detail: HeadOfficeDetail; current: SplitVersion | null; onClose: () => void; onDone: () => void }) {
  const live = detail.links.filter((l) => l.live)
  const months = monthRange(addMonthsTo(currentMonthPkt(), -1), 14)
  const [from, setFrom] = useState(addMonthsTo(currentMonthPkt(), 1))
  const [pct, setPct] = useState<Record<string, string>>(() =>
    Object.fromEntries(live.map((l) => [l.companyTenantId, bpsToPct(current?.lines.find((x) => x.companyTenantId === l.companyTenantId)?.shareBps ?? 0)])))
  const [note, setNote] = useState('')
  const lines = live.map((l) => ({ companyTenantId: l.companyTenantId, shareBps: pctToBps(pct[l.companyTenantId] ?? '0') })).filter((l) => l.shareBps > 0)
  const total = lines.reduce((a, l) => a + l.shareBps, 0)
  const save = useMutation({
    mutationFn: () => headOfficeApi.createSplit(hoId, { effectiveFrom: from, lines, note: note.trim() || null }),
    onSuccess: (r) => { toast.success(r.warning ?? `Split from ${monthLabel(from)} saved`); onDone() },
    onError: (e) => toast.error(errText(e)),
  })
  return (
    <Modal title={`New split from ${monthLabel(from)}`} onClose={onClose}>
      <label className="block text-xs font-bold text-white/60 mb-1">First month</label>
      <Select className="s-select w-full" value={from} onChange={(e) => setFrom(e.target.value)}>
        {months.map((m) => <option key={m} value={m}>{monthLabel(m)}</option>)}
      </Select>
      <div className="mt-3 space-y-2">
        {live.map((l) => (
          <div key={l.id} className="flex items-center gap-3">
            <span className="flex-1 text-sm text-white/80">{l.companyName}</span>
            <input className="s-input w-24 text-right" inputMode="decimal" value={pct[l.companyTenantId] ?? ''} aria-label={`${l.companyName} share`}
              onChange={(e) => setPct((s) => ({ ...s, [l.companyTenantId]: e.target.value }))} />
            <span className="text-xs text-white/50">%</span>
          </div>
        ))}
      </div>
      <p className={`mt-3 text-xs font-bold ${total > 10000 ? 'text-red-600' : 'text-white/70'}`}>
        Total {bpsToPct(total)}%{total <= 10000 && <span className="font-normal text-white/50"> · {bpsToPct(10000 - total)}% stays with the head office</span>}
        {total > 10000 && ' (over 100%)'}
      </p>
      <label className="block text-xs font-bold text-white/60 mt-3 mb-1">Note (optional)</label>
      <input className="s-input w-full" value={note} onChange={(e) => setNote(e.target.value)} />
      <div className="mt-4 flex justify-end gap-2">
        <button type="button" className="s-btn-secondary text-xs" onClick={onClose}>Cancel</button>
        <button type="button" className="s-btn-primary text-xs" disabled={lines.length === 0 || total > 10000 || save.isPending} onClick={() => save.mutate()}>
          {save.isPending ? 'Saving…' : 'Save split'}
        </button>
      </div>
    </Modal>
  )
}

export default function SplitTab({ hoId, detail, reload }: { hoId: string; detail: HeadOfficeDetail; reload: () => void }) {
  const [adding, setAdding] = useState(false)
  const q = useQuery({ queryKey: ['ho-splits', hoId], queryFn: () => headOfficeApi.splits(hoId) })
  const nameOf = new Map(detail.links.map((l) => [l.companyTenantId, l.companyName]))
  const del = useMutation({
    mutationFn: (id: string) => deleteWithUndo(`/head-offices/${encodeURIComponent(hoId)}/splits/${encodeURIComponent(id)}`, { trashType: 'recharge_split', id, onRestored: () => { void q.refetch(); reload() } }),
    onSuccess: () => { void q.refetch(); reload() },
    onError: (e) => toast.error(errText(e)),
  })
  const current = q.data?.current ?? detail.currentSplit
  return (
    <div>
      <div className="flex items-center justify-between gap-3 mb-3">
        <p className="text-sm text-white/60">
          {current
            ? <>In force now: from {monthLabel(current.effectiveFrom)}, <b className="text-white/85">{bpsToPct(current.totalBps)}%</b> charged, <b className="text-white/85">{bpsToPct(10000 - current.totalBps)}%</b> retained by the head office.</>
            : 'No split is in force yet.'}
        </p>
        <button type="button" className="s-btn-primary text-xs" onClick={() => setAdding(true)} disabled={detail.links.every((l) => !l.live)}>
          New split from a month
        </button>
      </div>
      <div className="space-y-3">
        {(q.data?.splits ?? []).map((s) => (
          <div key={s.id} className="rounded-2xl p-4" style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}>
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-sm font-black text-white/85">From {monthLabel(s.effectiveFrom)}</span>
              {current?.id === s.id && <span className="s-badge-green">In force</span>}
              <span className="text-xs text-white/50">Total {bpsToPct(s.totalBps)}% · retained {bpsToPct(10000 - s.totalBps)}%</span>
              <span className="ml-auto text-xs text-white/40">{s.runCount} run{s.runCount === 1 ? '' : 's'}</span>
              {s.runCount === 0 && <button type="button" className="s-btn-ghost text-xs" onClick={() => del.mutate(s.id)} disabled={del.isPending}>Remove</button>}
            </div>
            <ul className="mt-2 text-xs text-white/70 space-y-0.5">
              {s.lines.map((l) => <li key={l.companyTenantId}>{nameOf.get(l.companyTenantId) ?? l.companyTenantId}: {bpsToPct(l.shareBps)}%</li>)}
            </ul>
            {s.note && <p className="mt-1 text-[11px] text-white/45">{s.note}</p>}
          </div>
        ))}
        {q.data && q.data.splits.length === 0 && <p className="text-sm text-white/45">No versions yet.</p>}
      </div>
      {adding && <NewSplit hoId={hoId} detail={detail} current={current} onClose={() => setAdding(false)} onDone={() => { setAdding(false); void q.refetch(); reload() }} />}
    </div>
  )
}
