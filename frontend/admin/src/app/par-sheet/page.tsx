'use client'
// Par board (owner, 2026-10-26 — kitchen flow K5: "Par = one count shown in PORTIONS"). Per outlet, per prep:
// target portions (the day's par, or what the forecast needs if more), on hand (the prep's stock at this outlet —
// counts down as sales deduct), made today, still to prep. "Log" records the prep shift's batch IN PORTIONS — that
// entry IS the prep batch log (POST /crosschecks/prep-batches with actualPortions): its ingredients leave stock and
// the prep comes in. "Set par" edits the daily par per weekday (kitchen managers), with the forecast's suggestion.
// Every number: GET /kitchen/par-board and /kitchen/par-targets (modules/kitchen/prepPlan.ts — one engine).
import { useState } from 'react'
import Link from 'next/link'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../../lib/api'
import { useManagerRoles } from '../../lib/roles'
import { useAuthStore } from '../../store/auth'
import { stockErrorText } from '../../lib/stockUi'
import { CompactEmptyState } from '../../components/ui/CompactEmptyState'
import { OutletPicker, todayIso, useOutlet } from '../../components/kitchen/useOutlet'

interface BoardRow {
  recipeId: string; name: string; unit: string; portionLabel: string | null; portionSize: number | null
  targetPortions: number | null; parPortions: number | null; needPortions: number | null
  onHandPortions: number | null; madeTodayPortions: number | null; stillToPrepPortions: number | null
  targetQty: number; onHandQty: number; madeTodayQty: number; stillToPrepQty: number
  batchesMadeToday: number; lastBatchAt: string | null
}
interface TargetRow {
  recipeId: string; name: string; unit: string; portionLabel: string | null; portionSize: number | null
  targets: Array<number | null>; suggested: Array<number | null>
}
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const n = (v: number | null | undefined) => (v == null ? '—' : v.toLocaleString('en', { maximumFractionDigits: 1 }))

export default function ParBoardPage() {
  const { outlets, locationId, setLocationId } = useOutlet()
  const [date, setDate] = useState(todayIso())
  const [tab, setTab] = useState<'board' | 'par'>('board')
  const role = useAuthStore((s) => s.user?.role) ?? ''
  const canSetPar = useManagerRoles().has(role)

  return (
    <div className="min-h-screen bg-s-bg">
      <header className="sticky top-0 z-10 bg-s-bg/80 backdrop-blur border-b border-s-border px-6 py-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-success">Operations</p>
          <h1 className="text-xl font-bold text-s-text">Par board</h1>
          <p className="text-xs text-s-muted">Preps in portions — what to have, what is on hand, what is still to prep. See also the <Link href="/kitchen/prep-list" className="text-primary-ink underline">prep list</Link>.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <OutletPicker outlets={outlets} value={locationId} onChange={setLocationId} />
          {tab === 'board' && <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="s-input w-auto" aria-label="Date" />}
        </div>
      </header>
      <div className="px-6 pt-3 flex gap-1 text-sm" role="tablist">
        {(['board', 'par'] as const).map((t) => (
          <button key={t} role="tab" aria-selected={tab === t} onClick={() => setTab(t)}
            className={`px-3 py-1.5 border-b-2 ${tab === t ? 'border-accent font-semibold text-s-text' : 'border-transparent text-s-muted'}`}>
            {t === 'board' ? 'Today' : 'Set par'}
          </button>
        ))}
      </div>
      <div className="p-6 max-w-6xl mx-auto">
        {!locationId ? <CompactEmptyState message="No outlet yet. Add one under Locations." />
          : tab === 'board' ? <Board locationId={locationId} date={date} /> : <ParTargets locationId={locationId} canEdit={canSetPar} />}
      </div>
    </div>
  )
}

function Board({ locationId, date }: { locationId: string; date: string }) {
  const qc = useQueryClient()
  const { data, isLoading, error } = useQuery<{ rows: BoardRow[] }>({
    queryKey: ['kitchen', 'par-board', locationId, date],
    queryFn: () => api.get(`/kitchen/par-board?locationId=${locationId}&date=${date}`),
    refetchInterval: 30_000,
  })
  const [made, setMade] = useState<Record<string, string>>({})
  // Batches cooked — required with portions (the server never assumes 1: 400 BATCHES_REQUIRED).
  const [batches, setBatches] = useState<Record<string, string>>({})
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const log = useMutation({
    mutationFn: (r: BoardRow) => api.post('/crosschecks/prep-batches', { recipeId: r.recipeId, itemName: r.name, actualPortions: Number(made[r.recipeId]), batches: Number(batches[r.recipeId]), locationId }),
    onSuccess: (_d, r) => {
      setMsg({ ok: true, text: `${made[r.recipeId]} ${r.portionLabel ?? 'portions'} of ${r.name} logged.` })
      setMade((m) => ({ ...m, [r.recipeId]: '' }))
      setBatches((m) => ({ ...m, [r.recipeId]: '' }))
      void qc.invalidateQueries({ queryKey: ['kitchen'] })
    },
    onError: (e) => setMsg({ ok: false, text: stockErrorText(e) }),
  })
  if (isLoading) return <p className="text-sm text-s-muted">Loading…</p>
  if (error) return <p className="text-sm text-s-red">{stockErrorText(error)}</p>
  const rows = data?.rows ?? []
  if (rows.length === 0) return <CompactEmptyState message="No preps for this outlet's dishes yet." />
  return (
    <div className="space-y-3">
      {msg && <p role="status" className={`text-sm ${msg.ok ? 'text-success' : 'text-s-red'}`}>{msg.text}</p>}
      <div className="s-card overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-xs text-s-muted">
            <tr>
              <th className="px-3 py-2 text-left">Prep</th>
              <th className="px-3 py-2 text-right">Target</th>
              <th className="px-3 py-2 text-right">On hand</th>
              <th className="px-3 py-2 text-right">Made today</th>
              <th className="px-3 py-2 text-right">Still to prep</th>
              <th className="px-3 py-2 text-left">Log what the shift made</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const unitLabel = r.portionLabel ?? 'portions'
              const noPortions = r.portionSize == null
              return (
                <tr key={r.recipeId} className="border-t border-s-border">
                  <td className="px-3 py-2 text-s-text">
                    {r.name}
                    <span className="block text-[11px] text-s-muted">{noPortions ? 'No portions per recipe set' : `1 ${r.portionLabel ?? 'portion'} = ${n(r.portionSize)} ${r.unit}`}</span>
                  </td>
                  <td className="px-3 py-2 text-right font-mono">{noPortions ? `${n(r.targetQty)} ${r.unit}` : n(r.targetPortions)}</td>
                  <td className="px-3 py-2 text-right font-mono">{noPortions ? `${n(r.onHandQty)} ${r.unit}` : n(r.onHandPortions)}</td>
                  <td className="px-3 py-2 text-right font-mono">{noPortions ? `${n(r.madeTodayQty)} ${r.unit}` : n(r.madeTodayPortions)}</td>
                  <td className={`px-3 py-2 text-right font-mono font-bold ${(r.stillToPrepQty ?? 0) > 0 ? 'text-s-text' : 'text-success'}`}>
                    {noPortions ? `${n(r.stillToPrepQty)} ${r.unit}` : n(r.stillToPrepPortions)}
                  </td>
                  <td className="px-3 py-2">
                    {noPortions ? <Link href={`/accounting/recipes/${r.recipeId}`} className="text-xs text-primary-ink underline">Set portions per recipe</Link> : (
                      <div className="flex items-center gap-2">
                        <input inputMode="decimal" value={batches[r.recipeId] ?? ''} onChange={(e) => setBatches((m) => ({ ...m, [r.recipeId]: e.target.value }))}
                          placeholder="batches" className="s-input w-20" aria-label={`${r.name} batches cooked`} />
                        <input inputMode="decimal" value={made[r.recipeId] ?? ''} onChange={(e) => setMade((m) => ({ ...m, [r.recipeId]: e.target.value }))}
                          placeholder={unitLabel} className="s-input w-24" aria-label={`${r.name} made, in ${unitLabel}`} />
                        <button type="button" disabled={!(Number(made[r.recipeId]) > 0) || !(Number(batches[r.recipeId]) > 0) || log.isPending} onClick={() => { setMsg(null); log.mutate(r) }}
                          className="s-btn-primary px-3 py-1 text-xs font-bold disabled:opacity-40">Log</button>
                      </div>
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-s-muted">Target is the day&rsquo;s par, or what the forecast needs when that is more. On hand counts down as dishes sell.</p>
    </div>
  )
}

function ParTargets({ locationId, canEdit }: { locationId: string; canEdit: boolean }) {
  const qc = useQueryClient()
  const { data, isLoading } = useQuery<{ rows: TargetRow[] }>({
    queryKey: ['kitchen', 'par-targets', locationId],
    queryFn: () => api.get(`/kitchen/par-targets?locationId=${locationId}`),
  })
  const [draft, setDraft] = useState<Record<string, string>>({})
  const save = useMutation({
    mutationFn: () => api.put('/kitchen/par-targets', {
      locationId,
      targets: Object.entries(draft).map(([k, v]) => {
        const [recipeId, wd] = k.split('|')
        return { recipeId, weekday: Number(wd), portions: v.trim() === '' ? null : Number(v) }
      }),
    }),
    onSuccess: () => { setDraft({}); void qc.invalidateQueries({ queryKey: ['kitchen'] }) },
  })
  if (isLoading) return <p className="text-sm text-s-muted">Loading…</p>
  const rows = data?.rows ?? []
  if (rows.length === 0) return <CompactEmptyState message="No preps for this outlet's dishes yet." />
  return (
    <div className="space-y-3">
      <div className="s-card overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-xs text-s-muted">
            <tr>
              <th className="px-3 py-2 text-left">Prep (portions)</th>
              {DAYS.map((d) => <th key={d} className="px-2 py-2 text-center">{d}</th>)}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.recipeId} className="border-t border-s-border">
                <td className="px-3 py-2 text-s-text">{r.name}<span className="block text-[11px] text-s-muted">{r.portionSize ? `1 ${r.portionLabel ?? 'portion'} = ${n(r.portionSize)} ${r.unit}` : 'No portions per recipe set'}</span></td>
                {DAYS.map((_, wd) => {
                  const k = `${r.recipeId}|${wd}`
                  const v = draft[k] ?? (r.targets[wd] != null ? String(r.targets[wd]) : '')
                  return (
                    <td key={wd} className="px-1 py-2 text-center">
                      <input value={v} disabled={!canEdit || !r.portionSize} inputMode="decimal" onChange={(e) => setDraft((d) => ({ ...d, [k]: e.target.value }))}
                        placeholder={r.suggested[wd] != null ? String(r.suggested[wd]) : ''} title={r.suggested[wd] != null ? `Forecast suggests ${r.suggested[wd]}` : undefined}
                        className="s-input w-16 text-center" aria-label={`${r.name} par on ${DAYS[wd]}`} />
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-s-muted">Faint numbers are the forecast&rsquo;s suggestion for the coming week. Leave a day empty for no par.</p>
      {save.error && <p role="alert" className="text-sm text-s-red">{stockErrorText(save.error)}</p>}
      {canEdit && <button type="button" disabled={Object.keys(draft).length === 0 || save.isPending} onClick={() => save.mutate()} className="s-btn-primary px-5 py-2 font-bold disabled:opacity-40">Save par</button>}
    </div>
  )
}
