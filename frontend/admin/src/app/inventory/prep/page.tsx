'use client'
// Prep batch logging — chef records what they used + what they made.
// Yield variance < 85% fires an ExceptionFlag (skim signal).

import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import Link from 'next/link'
import { api } from '../../../lib/api'

interface InventoryItem { id: string; name: string; unit: string; currentStock: number }
interface DraftInput { inventoryItemId: string; qtyDrawn: number; unit: string }
interface PrepBatch { id: string; itemName: string; actualYieldQty: number; expectedYieldQty: number | null; yieldVariancePct: number | null; createdAt: string; staffId: string }

export default function PrepBatchPage() {
  const qc = useQueryClient()
  const { data: items = [] } = useQuery<InventoryItem[]>({ queryKey: ['inventory'], queryFn: () => api.get('/inventory') })
  const { data: batches = [] } = useQuery<PrepBatch[]>({ queryKey: ['prep-batches'], queryFn: () => api.get('/crosschecks/prep-batches'), refetchInterval: 30_000 })

  const [itemName, setItemName] = useState('')
  const [inputs, setInputs] = useState<DraftInput[]>([])
  const [expectedYieldQty, setExpectedYieldQty] = useState<number | ''>('')
  const [actualYieldQty, setActualYieldQty] = useState<number | ''>('')
  const [unit, setUnit] = useState('g')
  const [photoUrl, setPhotoUrl] = useState('')
  const [notes, setNotes] = useState('')
  const [feedback, setFeedback] = useState<string | null>(null)

  const submit = useMutation({
    mutationFn: () => api.post('/crosschecks/prep-batches', {
      itemName, inputs,
      expectedYieldQty: expectedYieldQty === '' ? null : expectedYieldQty,
      actualYieldQty: actualYieldQty === '' ? 0 : actualYieldQty,
      unit,
      photoUrl: photoUrl || null,
      notes: notes || null,
    }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['prep-batches'] })
      qc.invalidateQueries({ queryKey: ['inventory'] })
      qc.invalidateQueries({ queryKey: ['exceptions'] })
      const yieldPct = expectedYieldQty && actualYieldQty ? +actualYieldQty / +expectedYieldQty : null
      setFeedback(yieldPct != null && yieldPct < 0.85 ? '⚠️ Batch saved — low yield flagged.' : '✓ Batch logged, inventory deducted.')
      setItemName(''); setInputs([]); setExpectedYieldQty(''); setActualYieldQty(''); setPhotoUrl(''); setNotes('')
      setTimeout(() => setFeedback(null), 5000)
    },
  })

  function addInput() { setInputs([...inputs, { inventoryItemId: items[0]?.id ?? '', qtyDrawn: 0, unit: 'g' }]) }
  function patchInput(i: number, p: Partial<DraftInput>) { setInputs(inputs.map((x, idx) => idx === i ? { ...x, ...p } : x)) }
  function rmInput(i: number) { setInputs(inputs.filter((_, idx) => idx !== i)) }

  const yieldPct = expectedYieldQty && actualYieldQty && +expectedYieldQty > 0 ? (+actualYieldQty / +expectedYieldQty) * 100 : null

  return (
    <div className="min-h-screen" style={{ background: '#090a0e' }}>
      <header className="px-7 py-6 border-b border-white/[0.05]">
        <Link href="/inventory" className="text-xs text-white/40 hover:text-white/70">← Inventory</Link>
        <h1 className="text-2xl font-black text-white/90 mt-2">🥣 Prep batch log</h1>
        <p className="text-sm text-white/40 mt-1 max-w-2xl">
          Record what you drew from inventory + what you made. Low-yield batches (under 85%) auto-flag to the owner inbox.
        </p>
      </header>

      <div className="px-7 py-6 max-w-3xl mx-auto space-y-5">
        {feedback && (
          <div className="rounded-xl px-4 py-3 text-sm font-bold"
            style={{
              background: feedback.startsWith('⚠') ? 'rgba(245,158,11,0.1)' : 'rgba(0,212,177,0.1)',
              color: feedback.startsWith('⚠') ? '#FCD34D' : '#00D4B1',
              border: `1px solid ${feedback.startsWith('⚠') ? 'rgba(245,158,11,0.3)' : 'rgba(0,212,177,0.3)'}`,
            }}>{feedback}</div>
        )}

        <Section title="What did you make?">
          <Field label="Prep name *">
            <input value={itemName} onChange={(e) => setItemName(e.target.value)} placeholder="Confit garlic aioli" className={fieldCls} />
          </Field>
          <div className="grid grid-cols-2 gap-3 mt-3">
            <Field label="Expected yield">
              <input type="number" step="0.1" value={expectedYieldQty} onChange={(e) => setExpectedYieldQty(e.target.value === '' ? '' : parseFloat(e.target.value))} placeholder="e.g. 500" className={fieldCls} />
            </Field>
            <Field label="Actual yield *">
              <input type="number" step="0.1" value={actualYieldQty} onChange={(e) => setActualYieldQty(e.target.value === '' ? '' : parseFloat(e.target.value))} placeholder="What you got" className={fieldCls} />
            </Field>
          </div>
          <Field label="Unit"><input value={unit} onChange={(e) => setUnit(e.target.value)} className={fieldCls + ' max-w-[100px]'} /></Field>
          {yieldPct != null && (
            <div className="mt-3 rounded-lg p-3 text-sm font-bold"
              style={{
                background: yieldPct < 85 ? 'rgba(245,158,11,0.08)' : 'rgba(0,212,177,0.08)',
                color: yieldPct < 85 ? '#FCD34D' : '#00D4B1',
                border: `1px solid ${yieldPct < 85 ? 'rgba(245,158,11,0.3)' : 'rgba(0,212,177,0.3)'}`,
              }}>
              Yield: {yieldPct.toFixed(1)}% {yieldPct < 85 && '— will flag (under 85%)'}
            </div>
          )}
        </Section>

        <Section title="What did you use?">
          {inputs.length === 0 && <p className="text-xs text-white/35 italic">No ingredients yet. Add at least one.</p>}
          {inputs.map((inp, i) => (
            <div key={i} className="grid grid-cols-[1fr_100px_70px_auto] gap-2 items-center mt-2">
              <select value={inp.inventoryItemId} onChange={(e) => patchInput(i, { inventoryItemId: e.target.value })} className={fieldCls}>
                <option value="">— ingredient —</option>
                {items.map((it) => <option key={it.id} value={it.id}>{it.name} ({it.currentStock} {it.unit})</option>)}
              </select>
              <input type="number" step="0.01" value={inp.qtyDrawn} onChange={(e) => patchInput(i, { qtyDrawn: parseFloat(e.target.value) || 0 })} placeholder="Qty" className={fieldCls} />
              <input value={inp.unit} onChange={(e) => patchInput(i, { unit: e.target.value })} className={fieldCls} />
              <button onClick={() => rmInput(i)} className="text-white/30 hover:text-red-400 px-2">✕</button>
            </div>
          ))}
          <button onClick={addInput} className="text-xs text-kds-green hover:underline mt-3">+ Add ingredient</button>
        </Section>

        <Section title="Evidence (optional)">
          <Field label="Photo URL"><input value={photoUrl} onChange={(e) => setPhotoUrl(e.target.value)} placeholder="https://… of finished prep" className={fieldCls} /></Field>
          <Field label="Notes"><textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} className={fieldCls} /></Field>
        </Section>

        {submit.error && <div className="rounded-xl px-4 py-3 text-sm text-red-400" style={{ background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.3)' }}>Save failed: {(submit.error as Error).message}</div>}

        <div className="flex justify-end pt-2">
          <button onClick={() => submit.mutate()} disabled={submit.isPending || !itemName.trim() || inputs.length === 0 || !actualYieldQty}
            className="rounded-xl bg-kds-green px-6 py-3 text-sm font-black text-black hover:opacity-90 disabled:opacity-50">
            {submit.isPending ? 'Saving…' : 'Log batch →'}
          </button>
        </div>

        {batches.length > 0 && (
          <div className="pt-6 mt-6 border-t border-white/[0.05]">
            <h2 className="text-xs font-black uppercase tracking-[0.24em] text-white/55 mb-3">Recent batches</h2>
            <div className="space-y-2">
              {batches.slice(0, 10).map((b) => (
                <div key={b.id} className="rounded-lg p-3 flex items-center justify-between"
                  style={{ background: 'rgba(255,255,255,0.025)', border: '1px solid rgba(255,255,255,0.06)' }}>
                  <div>
                    <p className="text-sm font-bold text-white/85">{b.itemName}</p>
                    <p className="text-xs text-white/45">{b.actualYieldQty} yielded · {new Date(b.createdAt).toLocaleString()}</p>
                  </div>
                  {b.yieldVariancePct != null && (
                    <span className="text-xs font-bold" style={{ color: b.yieldVariancePct < 0.85 ? '#FCD34D' : '#00D4B1' }}>
                      {(b.yieldVariancePct * 100).toFixed(0)}% yield
                    </span>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return <div className="rounded-2xl p-5" style={{ background: 'rgba(255,255,255,0.025)', border: '1px solid rgba(255,255,255,0.06)' }}>
    <h2 className="text-sm font-black uppercase tracking-[0.18em] text-white/65">{title}</h2>
    <div className="mt-3">{children}</div>
  </div>
}
function Field({ label, children }: { label: string; children: React.ReactNode }) { return <div><label className="text-xs text-white/55">{label}</label><div className="mt-1">{children}</div></div> }
const fieldCls = "w-full rounded-lg bg-white/[0.03] border border-white/[0.08] px-3 py-2 text-sm text-white/85 focus:border-kds-green focus:outline-none"
