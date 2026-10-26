'use client'
// Prep batch logging — chef records what they used + what they made.
// Yield variance < 85% fires an ExceptionFlag (skim signal).
//
// This is the ONE place prep is recorded (owner decision 29): the batch
// deducts its ingredients, records the yield and feeds "made today" on the par
// sheet. A library sub-recipe's batch also puts the prep into stock (prep as
// stock, owner 2026-10-24): one lot at the actual yield, at what was drawn. Pick the sub-recipe from the recipe library (the par sheet's list for
// your company); its ingredients and expected yield are filled in for you, in
// each ingredient's own stock unit, so a 200 g draw from a kg item deducts
// 0.2 kg — not 200 kg.

import { ArrowLeft, X } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import Link from 'next/link'
import { api, ApiError } from '../../../lib/api'
import { canOpenPath } from '../../../lib/moduleCatalog'
import { usePermissions } from '../../../hooks/useCan'
import { fmtPkrWhole } from '../../../lib/money'
import { stockErrorText } from '../../../lib/stockUi'
import { Select } from '@/components/ui/Select'
import { FormField } from '../../../components/ui/FormField'
import { NumberField } from '../../../components/ui/NumberField'
import { PendingFilesPicker } from '@/components/files/PendingFilesPicker'
import { RecordFiles } from '@/components/files/RecordFiles'
import { uploadRecordFiles, type PickedFile } from '@/components/files/recordFiles'
import { useAuthStore } from '../../../store/auth'
import { useManagerRoles } from '../../../lib/roles'

interface InventoryItem { id: string; name: string; unit: string; currentStock: number }
interface DraftInput { inventoryItemId: string; qtyDrawn: number; unit: string }
interface PrepBatch { id: string; itemName: string; actualYieldQty: number; expectedYieldQty: number | null; yieldVariancePct: number | null; createdAt: string; staffId: string; unit: string; recipeId?: string | null; drawValueCents?: number | null; locationId?: string | null; photoUrl?: string | null }
interface OutletLite { id: string; name: string; isActive?: boolean }
interface BatchResult { id: string; uploadError?: string | null; ledger?: { posted: boolean; reason?: string; error?: string } | null }
interface PrepOption {
  id: string; name: string; yieldGrams: number | null
  /** The unit the yield is counted in (g / ml / pcs) — the prep stock item's unit. */
  yieldUnit?: string
  /** Portions one batch makes (K5); set = the cook logs in portions. */
  portionsPerBatch?: number | null
  portionLabel?: string | null
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
  // A prep's photos are added by the cook who logged it or a manager (the server's rule).
  const authUser = useAuthStore((st) => st.user)
  const managers = useManagerRoles()
  const canAddPhotos = (staffId: string) => !!authUser && (authUser.id === staffId || managers.has(authUser.role))
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
  // The outlet the batch was made at (one of the active company's). Stock is
  // still one pool per company; the outlet is tagged now for per-outlet stock later.
  const { data: outlets = [] } = useQuery<OutletLite[]>({
    queryKey: ['locations'], queryFn: () => api.get('/locations'),
    retry: false, meta: { background: true }, staleTime: 300_000,
  })
  const activeOutlets = outlets.filter((o) => o.isActive !== false)
  const { data: preps = [] } = useQuery<PrepOption[]>({ queryKey: ['par-sheet', 'preps'], queryFn: () => api.get('/par-sheet/preps') })
  const { data: batches = [] } = useQuery<PrepBatch[]>({ queryKey: ['prep-batches'], queryFn: () => api.get('/crosschecks/prep-batches'), refetchInterval: 30_000 })

  const [recipeId, setRecipeId] = useState('')
  const [multiplier, setMultiplier] = useState(1)
  const [itemName, setItemName] = useState('')
  const [inputs, setInputs] = useState<DraftInput[]>([])
  const [expectedYieldQty, setExpectedYieldQty] = useState<number | ''>('')
  const [actualYieldQty, setActualYieldQty] = useState<number | ''>('')
  const [photos, setPhotos] = useState<PickedFile[]>([])
  const [notes, setNotes] = useState('')
  const [locationId, setLocationId] = useState('')
  const [feedback, setFeedback] = useState<{ tone: 'ok' | 'warn' | 'bad'; text: string } | null>(null)
  const [tried, setTried] = useState(false)

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
  // A recipe with portions per batch is logged in PORTIONS plus the whole batches cooked (server: 400 BATCHES_REQUIRED without).
  const inPortions = !adHoc && !!prep?.portionsPerBatch && prep.portionsPerBatch > 0
  const portionWord = prep?.portionLabel || 'portions'
  const [actualPortions, setActualPortions] = useState<number | ''>('')
  const [portionBatches, setPortionBatches] = useState<number | ''>('')

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
    mutationFn: async () => {
      const res = await api.post<BatchResult>('/crosschecks/prep-batches', {
      recipeId: adHoc || !recipeId ? null : recipeId,
      locationId: locationId || null,
      itemName, inputs,
      // A recipe batch (prep as stock, 2026-10-24) draws its recipe × batches and adds the prep item at the actual yield.
      ...(inPortions
        ? { batches: Number(portionBatches), actualPortions: Number(actualPortions) }
        : {
          ...(!adHoc && recipeId ? { batches: multiplier } : {}),
          expectedYieldQty: expectedYieldQty === '' ? null : expectedYieldQty,
          actualYieldQty: actualYieldQty === '' ? 0 : actualYieldQty,
          unit: !adHoc && prep?.yieldUnit ? prep.yieldUnit : 'g',
        }),
      notes: notes || null,
      })
      // The batch is saved; a failed upload never undoes it.
      let uploadError: string | null = null
      if (photos.length > 0) {
        try { await uploadRecordFiles('prep_batch', res.id, photos) }
        catch (e) { uploadError = (e as Error).message || 'the upload failed' }
      }
      return { ...res, uploadError }
    },
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ['prep-batches'] })
      qc.invalidateQueries({ queryKey: ['inventory'] })
      qc.invalidateQueries({ queryKey: ['par-sheet'] })
      qc.invalidateQueries({ queryKey: ['exceptions'] })
      const yieldPct = expectedYieldQty && actualYieldQty ? +actualYieldQty / +expectedYieldQty : null
      const ledger = res?.ledger
      setFeedback(res?.uploadError
        ? { tone: 'bad', text: `Batch saved; photo failed: ${res.uploadError}` }
        : ledger && !ledger.posted
        ? { tone: 'bad', text: `Batch saved and stock drawn, but its books entry did not post: ${ledger.reason ?? ledger.error ?? 'the ledger refused it'}. Finance can re-post it from Reconciliation → Backfill unposted.` }
        : yieldPct != null && yieldPct < 0.85
          ? { tone: 'warn', text: 'Batch saved — low yield flagged.' }
          : { tone: 'ok', text: adHoc ? 'Batch logged. The ingredients were drawn from stock at the price paid.' : 'Batch logged. Its ingredients left stock and the prep is now in stock at what they cost.' })
      setRecipeId(''); setMultiplier(1); setTried(false)
      setItemName(''); setInputs([]); setExpectedYieldQty(''); setActualYieldQty(''); setActualPortions(''); setPortionBatches(''); setPhotos([]); setNotes('')
      if ((!ledger || ledger.posted) && !res?.uploadError) setTimeout(() => setFeedback(null), 6000)
    },
  })

  function addInput() {
    const first = ingredients[0]
    setInputs([...inputs, { inventoryItemId: first?.id ?? '', qtyDrawn: 0, unit: first?.unit ?? '' }])
  }
  function patchInput(i: number, p: Partial<DraftInput>) { setInputs(inputs.map((x, idx) => idx === i ? { ...x, ...p } : x)) }
  function rmInput(i: number) { setInputs(inputs.filter((_, idx) => idx !== i)) }

  const yieldPct = !inPortions && expectedYieldQty && actualYieldQty && +expectedYieldQty > 0 ? (+actualYieldQty / +expectedYieldQty) * 100 : null
  const missing = prep?.inputs.filter((i) => i.missing) ?? []
  // Why Log batch can't go through yet — shown once it is pressed (the button stays live).
  const problem = !recipeId ? 'Pick the sub-recipe you made (or Other).'
    : !itemName.trim() ? 'Name the prep.'
    : inputs.length === 0 ? 'Add at least one ingredient you used.'
    : inputs.some((x) => !x.inventoryItemId) ? 'Pick the ingredient on every line.'
    : inPortions && !(Number(portionBatches) > 0) ? 'Say how many whole batches you made.'
    : inPortions && !(Number(actualPortions) > 0) ? `Enter how many ${portionWord} came out.`
    : !inPortions && !actualYieldQty ? 'Enter the actual yield.'
    : null

  return (
    <div className="min-h-screen" style={{ background: 'var(--bg)' }}>
      <header className="px-7 py-6 border-b border-white/[0.05]">
        <div className="flex gap-4 text-xs">
          {canOpen('/inventory') && <Link href="/inventory" className="inline-flex min-h-11 items-center gap-1.5 text-white/40 hover:text-white/70"><ArrowLeft size={14} aria-hidden="true" />Inventory</Link>}
          {canOpen('/par-sheet') && <Link href="/par-sheet" className="text-white/40 hover:text-white/70">Par sheet</Link>}
        </div>
        <h1 className="text-2xl font-black text-white/90 mt-2">Prep batch log</h1>
        <p className="text-sm text-white/40 mt-1 max-w-2xl">
          Record what you drew from inventory + what you made. This is the only place prep is recorded: it deducts the
          ingredients and shows on the par sheet. Low-yield batches (under 85%) auto-flag to the owner inbox.
        </p>
      </header>

      <form noValidate className="px-7 py-6 max-w-3xl mx-auto space-y-5"
        onSubmit={(e) => { e.preventDefault(); setTried(true); if (!problem && !submit.isPending) submit.mutate() }}>
        {feedback && (
          <div role="status" className="rounded-xl px-4 py-3 text-sm font-bold"
            style={feedback.tone === 'ok'
              ? { background: 'rgb(var(--erp-accent-rgb) / 0.14)', color: 'var(--erp-success)', border: '1px solid rgb(var(--erp-accent-rgb) / 0.45)' }
              : feedback.tone === 'warn'
                ? { background: 'color-mix(in srgb, var(--erp-warning) 10%, transparent)', color: 'var(--erp-warning)', border: '1px solid color-mix(in srgb, var(--erp-warning) 35%, transparent)' }
                : { background: 'color-mix(in srgb, var(--erp-danger) 8%, transparent)', color: 'var(--erp-danger)', border: '1px solid color-mix(in srgb, var(--erp-danger) 35%, transparent)' }}>
            {feedback.text}
          </div>
        )}

        <Section title="What did you make?">
          <div className="grid grid-cols-1 sm:grid-cols-[1fr_120px] gap-3">
            <Field label="Sub-recipe" required error={tried && !recipeId ? 'Pick the sub-recipe you made (or Other).' : null}>
              <Select value={recipeId} className={fieldCls}
                onChange={(e) => {
                  const id = e.target.value
                  setRecipeId(id)
                  if (id === AD_HOC || !id) { setItemName(''); setInputs([]); setExpectedYieldQty('') }
                  else applyRecipe(preps.find((p) => p.id === id), multiplier)
                }}>
                <option value="">— pick from the recipe library —</option>
                {preps.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                <option value={AD_HOC}>Other (not in the recipe library)</option>
              </Select>
            </Field>
            {!adHoc && !inPortions && (
              <Field label="Batches">
                <NumberField decimals={2} min={0.25} value={multiplier} className={fieldCls}
                  onValueChange={(v) => {
                    const m = v && v > 0 ? v : 1
                    setMultiplier(m)
                    applyRecipe(prep, m)
                  }} />
              </Field>
            )}
          </div>
          {adHoc && (
            <div className="mt-3 space-y-2">
              <Field label="Prep name" required error={tried && !itemName.trim() ? 'Name the prep.' : null}>
                <input required enterKeyHint="next" value={itemName} onChange={(e) => setItemName(e.target.value)} placeholder="Staff meal base" className={fieldCls} />
              </Field>
              <p className="text-xs text-s-muted">
                A batch that is not in the recipe library draws its ingredients from stock at the price paid (oldest stock first), and books that cost to cost of sales.
                A batch of a library sub-recipe takes its recipe's ingredients off stock and puts the prep itself into stock at the yield you weigh — dishes then draw the prep, never its ingredients again.
              </p>
            </div>
          )}
          {activeOutlets.length > 0 && (
            <div className="mt-3">
              <Field label="Outlet (optional)">
                <Select value={locationId} onChange={(e) => setLocationId(e.target.value)} className={fieldCls}>
                  <option value="">No particular outlet</option>
                  {activeOutlets.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
                </Select>
              </Field>
            </div>
          )}
          {missing.length > 0 && (
            <p className="mt-2 text-xs text-s-amber">
              Not in your company&rsquo;s inventory, so not deducted: {missing.map((m) => m.name).join(', ')}.
            </p>
          )}
          {prep && prep.subPreps.length > 0 && (
            <p className="mt-2 text-xs text-white/45">
              Also uses prepared: {prep.subPreps.map((s) => `${s.name ?? '—'} (${Math.round(s.grams * multiplier)} g)`).join(', ')}.
            </p>
          )}
          {inPortions ? (
            <div className="grid grid-cols-2 gap-3 mt-3">
              <Field label="Batches cooked" required error={tried && !(Number(portionBatches) > 0) ? 'Say how many whole batches you made.' : null}>
                <NumberField decimals={2} min={0} enterKeyHint="next" value={portionBatches === '' ? null : portionBatches}
                  onValueChange={(v) => { setPortionBatches(v ?? ''); if (v && v > 0) applyRecipe(prep, v) }} placeholder="e.g. 2" className={fieldCls} />
              </Field>
              <Field label={`Actual ${portionWord} made`} required error={tried && !(Number(actualPortions) > 0) ? `Enter how many ${portionWord} came out.` : null}>
                <NumberField decimals={1} min={0} enterKeyHint="next" value={actualPortions === '' ? null : actualPortions}
                  onValueChange={(v) => setActualPortions(v ?? '')} placeholder="What came out" className={fieldCls} />
              </Field>
              <p className="col-span-2 text-xs text-s-muted">
                One batch makes {prep?.portionsPerBatch} {portionWord}. The ingredients drawn are the recipe × the whole batches cooked; the {portionWord} are what came out, so a short batch shows as low yield.
              </p>
            </div>
          ) : (
          <div className="grid grid-cols-2 gap-3 mt-3">
            <Field label="Expected yield (g)">
              <NumberField decimals={1} min={0} enterKeyHint="next" value={expectedYieldQty === '' ? null : expectedYieldQty} onValueChange={(v) => setExpectedYieldQty(v ?? '')} placeholder="e.g. 500" className={fieldCls} />
            </Field>
            <Field label="Actual yield (g)" required error={tried && !actualYieldQty ? 'Enter the actual yield.' : null}>
              <NumberField decimals={1} min={0} enterKeyHint="next" value={actualYieldQty === '' ? null : actualYieldQty} onValueChange={(v) => setActualYieldQty(v ?? '')} placeholder="What you got" className={fieldCls} />
            </Field>
          </div>
          )}
          {yieldPct != null && (
            <div className="mt-3 rounded-lg p-3 text-sm font-bold"
              style={{
                background: yieldPct < 85 ? 'rgba(245,158,11,0.08)' : 'rgb(var(--erp-accent-rgb) / 0.12)',
                color: yieldPct < 85 ? 'var(--erp-warning)' : 'var(--erp-success)',
                border: `1px solid ${yieldPct < 85 ? 'rgba(245,158,11,0.3)' : 'rgb(var(--erp-accent-rgb) / 0.45)'}`,
              }}>
              Yield: {yieldPct.toFixed(1)}% {yieldPct < 85 && '— will flag (under 85%)'}
            </div>
          )}
        </Section>

        <Section title="What did you use?">
          {inputs.length === 0 && <p className="text-xs text-white/35 italic">No ingredients yet. Add at least one.</p>}
          {inputs.map((inp, i) => (
            <div key={i} className="grid grid-cols-[minmax(0,1fr)_84px_44px_auto] gap-2 items-center mt-2">
              <Select value={inp.inventoryItemId}
                onChange={(e) => patchInput(i, { inventoryItemId: e.target.value, unit: itemById.get(e.target.value)?.unit ?? '' })}
                aria-label={`Ingredient ${i + 1}`} className={fieldCls}>
                <option value="">— ingredient —</option>
                {ingredients.map((it) => <option key={it.id} value={it.id}>{it.label}</option>)}
              </Select>
              <NumberField decimals={3} min={0} enterKeyHint="next" value={inp.qtyDrawn || null} onValueChange={(v) => patchInput(i, { qtyDrawn: v ?? 0 })}
                aria-label={`Ingredient ${i + 1} quantity`} placeholder="Qty" className={fieldCls} />
              {/* The draw is taken off stock as-is, so it is always in the item's own stock unit. */}
              <span className="text-xs text-white/55">{itemById.get(inp.inventoryItemId)?.unit ?? inp.unit}</span>
              <button type="button" onClick={() => rmInput(i)} aria-label={`Remove ingredient ${i + 1}`} className="text-white/30 hover:text-s-red px-2 [@media(pointer:coarse)]:min-h-11 [@media(pointer:coarse)]:min-w-11"><X size={16} aria-hidden="true" /></button>
            </div>
          ))}
          <button type="button" onClick={addInput} className="text-xs text-primary-ink hover:underline mt-3">+ Add ingredient</button>
        </Section>

        <Section title="Evidence (optional)">
          <PendingFilesPicker ownerType="prep_batch" label="Photo of the finished prep" value={photos} onChange={setPhotos} />
          <Field label="Notes"><textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} className={fieldCls} /></Field>
        </Section>

        {submit.error && <div role="alert" className="rounded-xl px-4 py-3 text-sm text-s-red" style={{ background: 'color-mix(in srgb, var(--erp-danger) 8%, transparent)', border: '1px solid color-mix(in srgb, var(--erp-danger) 35%, transparent)' }}>Not saved. {stockErrorText(submit.error)}</div>}

        <div className="flex justify-end pt-2">
          {tried && problem && <p role="alert" className="mr-4 self-center text-xs font-bold" style={{ color: 'var(--erp-warning)' }}>{problem}</p>}
          <button type="submit" disabled={submit.isPending}
            className="rounded-xl bg-primary px-6 py-3 text-sm font-black text-primary-on hover:opacity-90 disabled:opacity-50">
            {submit.isPending ? 'Saving…' : 'Log batch'}
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
                    <p className="text-xs text-white/45">
                      {b.actualYieldQty} {b.unit} yielded · {new Date(b.createdAt).toLocaleString()}
                      {b.drawValueCents != null && b.drawValueCents > 0 && ` · drew ${fmtPkrWhole(b.drawValueCents)} of stock`}
                    </p>
                    {b.photoUrl && /^https?:\/\//i.test(b.photoUrl) && <a href={b.photoUrl} target="_blank" rel="noopener noreferrer" className="text-xs font-bold" style={{ color: 'var(--erp-primary)' }}>Photo ↗</a>}
                    <RecordFiles ownerType="prep_batch" ownerId={b.id} canUpload={canAddPhotos(b.staffId)} compact lazy />
                  </div>
                  {b.yieldVariancePct != null && (
                    <span className="text-xs font-bold" style={{ color: b.yieldVariancePct < 0.85 ? 'var(--erp-warning)' : 'var(--erp-success)' }}>
                      {(b.yieldVariancePct * 100).toFixed(0)}% yield
                    </span>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}
      </form>
    </div>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return <div className="rounded-2xl p-5" style={{ background: 'rgb(var(--fg-rgb) / 0.025)', border: '1px solid rgb(var(--fg-rgb) / 0.06)' }}>
    <h2 className="text-sm font-black uppercase tracking-[0.18em] text-white/65">{title}</h2>
    <div className="mt-3">{children}</div>
  </div>
}
function Field({ label, required, error, children }: { label: string; required?: boolean; error?: string | null; children: React.ReactElement }) {
  return <FormField label={label} required={required} error={error ?? undefined}>{children}</FormField>
}
const fieldCls = "w-full rounded-lg bg-white/[0.03] border border-white/[0.08] px-3 py-2 text-sm text-white/85 focus:border-primary focus:outline-none"
