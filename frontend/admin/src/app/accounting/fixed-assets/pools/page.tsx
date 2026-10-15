'use client'
// Smallwares: plates, knives, bowls and the like are tracked as pools per
// outlet, brand and type, not item by item. Each pool shows its units, what
// they cost, what they are worth and the layers (each purchase) it is made of.
//
// Anyone who counts stock (finance and the F&B manager) can record a count: it
// carries no money. Writing units off (breakage, loss) goes to the CEO to
// approve; moving units between outlets takes effect at once. The buttons come
// from the API's capability flags.

import { useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../../../../lib/api'
import {
  FA_BASE, FaFrame, Stat, Notice, card, inp, btnPrimary, btnGhost, money, fmtDay, fmtLife, errorWords, useFaLookups,
} from '../../../../components/fixedAssets/shared'
import { PoolRequestModal, type PoolRequestKind, type PoolRow } from '../../../../components/fixedAssets/RequestForms'
import { Select } from '@/components/ui/Select'

interface Layer {
  id: string; assetTag: string | null; name: string; quantity: number; originalQuantity: number
  inServiceAt: string; usefulLifeMonths: number | null; costCents: number; accumulatedCents: number; nbvCents: number
}
interface Pool extends PoolRow {
  companyName: string
  locationName: string
  conceptName: string | null
  typeLabel: string
  isActive: boolean
  costCents: number
  accumulatedCents: number
  nbvCents: number
  layers: Layer[]
  lastCount: { eventId: string; countedAt: string; countedUnits: number | null; onHandUnits: number | null; shortfallUnits: number | null; note: string | null } | null
  pendingRequestCount: number
}

export default function PoolsPage() {
  const qc = useQueryClient()
  const { data: lookups } = useFaLookups()
  const [conceptId, setConceptId] = useState('')
  const [locationId, setLocationId] = useState('')
  const [typeKey, setTypeKey] = useState('')
  const [open, setOpen] = useState<string | null>(null)
  const [action, setAction] = useState<{ pool: Pool; kind: PoolRequestKind; units?: number } | null>(null)
  const [notice, setNotice] = useState<{ tone: 'ok' | 'wait' | 'bad'; text: string } | null>(null)

  const qs = useMemo(() => {
    const p = new URLSearchParams()
    if (conceptId) p.set('conceptId', conceptId)
    if (locationId) p.set('locationId', locationId)
    if (typeKey) p.set('typeKey', typeKey)
    return p.toString()
  }, [conceptId, locationId, typeKey])

  const { data, isLoading, error } = useQuery<{ pools: Pool[] }>({
    queryKey: ['fa-pools', qs],
    queryFn: () => api.get<{ pools: Pool[] }>(`${FA_BASE}/pools${qs ? `?${qs}` : ''}`),
  })

  const canWrite = !!lookups?.capabilities.canWrite
  const canCount = !!lookups?.capabilities.canCount
  const isCeo = !!lookups?.capabilities.canApprove
  const pools = data?.pools ?? []
  const multi = new Set(pools.map((p) => p.tenantId)).size > 1

  const brandOptions = useMemo(() => [...new Map((lookups?.brands ?? []).map((b) => [b.id, b.name])).entries()], [lookups])
  const outletOptions = useMemo(() => [...new Map((lookups?.locations ?? []).map((l) => [l.id, l.name])).entries()], [lookups])

  const totalUnits = pools.reduce((s, p) => s + p.unitsOnHand, 0)
  const totalCost = pools.reduce((s, p) => s + p.costCents, 0)
  const totalNbv = pools.reduce((s, p) => s + p.nbvCents, 0)

  function done(r: { status?: 'pending' | 'posted'; event?: { kindLabel: string }; countedUnits?: number; shortfallUnits?: number | null }) {
    const wasCount = action?.kind === 'count'
    setAction(null)
    if (wasCount) {
      setNotice({
        tone: (r.shortfallUnits ?? 0) > 0 ? 'wait' : 'ok',
        text: (r.shortfallUnits ?? 0) > 0
          ? `Count saved: ${r.shortfallUnits} units short of the books. Finance can ask the CEO to write them off.`
          : 'Count saved.',
      })
    } else if (r.status === 'pending') {
      setNotice({ tone: 'wait', text: 'Write-off sent to the CEO. Nothing posts until it is approved.' })
    } else {
      setNotice({ tone: 'ok', text: `${r.event?.kindLabel ?? 'Request'} done and posted.` })
    }
    void qc.invalidateQueries({ queryKey: ['fa-pools'] })
    void qc.invalidateQueries({ queryKey: ['fa-pending-count'] })
    void qc.invalidateQueries({ queryKey: ['fa-register'] })
  }

  return (
    <FaFrame title="Smallwares" subtitle="Plates, knives, bowls and other small items, counted as pools per outlet, brand and type. They wear out over 24 months.">
      {notice && <Notice tone={notice.tone} onClose={() => setNotice(null)}>{notice.text}</Notice>}

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <Stat label="Units on hand" value={totalUnits.toLocaleString('en-PK')} />
        <Stat label="Cost" value={money(totalCost)} />
        <Stat label="Book value" value={money(totalNbv)} />
      </div>

      <div className="rounded-2xl p-4 grid grid-cols-1 sm:grid-cols-3 gap-3" style={card}>
        <label className="block"><span className="text-[11px] font-bold text-white/50">Outlet</span>
          <Select className={inp} value={locationId} onChange={(e) => setLocationId(e.target.value)}>
            <option value="">All outlets</option>{outletOptions.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</Select></label>
        <label className="block"><span className="text-[11px] font-bold text-white/50">Brand</span>
          <Select className={inp} value={conceptId} onChange={(e) => setConceptId(e.target.value)}>
            <option value="">All brands</option>{brandOptions.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</Select></label>
        <label className="block"><span className="text-[11px] font-bold text-white/50">Type</span>
          <Select className={inp} value={typeKey} onChange={(e) => setTypeKey(e.target.value)}>
            <option value="">All types</option>{(lookups?.smallwareTypes ?? []).map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}</Select></label>
      </div>

      {error && <Notice tone="bad">{errorWords(error)}</Notice>}
      {isLoading && <p className="text-sm text-white/40">Loading pools…</p>}
      {data && pools.length === 0 && (
        <div className="rounded-2xl p-10 text-center" style={card}>
          <p className="font-bold text-white/85">No smallwares pools yet</p>
          <p className="text-sm text-white/45 mt-1 max-w-md mx-auto">A pool is created when smallwares are bought through CapEx (Buy equipment, choosing a smallwares type and an outlet).</p>
        </div>
      )}

      <div className="space-y-3">
        {pools.map((p) => {
          const short = p.lastCount?.shortfallUnits ?? 0
          const expanded = open === p.id
          return (
            <section key={p.id} className="rounded-2xl p-4" style={{ ...card, opacity: p.isActive ? 1 : 0.65 }}>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="font-black text-white/90 break-words">{p.label}</p>
                  <p className="text-xs text-white/45 mt-0.5">
                    {[p.typeLabel, p.locationName, p.conceptName ?? 'Shared across brands', multi ? p.companyName : null].filter(Boolean).join(' · ')}
                  </p>
                </div>
                {p.pendingRequestCount > 0 && <span className="s-badge-amber">Request waiting</span>}
              </div>

              <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mt-3 text-sm">
                <div><p className="text-[11px] text-white/40">Units on hand</p><p className="font-black text-white/90">{p.unitsOnHand}</p></div>
                <div><p className="text-[11px] text-white/40">Cost</p><p className="font-mono text-white/80">{money(p.costCents)}</p></div>
                <div><p className="text-[11px] text-white/40">Depreciated</p><p className="font-mono text-white/60">{money(p.accumulatedCents)}</p></div>
                <div><p className="text-[11px] text-white/40">Book value</p><p className="font-mono font-bold text-white/90">{money(p.nbvCents)}</p></div>
              </div>

              <p className="text-xs mt-3" style={{ color: p.lastCount ? (short > 0 ? 'var(--erp-danger)' : 'var(--erp-success)') : 'rgb(var(--fg-rgb) / 0.45)' }}>
                {p.lastCount
                  ? `Last count ${fmtDay(p.lastCount.countedAt)}: ${p.lastCount.countedUnits ?? '?'} counted${short > 0 ? `, ${short} short of the books` : short < 0 ? `, ${-short} more than the books` : ', matches the books'}${p.lastCount.note ? ` (${p.lastCount.note})` : ''}`
                  : 'Never counted'}
              </p>

              <div className="flex flex-wrap gap-2 mt-3">
                {canCount && <button className={btnPrimary} onClick={() => { setNotice(null); setAction({ pool: p, kind: 'count' }) }}>Record a count</button>}
                {canWrite && p.unitsOnHand > 0 && (
                  <button className={btnGhost} onClick={() => { setNotice(null); setAction({ pool: p, kind: 'write_off', units: short > 0 ? short : undefined }) }}>
                    {short > 0 ? `Write off the ${short} missing` : 'Write off units'}
                  </button>
                )}
                {canWrite && p.unitsOnHand > 0 && <button className={btnGhost} onClick={() => { setNotice(null); setAction({ pool: p, kind: 'transfer_units' }) }}>Move units</button>}
                <button className="text-xs font-bold text-primary-ink hover:underline px-2" onClick={() => setOpen(expanded ? null : p.id)}>
                  {expanded ? 'Hide purchases' : `Show purchases (${p.layers.length})`}
                </button>
              </div>

              {expanded && (
                <div className="mt-3 overflow-x-auto rounded-xl" style={{ border: '1px solid rgb(var(--fg-rgb) / 0.07)' }}>
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-left text-[10px] uppercase tracking-wider text-white/40">
                        {['Purchase', 'In service', 'Units', 'Life', 'Cost', 'Depreciated', 'Book value'].map((h, i) => <th key={h} className={`px-3 py-2 font-bold whitespace-nowrap ${i > 3 ? 'text-right' : ''}`}>{h}</th>)}
                      </tr>
                    </thead>
                    <tbody>
                      {p.layers.length === 0 && <tr><td colSpan={7} className="px-3 py-3 text-white/45">No units left in this pool.</td></tr>}
                      {p.layers.map((l) => (
                        <tr key={l.id} className="border-t border-white/[0.05]">
                          <td className="px-3 py-2 text-white/80">{[l.assetTag, l.name].filter(Boolean).join(' ')}</td>
                          <td className="px-3 py-2 text-white/60 whitespace-nowrap">{fmtDay(l.inServiceAt)}</td>
                          <td className="px-3 py-2 text-white/80">{l.quantity}{l.originalQuantity !== l.quantity ? <span className="text-white/40"> of {l.originalQuantity}</span> : null}</td>
                          <td className="px-3 py-2 text-white/60 whitespace-nowrap">{fmtLife(l.usefulLifeMonths)}</td>
                          <td className="px-3 py-2 text-right font-mono text-white/80 whitespace-nowrap">{money(l.costCents)}</td>
                          <td className="px-3 py-2 text-right font-mono text-white/60 whitespace-nowrap">{money(l.accumulatedCents)}</td>
                          <td className="px-3 py-2 text-right font-mono font-bold text-white/90 whitespace-nowrap">{money(l.nbvCents)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          )
        })}
      </div>

      {action && lookups && (
        <PoolRequestModal pool={action.pool} kind={action.kind} lookups={lookups} willWait={!isCeo} initialUnits={action.units}
          onClose={() => setAction(null)} onDone={done} />
      )}
    </FaFrame>
  )
}
