'use client'
// Goods receiving (GRN) — staff scans a PO, marks received qty + photo per
// line, system auto-creates an ExceptionFlag if variance > threshold.
// 3-way match: PO qty / GRN qty / Bill qty (Bill match on AP posting).

import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import Link from 'next/link'
import { api } from '../../../lib/api'

interface Supplier { id: string; name: string }
interface PurchaseOrder { id: string; poNumber: string; supplierId: string; status: string; lines: Array<{ id: string; description: string; quantity: number; unitCostCents: number; unit: string; inventoryItemId: string | null }>; createdBy?: string }
interface InventoryItem { id: string; name: string; unit: string; currentStock: number }

interface DraftLine {
  inventoryItemId: string | null
  description: string
  poQty: number | null
  receivedQty: number
  poUnitCostCents: number | null
  unit: string
  notes: string
}

export default function ReceivingPage() {
  const qc = useQueryClient()
  const { data: suppliers = [] } = useQuery<Supplier[]>({ queryKey: ['suppliers'], queryFn: () => api.get('/procurement/suppliers') })
  const { data: pos = [] } = useQuery<PurchaseOrder[]>({ queryKey: ['pos'], queryFn: () => api.get('/procurement/pos?status=open') })
  const { data: items = [] } = useQuery<InventoryItem[]>({ queryKey: ['inventory'], queryFn: () => api.get('/inventory') })
  const { data: receipts = [] } = useQuery<unknown[]>({ queryKey: ['receipts'], queryFn: () => api.get('/crosschecks/receiving'), refetchInterval: 30_000 })

  const [supplierId, setSupplierId] = useState('')
  const [poId, setPoId] = useState<string | null>(null)
  const [photoUrl, setPhotoUrl] = useState('')
  const [notes, setNotes] = useState('')
  const [lines, setLines] = useState<DraftLine[]>([])
  const [feedback, setFeedback] = useState<string | null>(null)

  function loadFromPo(po: PurchaseOrder) {
    setPoId(po.id)
    setSupplierId(po.supplierId)
    setLines(po.lines.map((l) => ({
      inventoryItemId: l.inventoryItemId,
      description: l.description,
      poQty: l.quantity,
      receivedQty: l.quantity,                // staff edits down if short
      poUnitCostCents: l.unitCostCents,
      unit: l.unit,
      notes: '',
    })))
  }

  function addBlankLine() {
    setLines([...lines, { inventoryItemId: null, description: '', poQty: null, receivedQty: 0, poUnitCostCents: null, unit: 'kg', notes: '' }])
  }
  function patchLine(i: number, p: Partial<DraftLine>) {
    setLines(lines.map((l, idx) => idx === i ? { ...l, ...p } : l))
  }
  function rmLine(i: number) {
    setLines(lines.filter((_, idx) => idx !== i))
  }

  const submit = useMutation({
    mutationFn: () => api.post('/crosschecks/receiving', {
      poId, supplierId,
      photoUrl: photoUrl || null,
      notes: notes || null,
      lines: lines.filter((l) => l.description.trim() && l.receivedQty >= 0),
    }),
    onSuccess: (created: unknown) => {
      qc.invalidateQueries({ queryKey: ['receipts'] })
      qc.invalidateQueries({ queryKey: ['exceptions'] })
      setLines([]); setPoId(null); setPhotoUrl(''); setNotes(''); setSupplierId('')
      const r = created as { varianceFlag?: boolean }
      setFeedback(r.varianceFlag ? '⚠️ Receipt saved — variance detected, flagged in Exceptions.' : '✓ Receipt accepted, inventory updated.')
      setTimeout(() => setFeedback(null), 6000)
    },
  })

  return (
    <div className="min-h-screen" style={{ background: '#090a0e' }}>
      <header className="px-7 py-6 border-b border-white/[0.05]">
        <Link href="/procurement" className="text-xs text-white/40 hover:text-white/70">← Procurement</Link>
        <h1 className="text-2xl font-black text-white/90 mt-2">📦 Receiving (dock-door)</h1>
        <p className="text-sm text-white/40 mt-1 max-w-2xl">
          Mark what physically arrived. System auto-flags short shipments + price drift to the exception inbox.
          Photos at the dock prevent supplier disputes later.
        </p>
      </header>

      <div className="px-7 py-6 max-w-4xl space-y-5">
        {feedback && (
          <div className="rounded-xl px-4 py-3 text-sm font-bold"
            style={{
              background: feedback.startsWith('⚠') ? 'rgba(245,158,11,0.1)' : 'rgba(0,212,177,0.1)',
              color: feedback.startsWith('⚠') ? '#FCD34D' : '#00D4B1',
              border: `1px solid ${feedback.startsWith('⚠') ? 'rgba(245,158,11,0.3)' : 'rgba(0,212,177,0.3)'}`,
            }}>
            {feedback}
          </div>
        )}

        {/* PO scanner */}
        <Section title="Step 1 — Match to a PO (or skip for ad-hoc)">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {pos.length === 0 && <p className="text-xs text-white/35 italic">No open purchase orders. Use ad-hoc receive below.</p>}
            {pos.map((po) => (
              <button key={po.id} onClick={() => loadFromPo(po)}
                className="rounded-lg p-3 text-left transition-colors"
                style={poId === po.id
                  ? { background: 'rgba(0,212,177,0.1)', border: '1px solid rgba(0,212,177,0.45)' }
                  : { background: 'rgba(255,255,255,0.025)', border: '1px solid rgba(255,255,255,0.06)' }}>
                <p className="text-sm font-bold text-white/90">{po.poNumber}</p>
                <p className="text-xs text-white/45">{suppliers.find((s) => s.id === po.supplierId)?.name ?? '—'} · {po.lines.length} lines</p>
              </button>
            ))}
          </div>
          {!poId && (
            <div className="mt-3">
              <label className="text-xs text-white/55">Or pick a supplier for an ad-hoc delivery</label>
              <select value={supplierId} onChange={(e) => setSupplierId(e.target.value)} className={fieldCls + ' mt-1'}>
                <option value="">— choose supplier —</option>
                {suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </div>
          )}
        </Section>

        {/* Lines */}
        <Section title="Step 2 — Mark received quantities">
          {lines.length === 0 && <p className="text-xs text-white/35 italic">{poId ? 'No lines on this PO.' : 'Pick a PO above or add lines manually.'}</p>}
          {lines.map((l, i) => {
            const variance = l.poQty != null && l.poQty > 0 ? ((l.receivedQty - l.poQty) / l.poQty) * 100 : null
            const flag = variance != null && Math.abs(variance) > 5
            return (
              <div key={i} className="rounded-lg p-3 space-y-2 mt-2"
                style={{
                  background: flag ? 'rgba(245,158,11,0.05)' : 'rgba(255,255,255,0.025)',
                  border: `1px solid ${flag ? 'rgba(245,158,11,0.3)' : 'rgba(255,255,255,0.06)'}`,
                }}>
                <div className="grid grid-cols-[1fr_auto_auto_auto] gap-2 items-center">
                  {l.poQty != null ? (
                    <p className="text-sm font-bold text-white/85">{l.description}</p>
                  ) : (
                    <input value={l.description} onChange={(e) => patchLine(i, { description: e.target.value })} placeholder="Item description" className={fieldCls} />
                  )}
                  {l.poQty != null && <span className="text-xs text-white/45 font-mono whitespace-nowrap">PO: {l.poQty} {l.unit}</span>}
                  <input type="number" step="0.01" value={l.receivedQty} onChange={(e) => patchLine(i, { receivedQty: parseFloat(e.target.value) || 0 })}
                    className={fieldCls + ' w-24'} placeholder="Recv" />
                  <span className="text-xs text-white/45 w-12">{l.unit}</span>
                  {!poId && <button onClick={() => rmLine(i)} className="text-white/30 hover:text-red-400 text-sm px-2">✕</button>}
                </div>
                {variance != null && Math.abs(variance) > 0.5 && (
                  <p className="text-[11px] font-bold" style={{ color: flag ? '#FCD34D' : 'rgba(255,255,255,0.55)' }}>
                    {variance > 0 ? '+' : ''}{variance.toFixed(1)}% {flag ? '— will flag' : ''}
                  </p>
                )}
                <input value={l.notes} onChange={(e) => patchLine(i, { notes: e.target.value })}
                  placeholder="Note (damaged, wrong cut, expiry near…)" className={fieldCls + ' text-xs'} />
              </div>
            )
          })}
          {!poId && (
            <button onClick={addBlankLine} className="text-xs text-kds-green hover:underline mt-2">+ Add line</button>
          )}
        </Section>

        {/* Photo + notes */}
        <Section title="Step 3 — Evidence">
          <div>
            <label className="text-xs text-white/55">Dock-door photo URL</label>
            <input value={photoUrl} onChange={(e) => setPhotoUrl(e.target.value)} placeholder="https://… (snap with phone, paste link)" className={fieldCls + ' mt-1'} />
            <p className="text-[11px] text-white/35 mt-1">Strong recommend. Settles supplier disputes later.</p>
          </div>
          <div className="mt-3">
            <label className="text-xs text-white/55">Notes</label>
            <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} placeholder="Driver name, time, anything off about the delivery." className={fieldCls + ' mt-1'} />
          </div>
        </Section>

        {submit.error && <ErrorBanner error={submit.error} />}

        <div className="flex justify-end gap-3 pt-2">
          <button onClick={() => submit.mutate()} disabled={submit.isPending || lines.length === 0 || (!supplierId && !poId)}
            className="rounded-xl bg-kds-green px-6 py-3 text-sm font-black text-black hover:opacity-90 disabled:opacity-50">
            {submit.isPending ? 'Saving…' : 'Accept delivery →'}
          </button>
        </div>

        {/* Recent receipts */}
        <div className="pt-6 mt-6 border-t border-white/[0.05]">
          <h2 className="text-xs font-black uppercase tracking-[0.24em] text-white/55 mb-3">Recent deliveries · {receipts.length}</h2>
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
