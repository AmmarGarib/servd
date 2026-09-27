'use client'
// Fixed assets — the register of what the business owns, and its depreciation.
//
// Base layer. Adding an asset capitalises it in the ledger; "Charge month" posts
// straight-line depreciation for every active asset and is safe to run twice;
// disposing books the gain or loss. Cost, life and dates are fixed once an
// asset is added, because posted depreciation depends on them.

import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import Link from 'next/link'
import { api } from '../../../lib/api'
import { fmtPkrWhole } from '../../../lib/money'

interface Asset {
  id: string; name: string; category: string; categoryLabel: string
  assetTag: string | null; supplier: string | null
  acquiredAt: string; costCents: number; salvageCents: number; usefulLifeMonths: number
  accumulatedCents: number; bookValueCents: number; monthlyCents: number
  lastChargedPeriod: string | null; status: 'active' | 'disposed'
  disposedAt: string | null; disposalProceedsCents: number | null; conceptId: string | null
}
interface Register {
  assets: Asset[]
  totals: { costCents: number; accumulatedCents: number; bookValueCents: number; monthlyCents: number }
  categories: Record<string, { label: string; account: string }>
  funding: Record<string, { label: string; account: string }>
  currentPeriod: string
}
interface Concept { id: string; name: string }

const card = { background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.07)' }
const inp = 'w-full rounded-lg px-3 py-2 text-sm bg-white/[0.04] border border-white/10 text-white/90 focus:outline-none focus:border-kds-green'
// Typical lives — a starting point the form fills in; change to your policy.
const DEFAULT_LIFE: Record<string, number> = { kitchen_equipment: 60, furniture_fixtures: 84, it_equipment: 36, vehicles: 60, leasehold: 120 }

export default function FixedAssetsPage() {
  const qc = useQueryClient()
  const { data } = useQuery({ queryKey: ['fixed-assets'], queryFn: () => api.get<Register>('/accounting/fixed-assets') })
  const { data: concepts = [] } = useQuery({ queryKey: ['concepts'], queryFn: () => api.get<Concept[]>('/concepts') })
  const [adding, setAdding] = useState(false)
  const [period, setPeriod] = useState<string>('')
  const [runMsg, setRunMsg] = useState('')
  const [disposing, setDisposing] = useState<Asset | null>(null)

  const run = useMutation({
    mutationFn: () => api.post<{ chargedCents: number; results: Array<{ status: string }> }>(
      '/accounting/fixed-assets/depreciate', { period: period || data?.currentPeriod }),
    onSuccess: (r) => {
      const n = r.results.filter((x) => x.status === 'charged').length
      const already = r.results.filter((x) => x.status === 'already').length
      setRunMsg(n > 0 ? `Charged ${fmtPkrWhole(r.chargedCents)} across ${n} asset${n === 1 ? '' : 's'}.` :
        already > 0 ? 'Already charged for this month — nothing new to post.' : 'Nothing to charge for this month.')
      void qc.invalidateQueries({ queryKey: ['fixed-assets'] })
    },
    onError: (e: Error) => setRunMsg(e.message),
  })

  return (
    <div className="min-h-screen" style={{ background: '#090a0e' }}>
      <header className="px-7 py-6 border-b border-white/[0.05]">
        <Link href="/modules/assets" className="text-xs text-white/40 hover:text-white/70">← Equipment & fixed assets</Link>
        <div className="flex items-start justify-between gap-4 mt-2">
          <div>
            <h1 className="text-2xl font-black text-white/90">Fixed assets</h1>
            <p className="text-sm text-white/40 mt-1 max-w-2xl">
              Equipment and fit-out you own. Adding one puts it on the balance sheet; depreciation is charged monthly, straight line.
            </p>
          </div>
          <button onClick={() => setAdding(true)} className="rounded-xl bg-kds-green px-4 py-2.5 text-sm font-black text-black hover:opacity-90">+ Add asset</button>
        </div>
      </header>

      <div className="px-7 py-6 max-w-6xl mx-auto space-y-5">
        {data && (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            {[['Cost', data.totals.costCents], ['Depreciated', data.totals.accumulatedCents],
              ['Book value', data.totals.bookValueCents], ['Monthly charge', data.totals.monthlyCents]].map(([l, v]) => (
              <div key={l as string} className="rounded-2xl p-4" style={card}>
                <p className="text-[10px] uppercase tracking-wider text-white/40 font-bold">{l}</p>
                <p className="text-lg font-black text-white/90 mt-1">{fmtPkrWhole(v as number)}</p>
              </div>
            ))}
          </div>
        )}

        <div className="rounded-2xl p-4 flex flex-wrap items-center gap-3" style={card}>
          <p className="text-sm font-bold text-white/85">Charge depreciation for</p>
          <input type="month" value={period || data?.currentPeriod || ''} onChange={(e) => setPeriod(e.target.value)}
            className="rounded-lg px-3 py-1.5 text-sm bg-white/[0.04] border border-white/10 text-white/90" aria-label="Month" />
          <button onClick={() => { setRunMsg(''); run.mutate() }} disabled={run.isPending}
            className="rounded-lg bg-kds-green px-3 py-1.5 text-xs font-black text-black disabled:opacity-50">
            {run.isPending ? 'Posting…' : 'Charge month'}
          </button>
          <p className="text-xs text-white/50">{runMsg || 'Safe to run again — each asset is charged once per month. Charge the final month before disposing.'}</p>
        </div>

        {data && data.assets.length === 0 && (
          <div className="rounded-2xl p-10 text-center" style={card}>
            <p className="font-bold text-white/85">No assets yet</p>
            <p className="text-sm text-white/45 mt-1">Add your ovens, fridges, fit-out and vehicles. Equipment you already owned goes in as an opening balance.</p>
          </div>
        )}

        {data && data.assets.length > 0 && (
          <div className="rounded-2xl overflow-x-auto" style={card}>
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-[10px] uppercase tracking-wider text-white/40">
                  {['Asset', 'Category', 'Acquired', 'Cost', 'Depreciated', 'Book value', 'Per month', 'Charged to', ''].map((h) => (
                    <th key={h} className="px-4 py-3 font-bold">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {data.assets.map((a) => (
                  <tr key={a.id} className="border-t border-white/[0.05]" style={{ opacity: a.status === 'disposed' ? 0.5 : 1 }}>
                    <td className="px-4 py-3">
                      <p className="font-bold text-white/90">{a.name}</p>
                      <p className="text-[11px] text-white/40">{[a.assetTag, a.supplier].filter(Boolean).join(' · ') || '—'}</p>
                    </td>
                    <td className="px-4 py-3 text-white/60">{a.categoryLabel}</td>
                    <td className="px-4 py-3 text-white/60">{new Date(a.acquiredAt).toLocaleDateString()}</td>
                    <td className="px-4 py-3 text-white/80">{fmtPkrWhole(a.costCents)}</td>
                    <td className="px-4 py-3 text-white/60">{fmtPkrWhole(a.accumulatedCents)}</td>
                    <td className="px-4 py-3 font-bold text-white/90">{fmtPkrWhole(a.bookValueCents)}</td>
                    <td className="px-4 py-3 text-white/60">{fmtPkrWhole(a.monthlyCents)}</td>
                    <td className="px-4 py-3 text-white/60">{a.lastChargedPeriod ?? 'not yet'}</td>
                    <td className="px-4 py-3 text-right">
                      {a.status === 'active'
                        ? <button onClick={() => setDisposing(a)} className="text-xs font-bold text-white/50 hover:text-white">Dispose</button>
                        : <span className="text-xs text-white/40">Disposed {a.disposedAt ? new Date(a.disposedAt).toLocaleDateString() : ''}</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {adding && data && <AddAsset reg={data} concepts={concepts} onClose={() => setAdding(false)} />}
      {disposing && <Dispose asset={disposing} onClose={() => setDisposing(null)} />}
    </div>
  )
}

// Module level on purpose: a component declared inside another is a new type
// on every render, so React remounts its inputs and they lose focus per keystroke.
function L({ t, children }: { t: string; children: React.ReactNode }) {
  return <label className="block"><span className="text-[11px] font-bold text-white/50">{t}</span>{children}</label>
}

function Modal({ title, children, onClose }: { title: string; children: React.ReactNode; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4" onClick={onClose}>
      <div className="w-full max-w-lg rounded-2xl p-6 max-h-[90vh] overflow-y-auto" style={{ background: '#12131a', border: '1px solid rgba(255,255,255,0.08)' }}
        onClick={(e) => e.stopPropagation()}>
        <p className="text-lg font-black text-white/90 mb-4">{title}</p>
        {children}
      </div>
    </div>
  )
}

function AddAsset({ reg, concepts, onClose }: { reg: Register; concepts: Concept[]; onClose: () => void }) {
  const qc = useQueryClient()
  const [f, setF] = useState({
    name: '', category: 'kitchen_equipment', funding: 'bank', acquiredAt: new Date().toISOString().slice(0, 10),
    cost: '', salvage: '0', life: '60', conceptId: '', assetTag: '', serialNumber: '', supplier: '', notes: '',
  })
  const [err, setErr] = useState('')
  const save = useMutation({
    mutationFn: () => api.post('/accounting/fixed-assets', {
      name: f.name, category: f.category, funding: f.funding, acquiredAt: f.acquiredAt,
      costCents: Math.round(Number(f.cost) * 100), salvageCents: Math.round(Number(f.salvage || 0) * 100),
      usefulLifeMonths: Number(f.life), conceptId: f.conceptId || null,
      assetTag: f.assetTag || undefined, serialNumber: f.serialNumber || undefined,
      supplier: f.supplier || undefined, notes: f.notes || undefined,
    }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['fixed-assets'] }); onClose() },
    onError: (e: Error) => setErr(e.message),
  })
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
    setF((p) => ({ ...p, [k]: e.target.value, ...(k === 'category' ? { life: String(DEFAULT_LIFE[e.target.value] ?? 60) } : {}) }))
  return (
    <Modal title="Add asset" onClose={onClose}>
      <div className="grid grid-cols-2 gap-3">
        <div className="col-span-2"><L t="Name"><input className={inp} value={f.name} onChange={set('name')} placeholder="Rational combi oven" /></L></div>
        <L t="Category"><select className={inp} value={f.category} onChange={set('category')}>
          {Object.entries(reg.categories).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}</select></L>
        <L t="How it was paid for"><select className={inp} value={f.funding} onChange={set('funding')}>
          {Object.entries(reg.funding).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}</select></L>
        <L t="Acquired"><input type="date" className={inp} value={f.acquiredAt} onChange={set('acquiredAt')} /></L>
        <L t="Useful life (months)"><input type="number" min={1} className={inp} value={f.life} onChange={set('life')} /></L>
        <L t="Cost (PKR)"><input type="number" min={0} className={inp} value={f.cost} onChange={set('cost')} /></L>
        <L t="Salvage value (PKR)"><input type="number" min={0} className={inp} value={f.salvage} onChange={set('salvage')} /></L>
        <L t="Brand (optional)"><select className={inp} value={f.conceptId} onChange={set('conceptId')}>
          <option value="">Shared</option>{concepts.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></L>
        <L t="Asset tag"><input className={inp} value={f.assetTag} onChange={set('assetTag')} /></L>
        <L t="Serial number"><input className={inp} value={f.serialNumber} onChange={set('serialNumber')} /></L>
        <L t="Supplier"><input className={inp} value={f.supplier} onChange={set('supplier')} /></L>
        <div className="col-span-2"><L t="Notes"><textarea className={inp} rows={2} value={f.notes} onChange={set('notes')} /></L></div>
      </div>
      {f.funding === 'existing' && (
        <p className="text-[11px] text-white/45 mt-3">Already owned: enters the books against owner&rsquo;s capital. Use the original purchase date and cost, and depreciation catches up as you charge each month.</p>
      )}
      {err && <p className="text-xs text-red-400 mt-3">{err}</p>}
      <div className="flex gap-2 mt-5">
        <button onClick={() => save.mutate()} disabled={save.isPending || !f.name || !f.cost}
          className="rounded-lg bg-kds-green px-4 py-2 text-sm font-black text-black disabled:opacity-50">{save.isPending ? 'Saving…' : 'Add to register'}</button>
        <button onClick={onClose} className="rounded-lg px-4 py-2 text-sm text-white/60 border border-white/10">Cancel</button>
      </div>
    </Modal>
  )
}

function Dispose({ asset, onClose }: { asset: Asset; onClose: () => void }) {
  const qc = useQueryClient()
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10))
  const [proceeds, setProceeds] = useState('0')
  const [err, setErr] = useState('')
  const go = useMutation({
    mutationFn: () => api.post(`/accounting/fixed-assets/${asset.id}/dispose`, { disposedAt: date, proceedsCents: Math.round(Number(proceeds) * 100) }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['fixed-assets'] }); onClose() },
    onError: (e: Error) => setErr(e.message),
  })
  const gl = Math.round(Number(proceeds) * 100) - asset.bookValueCents
  return (
    <Modal title={`Dispose of ${asset.name}`} onClose={onClose}>
      <p className="text-sm text-white/60">Book value today: <strong className="text-white/90">{fmtPkrWhole(asset.bookValueCents)}</strong>. Charge this month&rsquo;s depreciation first if you haven&rsquo;t.</p>
      <div className="grid grid-cols-2 gap-3 mt-4">
        <label className="block"><span className="text-[11px] font-bold text-white/50">Date</span><input type="date" className={inp} value={date} onChange={(e) => setDate(e.target.value)} /></label>
        <label className="block"><span className="text-[11px] font-bold text-white/50">Sold for (PKR, 0 if scrapped)</span><input type="number" min={0} className={inp} value={proceeds} onChange={(e) => setProceeds(e.target.value)} /></label>
      </div>
      <p className="text-xs mt-3" style={{ color: gl >= 0 ? '#34d399' : '#f87171' }}>{gl >= 0 ? `Gain of ${fmtPkrWhole(gl)}` : `Loss of ${fmtPkrWhole(-gl)}`}</p>
      {err && <p className="text-xs text-red-400 mt-2">{err}</p>}
      <div className="flex gap-2 mt-5">
        <button onClick={() => go.mutate()} disabled={go.isPending} className="rounded-lg bg-kds-green px-4 py-2 text-sm font-black text-black disabled:opacity-50">{go.isPending ? 'Posting…' : 'Dispose'}</button>
        <button onClick={onClose} className="rounded-lg px-4 py-2 text-sm text-white/60 border border-white/10">Cancel</button>
      </div>
    </Modal>
  )
}
