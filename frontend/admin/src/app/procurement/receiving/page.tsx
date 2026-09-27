'use client'
// Goods receiving (GRN) — THE one receiving screen. Pick an open PO (approved
// and sent, or part-received) or take a delivery without a PO, mark what
// physically arrived, add a dock-door photo. The server (procurement
// receiveGoods) writes the goods receipt, the PO's received quantities, stock
// and the moving-average cost in one go, and flags variances over 5%.
//
// Owner decision 27: manager tiers only; a delivery without a PO needs the
// unit cost entered here; whoever raised a PO can't receive it (CEO exempt).
// The Procurement "Receive" action opens this page with ?poId=.

import { useEffect, useMemo, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import Link from 'next/link'
import { api } from '../../../lib/api'

interface Supplier { id: string; name: string }
interface OpenPoLine {
  id: string; inventoryItemId: string; quantityOrdered: number; quantityReceived: number; unitCostCents: number
  inventoryItem: { id: string; name: string; unit: string }
}
interface OpenPo {
  id: string; reference: string | null; supplierId: string; status: string; createdAt: string
  supplier: { id: string; name: string }
  lines: OpenPoLine[]
}
interface InventoryItem { id: string; name: string; unit: string; unitCostCents: number | null }
interface Receipt {
  id: string; poId: string | null; supplierId: string; receivedAt: string; status: string; varianceFlag: boolean
  lines: Array<{ id: string; description: string; receivedQty: number; unit: string }>
}

interface DraftLine {
  key: string
  poLineId: string | null
  inventoryItemId: string | null
  description: string
  outstanding: number | null     // PO lines: ordered − already received
  receivedQty: string
  unitCostPkr: string            // deliveries without a PO: cost per unit, PKR
  unit: string
  notes: string
}

const poLabel = (po: Pick<OpenPo, 'id' | 'reference'>) => po.reference ? `PO ${po.reference}` : `PO ${po.id.slice(0, 8).toUpperCase()}`
let keySeq = 0
const nextKey = () => `l${++keySeq}`

export default function ReceivingPage() {
  const qc = useQueryClient()
  const { data: pos = [] } = useQuery<OpenPo[]>({ queryKey: ['receiving', 'open-pos'], queryFn: () => api.get('/crosschecks/receiving/open-pos') })
  const { data: suppliers = [] } = useQuery<Supplier[]>({ queryKey: ['receiving', 'suppliers'], queryFn: () => api.get('/crosschecks/receiving/suppliers') })
  const { data: items = [] } = useQuery<InventoryItem[]>({ queryKey: ['inventory'], queryFn: () => api.get('/inventory') })
  const { data: receipts = [] } = useQuery<Receipt[]>({ queryKey: ['receipts'], queryFn: () => api.get('/crosschecks/receiving'), refetchInterval: 30_000 })

  const [supplierId, setSupplierId] = useState('')
  const [poId, setPoId] = useState<string | null>(null)
  const [photoUrl, setPhotoUrl] = useState('')
  const [notes, setNotes] = useState('')
  const [lines, setLines] = useState<DraftLine[]>([])
  const [feedback, setFeedback] = useState<{ tone: 'ok' | 'warn'; text: string } | null>(null)
  const [wantedPo, setWantedPo] = useState<string | null>(null)

  const supplierName = useMemo(() => {
    const m = new Map<string, string>()
    for (const s of suppliers) m.set(s.id, s.name)
    for (const p of pos) m.set(p.supplier.id, p.supplier.name)
    return m
  }, [suppliers, pos])

  // ?poId= from the Procurement "Receive" action preselects that PO.
  useEffect(() => {
    try { setWantedPo(new URLSearchParams(window.location.search).get('poId')) } catch { /* no window */ }
  }, [])
  useEffect(() => {
    if (!wantedPo || poId) return
    const po = pos.find((p) => p.id === wantedPo)
    if (po) { loadFromPo(po); setWantedPo(null) }
  }, [wantedPo, pos, poId])

  function loadFromPo(po: OpenPo) {
    setPoId(po.id)
    setSupplierId(po.supplierId)
    setLines(po.lines
      .map((l) => ({ l, outstanding: Math.max(0, l.quantityOrdered - l.quantityReceived) }))
      .filter(({ outstanding }) => outstanding > 0)
      .map(({ l, outstanding }) => ({
        key: nextKey(),
        poLineId: l.id,
        inventoryItemId: l.inventoryItemId,
        description: l.inventoryItem.name,
        outstanding,
        receivedQty: String(outstanding),     // staff edits down if short, 0 if it didn't come
        unitCostPkr: String(l.unitCostCents / 100),
        unit: l.inventoryItem.unit,
        notes: '',
      })))
  }

  function clearPo() {
    setPoId(null); setSupplierId(''); setLines([])
  }
  function addBlankLine() {
    setLines([...lines, { key: nextKey(), poLineId: null, inventoryItemId: null, description: '', outstanding: null, receivedQty: '', unitCostPkr: '', unit: '', notes: '' }])
  }
  function patchLine(key: string, p: Partial<DraftLine>) {
    setLines(lines.map((l) => l.key === key ? { ...l, ...p } : l))
  }
  function pickItem(key: string, itemId: string) {
    const it = items.find((i) => i.id === itemId)
    patchLine(key, {
      inventoryItemId: itemId || null,
      description: it?.name ?? '',
      unit: it?.unit ?? '',
      unitCostPkr: it?.unitCostCents != null ? String(it.unitCostCents / 100) : '',
    })
  }
  function rmLine(key: string) {
    setLines(lines.filter((l) => l.key !== key))
  }

  const adHocInvalid = !poId && lines.some((l) => !l.inventoryItemId || l.unitCostPkr.trim() === '' || !(Number(l.unitCostPkr) >= 0))
  const nothingArrived = !lines.some((l) => Number(l.receivedQty) > 0)

  const submit = useMutation({
    mutationFn: () => api.post<{ varianceFlag?: boolean; poStatus?: string | null }>('/crosschecks/receiving', {
      poId,
      supplierId: poId ? null : supplierId,
      photoUrl: photoUrl.trim() || null,
      notes: notes.trim() || null,
      lines: lines.map((l) => ({
        poLineId: l.poLineId,
        inventoryItemId: l.poLineId ? null : l.inventoryItemId,
        quantityReceived: Math.max(0, Number(l.receivedQty) || 0),
        unitCostCents: l.poLineId ? null : Math.round(Number(l.unitCostPkr) * 100),
        notes: l.notes.trim() || null,
      })),
    }),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ['receipts'] })
      void qc.invalidateQueries({ queryKey: ['receiving', 'open-pos'] })
      void qc.invalidateQueries({ queryKey: ['procurement', 'pos'] })
      void qc.invalidateQueries({ queryKey: ['inventory'] })
      void qc.invalidateQueries({ queryKey: ['exceptions'] })
      setLines([]); setPoId(null); setPhotoUrl(''); setNotes(''); setSupplierId('')
      setFeedback(r.varianceFlag
        ? { tone: 'warn', text: 'Receipt saved. A variance over 5% was flagged in Exceptions.' }
        : { tone: 'ok', text: r.poStatus === 'partial' ? 'Receipt saved. The PO stays open for the rest.' : 'Receipt saved, stock and cost updated.' })
      setTimeout(() => setFeedback(null), 6000)
    },
  })

  const selectedPo = pos.find((p) => p.id === poId) ?? null

  return (
    <div className="min-h-screen" style={{ background: '#090a0e' }}>
      <header className="px-7 py-6 border-b border-white/[0.05]">
        <Link href="/procurement" className="text-xs text-white/40 hover:text-white/70">← Procurement</Link>
        <h1 className="text-2xl font-black text-white/90 mt-2">Receiving (dock door)</h1>
        <p className="text-sm text-white/40 mt-1 max-w-2xl">
          Mark what physically arrived. Stock, the PO and the ingredient cost update together; short shipments and
          variances over 5% go to the Exceptions inbox. Whoever raised a PO can&apos;t receive it.
        </p>
      </header>

      <div className="px-7 py-6 max-w-4xl mx-auto space-y-5">
        {feedback && (
          <div className="rounded-xl px-4 py-3 text-sm font-bold"
            style={{
              background: feedback.tone === 'warn' ? 'rgba(245,158,11,0.1)' : 'rgba(0,212,177,0.1)',
              color: feedback.tone === 'warn' ? '#FCD34D' : '#00D4B1',
              border: `1px solid ${feedback.tone === 'warn' ? 'rgba(245,158,11,0.3)' : 'rgba(0,212,177,0.3)'}`,
            }}>
            {feedback.text}
          </div>
        )}

        <Section title="Step 1 — Match to a PO (or take a delivery without one)">
          {selectedPo ? (
            <div className="flex items-center justify-between rounded-lg p-3" style={{ background: 'rgba(0,212,177,0.08)', border: '1px solid rgba(0,212,177,0.35)' }}>
              <div>
                <p className="text-sm font-bold text-white/90">{poLabel(selectedPo)} · {selectedPo.supplier.name}</p>
                <p className="text-xs text-white/45">{selectedPo.status === 'partial' ? 'Part-received — showing what is still outstanding' : 'Sent'}</p>
              </div>
              <button onClick={clearPo} className="text-xs text-white/50 hover:text-white/80">Change</button>
            </div>
          ) : (
            <>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                {pos.length === 0 && <p className="text-xs text-white/35 italic">No purchase orders waiting to be received.</p>}
                {pos.map((po) => (
                  <button key={po.id} onClick={() => loadFromPo(po)}
                    className="rounded-lg p-3 text-left transition-colors"
                    style={{ background: 'rgba(255,255,255,0.025)', border: '1px solid rgba(255,255,255,0.06)' }}>
                    <p className="text-sm font-bold text-white/90">{poLabel(po)}</p>
                    <p className="text-xs text-white/45">{po.supplier.name} · {po.lines.length} lines{po.status === 'partial' ? ' · part-received' : ''}</p>
                  </button>
                ))}
              </div>
              <div className="mt-3">
                <label className="text-xs text-white/55">Or a delivery without a PO (market run, ad-hoc) from</label>
                <select value={supplierId} onChange={(e) => setSupplierId(e.target.value)} className={fieldCls + ' mt-1'}>
                  <option value="">— choose supplier —</option>
                  {suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
              </div>
            </>
          )}
        </Section>

        <Section title="Step 2 — Mark received quantities">
          {lines.length === 0 && <p className="text-xs text-white/35 italic">{poId ? 'Nothing outstanding on this PO.' : 'Pick a PO above or add lines.'}</p>}
          {lines.map((l) => {
            const qty = Number(l.receivedQty) || 0
            const variance = l.outstanding != null && l.outstanding > 0 ? ((qty - l.outstanding) / l.outstanding) * 100 : null
            const flag = variance != null && Math.abs(variance) > 5
            return (
              <div key={l.key} className="rounded-lg p-3 space-y-2 mt-2"
                style={{
                  background: flag ? 'rgba(245,158,11,0.05)' : 'rgba(255,255,255,0.025)',
                  border: `1px solid ${flag ? 'rgba(245,158,11,0.3)' : 'rgba(255,255,255,0.06)'}`,
                }}>
                <div className="grid grid-cols-[1fr_auto_auto_auto] gap-2 items-center">
                  {l.poLineId ? (
                    <p className="text-sm font-bold text-white/85">{l.description}</p>
                  ) : (
                    <select value={l.inventoryItemId ?? ''} onChange={(e) => pickItem(l.key, e.target.value)} className={fieldCls}>
                      <option value="">— inventory item —</option>
                      {items.map((i) => <option key={i.id} value={i.id}>{i.name} ({i.unit})</option>)}
                    </select>
                  )}
                  {l.outstanding != null && <span className="text-xs text-white/45 font-mono whitespace-nowrap">Due: {l.outstanding} {l.unit}</span>}
                  <input type="number" step="0.01" min="0" value={l.receivedQty} onChange={(e) => patchLine(l.key, { receivedQty: e.target.value })}
                    className={fieldCls + ' w-24'} placeholder="Recv" />
                  <div className="flex items-center gap-1">
                    <span className="text-xs text-white/45 w-10">{l.unit}</span>
                    {!poId && <button onClick={() => rmLine(l.key)} className="text-white/30 hover:text-red-400 text-sm px-2" aria-label="Remove line">×</button>}
                  </div>
                </div>
                {!l.poLineId && (
                  <div className="flex items-center gap-2">
                    <label className="text-xs text-white/55 whitespace-nowrap">Unit cost paid (PKR per {l.unit || 'unit'})</label>
                    <input type="number" step="0.01" min="0" value={l.unitCostPkr} onChange={(e) => patchLine(l.key, { unitCostPkr: e.target.value })}
                      className={fieldCls + ' w-32'} placeholder="0.00" />
                  </div>
                )}
                {variance != null && Math.abs(variance) > 0.5 && (
                  <p className="text-[11px] font-bold" style={{ color: flag ? '#FCD34D' : 'rgba(255,255,255,0.55)' }}>
                    {variance > 0 ? '+' : ''}{variance.toFixed(1)}% {flag ? '— will flag' : ''}
                  </p>
                )}
                <input value={l.notes} onChange={(e) => patchLine(l.key, { notes: e.target.value })}
                  placeholder="Note (damaged, wrong cut, expiry near…)" className={fieldCls + ' text-xs'} />
              </div>
            )
          })}
          {!poId && supplierId && (
            <button onClick={addBlankLine} className="text-xs text-kds-green hover:underline mt-2">+ Add line</button>
          )}
        </Section>

        <Section title="Step 3 — Evidence">
          <div>
            <label className="text-xs text-white/55">Dock-door photo URL</label>
            <input value={photoUrl} onChange={(e) => setPhotoUrl(e.target.value)} placeholder="https://… (snap with phone, paste link)" className={fieldCls + ' mt-1'} />
            <p className="text-[11px] text-white/35 mt-1">Required above your company&apos;s photo threshold. Settles supplier disputes later.</p>
          </div>
          <div className="mt-3">
            <label className="text-xs text-white/55">Notes</label>
            <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} placeholder="Driver name, time, anything off about the delivery." className={fieldCls + ' mt-1'} />
          </div>
        </Section>

        {submit.error && <ErrorBanner error={submit.error} />}

        <div className="flex justify-end gap-3 pt-2">
          <button onClick={() => submit.mutate()}
            disabled={submit.isPending || lines.length === 0 || (!supplierId && !poId) || adHocInvalid || nothingArrived}
            className="rounded-xl bg-kds-green px-6 py-3 text-sm font-black text-black hover:opacity-90 disabled:opacity-50">
            {submit.isPending ? 'Saving…' : 'Accept delivery →'}
          </button>
        </div>

        <div className="pt-6 mt-6 border-t border-white/[0.05]">
          <h2 className="text-xs font-black uppercase tracking-[0.24em] text-white/55 mb-3">Recent deliveries · {receipts.length}</h2>
          <div className="space-y-1.5">
            {receipts.slice(0, 20).map((r) => (
              <div key={r.id} className="flex items-center justify-between rounded-lg px-3 py-2 text-xs"
                style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.05)' }}>
                <span className="text-white/75">{new Date(r.receivedAt).toLocaleString()} · {supplierName.get(r.supplierId) ?? 'Supplier'}</span>
                <span className="text-white/45">{r.poId ? 'PO' : 'No PO'} · {r.lines.length} lines · <span style={{ color: r.varianceFlag ? '#FCD34D' : undefined }}>{r.status}</span></span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-2xl p-5"
      style={{ background: 'rgba(255,255,255,0.025)', border: '1px solid rgba(255,255,255,0.06)' }}>
      <h2 className="text-sm font-black uppercase tracking-[0.18em] text-white/65">{title}</h2>
      <div className="mt-3">{children}</div>
    </div>
  )
}
function ErrorBanner({ error }: { error: unknown }) {
  const msg = error instanceof Error ? error.message : 'Something went wrong'
  return <div className="rounded-xl px-4 py-3 text-sm" style={{ background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.3)', color: '#FCA5A5' }}><strong>Save failed:</strong> {msg}</div>
}
const fieldCls = "w-full rounded-lg bg-white/[0.03] border border-white/[0.08] px-3 py-2 text-sm text-white/85 focus:border-kds-green focus:outline-none"
