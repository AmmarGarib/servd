'use client'
// Prep batch logging — chef records what they used + what they made.
// Yield variance < 85% fires an ExceptionFlag (skim signal).
//
// This is the ONE place prep is recorded (owner decision 29): the batch
// deducts its ingredients, records the yield and feeds "made today" on the par
// sheet. Pick the sub-recipe from the recipe library (the par sheet's list for
// your company); its ingredients and expected yield are filled in for you, in
// each ingredient's own stock unit, so a 200 g draw from a kg item deducts
// 0.2 kg — not 200 kg.

import { useEffect, useMemo, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import Link from 'next/link'
import { api, ApiError } from '../../../lib/api'
import { canOpenPath } from '../../../lib/moduleCatalog'
import { usePermissions } from '../../../hooks/useCan'

interface InventoryItem { id: string; name: string; unit: string; currentStock: number }
interface DraftInput { inventoryItemId: string; qtyDrawn: number; unit: string }
interface PrepBatch { id: string; itemName: string; actualYieldQty: number; expectedYieldQty: number | null; yieldVariancePct: number | null; createdAt: string; staffId: string; unit: string }
interface PrepOption {
  id: string; name: string; yieldGrams: number | null
  inputs: Array<{ inventoryItemId: string | null; name: string; unit: string; qtyDrawn: number; missing: boolean }>
  subPreps: Array<{ id: string; name: string | null; grams: number }>
}

const AD_HOC = '__ad_hoc__'

export default function PrepBatchPage() {
  const qc = useQueryClient()
  // This page is reached from Inventory (inventory) and from the par sheet
  // (par_sheet — kitchen, expediter): link back only to the pages this login
  // can open.
  const { data: me } = usePermissions()
  const canOpen = (path: string) => !!me && canOpenPath(path, me.role, me.modules ?? [])
  // The stock list needs the inventory module; kitchen and expediter open this
  // page from the par sheet (par_sheet) without it, so GET /inventory 403s for
  // them — no toast, no retry. Their batches still work: the sub-recipe fills
  // the ingredients, and the ingredient list falls back to the ones the
  // company's sub-recipes draw (below).
  const { data: items = [] } = useQuery<InventoryItem[]>({
    queryKey: ['inventory'],
    queryFn: () => api.get('/inventory'),
    meta: { background: true },
    retry: (count, err) => !(err instanceof ApiError && err.status === 403) && count < 1,
  })
  const { data: preps = [] } = useQuery<PrepOption[]>({ queryKey: ['par-sheet', 'preps'], queryFn: () => api.get('/par-sheet/preps') })
  const { data: batches = [] } = useQuery<PrepBatch[]>({ queryKey: ['prep-batches'], queryFn: () => api.get('/crosschecks/prep-batches'), refetchInterval: 30_000 })

  const [recipeId, setRecipeId] = useState('')
  const [multiplier, setMultiplier] = useState(1)
  const [itemName, setItemName] = useState('')
  const [inputs, setInputs] = useState<DraftInput[]>([])
  const [expectedYieldQty, setExpectedYieldQty] = useState<number | ''>('')
  const [actualYieldQty, setActualYieldQty] = useState<number | ''>('')
  const [photoUrl, setPhotoUrl] = useState('')
  const [notes, setNotes] = useState('')
  const [feedback, setFeedback] = useState<string | null>(null)

  // Ingredient choices: the stock list when this login can read it, else the
  // ingredients of the company's sub-recipes (name + stock unit, no on-hand).
  const ingredients = useMemo<Array<{ id: string; label: string; unit: string }>>(() => {
    if (items.length > 0) return items.map((i) => ({ id: i.id, label: `${i.name} (${i.currentStock} ${i.unit})`, unit: i.unit }))
    const seen = new Map<string, { id: string; label: string; unit: string }>()
    for (const p of preps) {
      for (const i of p.inputs) {
        if (i.inventoryItemId && !seen.has(i.inventoryItemId)) seen.set(i.inventoryItemId, { id: i.inventoryItemId, label: i.name, unit: i.unit })
      }
    }
    return [...seen.values()].sort((a, b) => a.label.localeCompare(b.label))
  }, [items, preps])
  const itemById = useMemo(() => new Map(ingredients.map((i) => [i.id, i])), [ingredients])
  const prep = preps.find((p) => p.id === recipeId)
  const adHoc = recipeId === AD_HOC

  // Fill the form from the sub-recipe × number of batches.
  function applyRecipe(p: PrepOption | undefined, mult: number) {
    if (!p) return
    setItemName(p.name)
    setInputs(p.inputs.filter((i) => i.inventoryItemId).map((i) => ({
      inventoryItemId: i.inventoryItemId!, qtyDrawn: Math.round(i.qtyDrawn * mult * 1000) / 1000, unit: i.unit,
    })))
    setExpectedYieldQty(p.yieldGrams ? Math.round(p.yieldGrams * mult) : '')
  }

  // /inventory/prep?recipeId=<id> — opened from the par sheet's "Log batch".
  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get('recipeId')
    if (id && !recipeId && preps.some((p) => p.id === id)) {
      setRecipeId(id)
      applyRecipe(preps.find((p) => p.id === id), 1)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preps])

  const submit = useMutation({
    mutationFn: () => api.post('/crosschecks/prep-batches', {
      recipeId: adHoc || !recipeId ? null : recipeId,
      itemName, inputs,
      expectedYieldQty: expectedYieldQty === '' ? null : expectedYieldQty,
      actualYieldQty: actualYieldQty === '' ? 0 : actualYieldQty,
      unit: 'g',
      photoUrl: photoUrl || null,
      notes: notes || null,
    }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['prep-batches'] })
      qc.invalidateQueries({ queryKey: ['inventory'] })
      qc.invalidateQueries({ queryKey: ['par-sheet'] })
      qc.invalidateQueries({ queryKey: ['exceptions'] })
      const yieldPct = expectedYieldQty && actualYieldQty ? +actualYieldQty / +expectedYieldQty : null
      setFeedback(yieldPct != null && yieldPct < 0.85 ? '⚠️ Batch saved — low yield flagged.' : '✓ Batch logged, inventory deducted.')
      setRecipeId(''); setMultiplier(1)
      setItemName(''); setInputs([]); setExpectedYieldQty(''); setActualYieldQty(''); setPhotoUrl(''); setNotes('')
      setTimeout(() => setFeedback(null), 5000)
    },
  })

  function addInput() {
    const first = ingredients[0]
    setInputs([...inputs, { inventoryItemId: first?.id ?? '', qtyDrawn: 0, unit: first?.unit ?? '' }])
  }
  function patchInput(i: number, p: Partial<DraftInput>) { setInputs(inputs.map((x, idx) => idx === i ? { ...x, ...p } : x)) }
  function rmInput(i: number) { setInputs(inputs.filter((_, idx) => idx !== i)) }

  const yieldPct = expectedYieldQty && actualYieldQty && +expectedYieldQty > 0 ? (+actualYieldQty / +expectedYieldQty) * 100 : null
  const missing = prep?.inputs.filter((i) => i.missing) ?? []

  return (
    <div className="min-h-screen" style={{ background: 'var(--bg)' }}>
      <header className="px-7 py-6 border-b border-white/[0.05]">
        <div className="flex gap-4 text-xs">
          {canOpen('/inventory') && <Link href="/inventory" className="text-white/40 hover:text-white/70">← Inventory</Link>}
          {canOpen('/par-sheet') && <Link href="/par-sheet" className="text-white/40 hover:text-white/70">Par sheet</Link>}
        </div>
        <h1 className="text-2xl font-black text-white/90 mt-2">🥣 Prep batch log</h1>
        <p className="text-sm text-white/40 mt-1 max-w-2xl">
          Record what you drew from inventory + what you made. This is the only place prep is recorded: it deducts the
          ingredients and shows on the par sheet. Low-yield batches (under 85%) auto-flag to the owner inbox.
        </p>
      </header>

      <div className="px-7 py-6 max-w-3xl mx-auto space-y-5">
        {feedback && (
          <div className="rounded-xl px-4 py-3 text-sm font-bold"
            style={{
              background: feedback.startsWith('⚠') ? 'rgba(245,158,11,0.1)' : 'rgb(var(--erp-primary-rgb) / 0.1)',
              color: feedback.startsWith('⚠') ? '#a15c00' : 'var(--erp-primary-ink)',
              border: `1px solid ${feedback.startsWith('⚠') ? 'rgba(245,158,11,0.3)' : 'rgb(var(--erp-primary-rgb) / 0.3)'}`,
            }}>{feedback}</div>
        )}

        <Section title="What did you make?">
          <div className="grid grid-cols-[1fr_120px] gap-3">
            <Field label="Sub-recipe *">
              <select value={recipeId} className={fieldCls}
                onChange={(e) => {
                  const id = e.target.value
                  setRecipeId(id)
                  if (id === AD_HOC || !id) { setItemName(''); setInputs([]); setExpectedYieldQty('') }
                  else applyRecipe(preps.find((p) => p.id === id), multiplier)
                }}>
                <option value="">— pick from the recipe library —</option>
                {preps.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                <option value={AD_HOC}>Other (not in the recipe library)</option>
              </select>
            </Field>
            {!adHoc && (
              <Field label="Batches">
                <input type="number" min={0.25} step={0.25} value={multiplier} className={fieldCls}
                  onChange={(e) => {
                    const m = parseFloat(e.target.value) || 1
                    setMultiplier(m)
                    applyRecipe(prep, m)
                  }} />
              </Field>
            )}
          </div>
          {adHoc && (
            <div className="mt-3">
              <Field label="Prep name *">
                <input value={itemName} onChange={(e) => setItemName(e.target.value)} placeholder="Staff meal base" className={fieldCls} />
              </Field>
            </div>
          )}
          {missing.length > 0 && (
            <p className="mt-2 text-xs text-amber-700">
              Not in your company&rsquo;s inventory, so not deducted: {missing.map((m) => m.name).join(', ')}.
            </p>
          )}
          {prep && prep.subPreps.length > 0 && (
            <p className="mt-2 text-xs text-white/45">
              Also uses prepared: {prep.subPreps.map((s) => `${s.name ?? '—'} (${Math.round(s.grams * multiplier)} g)`).join(', ')}.
            </p>
          )}
          <div className="grid grid-cols-2 gap-3 mt-3">
            <Field label="Expected yield (g)">
              <input type="number" step="0.1" value={expectedYieldQty} onChange={(e) => setExpectedYieldQty(e.target.value === '' ? '' : parseFloat(e.target.value))} placeholder="e.g. 500" className={fieldCls} />
            </Field>
            <Field label="Actual yield (g) *">
              <input type="number" step="0.1" value={actualYieldQty} onChange={(e) => setActualYieldQty(e.target.value === '' ? '' : parseFloat(e.target.value))} placeholder="What you got" className={fieldCls} />
            </Field>
          </div>
          {yieldPct != null && (
            <div className="mt-3 rounded-lg p-3 text-sm font-bold"
              style={{
                background: yieldPct < 85 ? 'rgba(245,158,11,0.08)' : 'rgb(var(--erp-primary-rgb) / 0.08)',
                color: yieldPct < 85 ? '#a15c00' : 'var(--erp-primary-ink)',
                border: `1px solid ${yieldPct < 85 ? 'rgba(245,158,11,0.3)' : 'rgb(var(--erp-primary-rgb) / 0.3)'}`,
              }}>
              Yield: {yieldPct.toFixed(1)}% {yieldPct < 85 && '— will flag (under 85%)'}
            </div>
          )}
        </Section>

        <Section title="What did you use?">
          {inputs.length === 0 && <p className="text-xs text-white/35 italic">No ingredients yet. Add at least one.</p>}
          {inputs.map((inp, i) => (
            <div key={i} className="grid grid-cols-[1fr_100px_60px_auto] gap-2 items-center mt-2">
              <select value={inp.inventoryItemId}
                onChange={(e) => patchInput(i, { inventoryItemId: e.target.value, unit: itemById.get(e.target.value)?.unit ?? '' })}
                className={fieldCls}>
                <option value="">— ingredient —</option>
                {ingredients.map((it) => <option key={it.id} value={it.id}>{it.label}</option>)}
              </select>
              <input type="number" step="0.001" value={inp.qtyDrawn} onChange={(e) => patchInput(i, { qtyDrawn: parseFloat(e.target.value) || 0 })} placeholder="Qty" className={fieldCls} />
              {/* The draw is taken off stock as-is, so it is always in the item's own stock unit. */}
              <span className="text-xs text-white/55">{itemById.get(inp.inventoryItemId)?.unit ?? inp.unit}</span>
              <button onClick={() => rmInput(i)} className="text-white/30 hover:text-red-700 px-2">✕</button>
            </div>
          ))}
          <button onClick={addInput} className="text-xs text-primary-ink hover:underline mt-3">+ Add ingredient</button>
        </Section>

        <Section title="Evidence (optional)">
          <Field label="Photo URL"><input value={photoUrl} onChange={(e) => setPhotoUrl(e.target.value)} placeholder="https://… of finished prep" className={fieldCls} /></Field>
          <Field label="Notes"><textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} className={fieldCls} /></Field>
        </Section>

        {submit.error && <div className="rounded-xl px-4 py-3 text-sm text-red-700" style={{ background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.3)' }}>Save failed: {(submit.error as Error).message}</div>}

        <div className="flex justify-end pt-2">
          <button onClick={() => submit.mutate()}
            disabled={submit.isPending || !recipeId || !itemName.trim() || inputs.length === 0 || inputs.some((x) => !x.inventoryItemId) || !actualYieldQty}
            className="rounded-xl bg-primary px-6 py-3 text-sm font-black text-primary-on hover:opacity-90 disabled:opacity-50">
            {submit.isPending ? 'Saving…' : 'Log batch →'}
          </button>
        </div>

        {batches.length > 0 && (
          <div className="pt-6 mt-6 border-t border-white/[0.05]">
            <h2 className="text-xs font-black uppercase tracking-[0.24em] text-white/55 mb-3">Recent batches</h2>
            <div className="space-y-2">
              {batches.slice(0, 10).map((b) => (
                <div key={b.id} className="rounded-lg p-3 flex items-center justify-between"
                  style={{ background: 'rgb(var(--fg-rgb) / 0.025)', border: '1px solid rgb(var(--fg-rgb) / 0.06)' }}>
                  <div>
                    <p className="text-sm font-bold text-white/85">{b.itemName}</p>
                    <p className="text-xs text-white/45">{b.actualYieldQty} {b.unit} yielded · {new Date(b.createdAt).toLocaleString()}</p>
                  </div>
                  {b.yieldVariancePct != null && (
                    <span className="text-xs font-bold" style={{ color: b.yieldVariancePct < 0.85 ? '#a15c00' : 'var(--erp-primary-ink)' }}>
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
  return <div className="rounded-2xl p-5" style={{ background: 'rgb(var(--fg-rgb) / 0.025)', border: '1px solid rgb(var(--fg-rgb) / 0.06)' }}>
    <h2 className="text-sm font-black uppercase tracking-[0.18em] text-white/65">{title}</h2>
    <div className="mt-3">{children}</div>
  </div>
}
function Field({ label, children }: { label: string; children: React.ReactNode }) { return <div><label className="text-xs text-white/55">{label}</label><div className="mt-1">{children}</div></div> }
const fieldCls = "w-full rounded-lg bg-white/[0.03] border border-white/[0.08] px-3 py-2 text-sm text-white/85 focus:border-primary focus:outline-none"
