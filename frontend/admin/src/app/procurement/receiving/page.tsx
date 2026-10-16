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
//
// R2-UI-02: the buyer (role procurement) can open this page — the reads admit
// PROCUREMENT_TEAM — but taking the delivery in (POST /crosschecks/receiving)
// is MANAGERS only. Non-managers see it read-only: what is due at the dock and
// what has come in, with the note "A manager takes the delivery in".

import { useEffect, useMemo, useRef, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import Link from 'next/link'
import { api } from '../../../lib/api'
import { useAuthStore } from '../../../store/auth'
import { useManagerRoles } from '../../../lib/roles'
import { stockErrorText } from '../../../lib/stockUi'
import { Select } from '@/components/ui/Select'
import { FormField } from '../../../components/ui/FormField'
import { NumberField } from '../../../components/ui/NumberField'
import { MoneyInput } from '../../../components/ui/MoneyInput'
import { PendingFilesPicker } from '@/components/files/PendingFilesPicker'
import { asUploadBody, type PickedFile } from '@/components/files/recordFiles'

// The API's MANAGERS take a delivery in (owner decision 27) — the list comes
// from the server (lib/roles.ts useManagerRoles).

// Whoever raised a PO can't receive it; the CEO (role admin) is exempt — the
// server's assertNotSelfApproval rule (lib/separation-of-duties.ts), which
// also raises a high-severity exception flag on every blocked attempt, so the
// page must not offer it. A PO with no creator on file predates tracking.
const raisedByMe = (po: { createdBy?: string | null }, me: { id: string; role: string } | null) =>
  !!me && me.role !== 'admin' && !!po.createdBy && po.createdBy === me.id

interface Supplier { id: string; name: string }
interface OutletLite { id: string; name: string; isActive?: boolean }
interface OpenPoLine {
  id: string; inventoryItemId: string; quantityOrdered: number; quantityReceived: number; unitCostCents: number
  inventoryItem: { id: string; name: string; unit: string }
}
interface OpenPo {
  id: string; reference: string | null; supplierId: string; status: string; createdAt: string
  createdBy?: string | null
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
// Draft lines keep numbers as typed text ('' = empty); the fields want number | null.
const numOf = (t: string): number | null => (t.trim() === '' || !Number.isFinite(Number(t)) ? null : Number(t))
const textOf = (n: number | null): string => (n == null ? '' : String(n))
// Unit cost is typed in rupees; MoneyInput works in cents, the API still gets cents.
const centsOf = (pkr: string): number => Math.round((numOf(pkr) ?? 0) * 100)
const pkrOf = (cents: number): string => (cents > 0 ? String(cents / 100) : '')

export default function ReceivingPage() {
  const qc = useQueryClient()
  const me = useAuthStore((s) => s.user)
  const canReceive = useManagerRoles().has(me?.role ?? '')
  const { data: pos = [], error: posError } = useQuery<OpenPo[]>({ queryKey: ['receiving', 'open-pos'], queryFn: () => api.get('/crosschecks/receiving/open-pos') })
  const { data: suppliers = [] } = useQuery<Supplier[]>({ queryKey: ['receiving', 'suppliers'], queryFn: () => api.get('/crosschecks/receiving/suppliers') })
  // Only the receiving form needs the item list (deliveries without a PO).
  const { data: items = [] } = useQuery<InventoryItem[]>({ queryKey: ['inventory'], queryFn: () => api.get('/inventory'), enabled: canReceive })
  const { data: receipts = [], error: receiptsError } = useQuery<Receipt[]>({ queryKey: ['receipts'], queryFn: () => api.get('/crosschecks/receiving'), refetchInterval: 30_000 })

  // The outlet the delivery arrived at (one of the supplier's company's — the
  // API refuses another company's with LOCATION_NOT_IN_COMPANY).
  const { data: outlets = [] } = useQuery<OutletLite[]>({
    queryKey: ['locations'], queryFn: () => api.get('/locations'),
    enabled: canReceive, retry: false, meta: { background: true }, staleTime: 300_000,
  })
  const activeOutlets = outlets.filter((o) => o.isActive !== false)
  const [locationId, setLocationId] = useState('')
  const [supplierId, setSupplierId] = useState('')
  const [poId, setPoId] = useState<string | null>(null)
  const [photos, setPhotos] = useState<PickedFile[]>([])
  const [notes, setNotes] = useState('')
  const [lines, setLines] = useState<DraftLine[]>([])
  const [feedback, setFeedback] = useState<{ tone: 'ok' | 'warn'; text: string } | null>(null)
  const [wantedPo, setWantedPo] = useState<string | null>(null)
  const [tried, setTried] = useState(false)
  const stepTwoRef = useRef<HTMLDivElement>(null)

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
    if (!wantedPo || poId || !canReceive) return
    const po = pos.find((p) => p.id === wantedPo)
    // Your own PO stays unselected (and wantedPo stays set, for the note).
    if (po && !raisedByMe(po, me)) { loadFromPo(po); setWantedPo(null) }
  }, [wantedPo, pos, poId, canReceive, me])

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
  // Why Accept can't go through yet — shown once it is pressed (the button stays live).
  const problem = lines.length === 0 ? (poId ? 'Nothing is outstanding on this PO.' : 'Pick a PO or a supplier and add the lines that arrived.')
    : (!supplierId && !poId) ? 'Choose the supplier this delivery came from.'
    : adHocInvalid ? 'Pick an inventory item and enter the unit cost paid on every line.'
    : nothingArrived ? 'Enter the quantity received on at least one line (0 for what did not come).'
    : null

  // Enter / the phone's Next key moves down the received-quantity boxes.
  useEffect(() => {
    stepTwoRef.current?.querySelectorAll('input').forEach((i) => { i.enterKeyHint = 'next' })
  })
  function onStepTwoKey(e: React.KeyboardEvent<HTMLDivElement>) {
    if (e.key !== 'Enter' || e.shiftKey || e.nativeEvent.isComposing) return
    if (!(e.target instanceof HTMLInputElement)) return
    e.preventDefault()
    const all = Array.from(e.currentTarget.querySelectorAll<HTMLInputElement>('input:not([disabled])'))
    const next = all[all.indexOf(e.target) + 1]
    if (next) next.focus()
    else document.getElementById('recv-photo')?.querySelector('button')?.focus()
  }
  // Every PO line to what is still due (nothing is saved until Accept delivery).
  const fillAllAsOrdered = () => setLines((prev) => prev.map((l) => (l.outstanding != null ? { ...l, receivedQty: String(l.outstanding) } : l)))

  const submit = useMutation({
    mutationFn: () => api.post<{ varianceFlag?: boolean; poStatus?: string | null }>('/crosschecks/receiving', {
      poId,
      supplierId: poId ? null : supplierId,
      locationId: locationId || null,
      photos: asUploadBody(photos),
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
      setLines([]); setPoId(null); setPhotos([]); setNotes(''); setSupplierId('')
      setFeedback(r.varianceFlag
        ? { tone: 'warn', text: 'Receipt saved. A variance over 5% was flagged in Exceptions.' }
        : { tone: 'ok', text: r.poStatus === 'partial'
          ? 'Receipt saved. The PO stays open for the rest — the goods are booked to Goods received not invoiced until the bill arrives.'
          : 'Receipt saved, stock updated at the price paid. The goods are booked to Goods received not invoiced until the bill arrives.' })
      setTimeout(() => setFeedback(null), 6000)
    },
  })

  const selectedPo = pos.find((p) => p.id === poId) ?? null
  // The PO the Procurement "Receive" link pointed at, when it is one the
  // signed-in manager raised themselves.
  const ownWantedPo = canReceive && !poId && wantedPo
    ? pos.find((p) => p.id === wantedPo && raisedByMe(p, me)) ?? null
    : null

  return (
    <div className="min-h-screen" style={{ background: 'var(--bg)' }}>
      <header className="px-7 py-6 border-b border-white/[0.05]">
        <Link href="/procurement" className="text-xs text-white/40 hover:text-white/70">← Procurement</Link>
        <h1 className="text-2xl font-black text-white/90 mt-2">Receiving (dock door)</h1>
        <p className="text-sm text-white/40 mt-1 max-w-2xl">
          Mark what physically arrived. Stock, the PO and the ingredient cost update together; short shipments and
          variances over 5% go to the Exceptions inbox. Whoever raised a PO can&apos;t receive it.
        </p>
        <p className="text-xs text-white/55 mt-2 max-w-2xl">
          Goods are booked to <span className="font-semibold">Goods received not invoiced</span> until the bill arrives, then the bill clears
          them. Track what is still unbilled on{' '}
          <Link href="/procurement/grni" className="text-primary-ink hover:underline">Received, not billed</Link>.
        </p>
      </header>

      <div className="px-7 py-6 max-w-4xl mx-auto space-y-5">
        {feedback && (
          <div role="status" className="rounded-xl px-4 py-3 text-sm font-bold"
            style={{
              background: feedback.tone === 'warn' ? 'rgba(245,158,11,0.1)' : 'rgb(var(--erp-accent-rgb) / 0.14)',
              color: feedback.tone === 'warn' ? 'var(--erp-warning)' : 'var(--erp-success)',
              border: `1px solid ${feedback.tone === 'warn' ? 'rgba(245,158,11,0.3)' : 'rgb(var(--erp-accent-rgb) / 0.45)'}`,
            }}>
            {feedback.text}
          </div>
        )}

        {posError && <ErrorBanner label="Couldn't load the purchase orders due at the dock:" error={posError} />}
        {receiptsError && <ErrorBanner label="Couldn't load recent deliveries:" error={receiptsError} />}

        {!canReceive && (
          <>
            <div role="status" className="rounded-xl px-4 py-3 text-sm font-bold"
              style={{ background: 'rgb(var(--fg-rgb) / 0.04)', border: '1px solid rgb(var(--fg-rgb) / 0.12)', color: 'rgb(var(--fg-rgb) / 0.85)' }}>
              A manager takes the delivery in.
              <span className="block text-xs font-normal text-white/55 mt-1">
                You can see what is due at the dock and what has arrived. Whoever orders the goods does not also sign for them.
              </span>
            </div>
            <Section title="Due at the dock">
              {pos.length === 0 && !posError && <p className="text-xs text-white/35 italic">No purchase orders waiting to be received.</p>}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                {pos.map((po) => {
                  const outstanding = po.lines.filter((l) => l.quantityOrdered - l.quantityReceived > 0)
                  return (
                    <div key={po.id} className="rounded-lg p-3"
                      style={{
                        background: 'rgb(var(--fg-rgb) / 0.025)',
                        border: `1px solid ${po.id === wantedPo ? 'var(--erp-accent)' : 'rgb(var(--fg-rgb) / 0.06)'}`,
                      }}>
                      <p className="text-sm font-bold text-white/90">{poLabel(po)}</p>
                      <p className="text-xs text-white/45">{po.supplier.name}{po.status === 'partial' ? ' · part-received' : ''}</p>
                      <ul className="mt-2 space-y-0.5">
                        {outstanding.map((l) => (
                          <li key={l.id} className="text-xs text-white/65 flex justify-between gap-2">
                            <span>{l.inventoryItem.name}</span>
                            <span className="font-mono text-white/45 whitespace-nowrap">Due: {Math.max(0, l.quantityOrdered - l.quantityReceived)} {l.inventoryItem.unit}</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )
                })}
              </div>
            </Section>
          </>
        )}

        {canReceive && (<form noValidate className="space-y-5"
          onSubmit={(e) => {
            e.preventDefault()
            setTried(true)
            if (!problem && !submit.isPending) submit.mutate()
          }}>
        <Section title="Step 1 — Match to a PO (or take a delivery without one)">
          {selectedPo ? (
            <div className="flex items-center justify-between rounded-lg p-3" style={{ background: 'rgb(var(--erp-accent-rgb) / 0.12)', border: '1px solid var(--erp-accent)' }}>
              <div>
                <p className="text-sm font-bold text-white/90">{poLabel(selectedPo)} · {selectedPo.supplier.name}</p>
                <p className="text-xs text-white/45">{selectedPo.status === 'partial' ? 'Part-received — showing what is still outstanding' : 'Sent'}</p>
              </div>
              <button type="button" onClick={clearPo} className="text-xs text-white/50 hover:text-white/80">Change</button>
            </div>
          ) : (
            <>
              {ownWantedPo && (
                <div role="status" className="rounded-lg px-3 py-2 mb-3 text-xs font-bold"
                  style={{ background: 'rgb(var(--fg-rgb) / 0.04)', border: '1px solid rgb(var(--fg-rgb) / 0.12)', color: 'rgb(var(--fg-rgb) / 0.85)' }}>
                  You raised {poLabel(ownWantedPo)}, so a colleague receives it.
                </div>
              )}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                {pos.length === 0 && !posError && <p className="text-xs text-white/35 italic">No purchase orders waiting to be received.</p>}
                {pos.map((po) => {
                  const own = raisedByMe(po, me)
                  return (
                    <button type="button" key={po.id} onClick={() => { if (!own) loadFromPo(po) }} disabled={own}
                      title={own ? 'You raised this PO, so a colleague receives it' : undefined}
                      className="rounded-lg p-3 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-60"
                      style={{ background: 'rgb(var(--fg-rgb) / 0.025)', border: '1px solid rgb(var(--fg-rgb) / 0.06)' }}>
                      <p className="text-sm font-bold text-white/90">{poLabel(po)}</p>
                      <p className="text-xs text-white/45">{po.supplier.name} · {po.lines.length} lines{po.status === 'partial' ? ' · part-received' : ''}</p>
                      {own && <p className="text-[11px] text-white/55 mt-1">You raised this, a colleague receives it</p>}
                    </button>
                  )
                })}
              </div>
              <FormField className="mt-3" label="Or a delivery without a PO (market run, ad-hoc) from"
                error={tried && !poId && !supplierId ? 'Pick a PO above, or choose the supplier.' : undefined}>
                <Select value={supplierId} onChange={(e) => setSupplierId(e.target.value)} className={fieldCls}>
                  <option value="">— choose supplier —</option>
                  {suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                </Select>
              </FormField>
            </>
          )}
        </Section>

        <Section title="Step 2 — Mark received quantities">
          {lines.length === 0 && <p className="text-xs text-white/35 italic">{poId ? 'Nothing outstanding on this PO.' : 'Pick a PO above or add lines.'}</p>}
          {poId && lines.length > 0 && (
            <button type="button" onClick={fillAllAsOrdered}
              className="rounded-lg border border-white/[0.12] px-3 py-2 text-xs font-bold text-white/80 hover:border-primary hover:text-primary-ink [@media(pointer:coarse)]:min-h-11">
              Fill all as ordered
            </button>
          )}
          <div ref={stepTwoRef} onKeyDown={onStepTwoKey}>
          {lines.map((l) => {
            const qty = Number(l.receivedQty) || 0
            const variance = l.outstanding != null && l.outstanding > 0 ? ((qty - l.outstanding) / l.outstanding) * 100 : null
            const flag = variance != null && Math.abs(variance) > 5
            return (
              <div key={l.key} className="rounded-lg p-3 space-y-2 mt-2"
                style={{
                  background: flag ? 'rgba(245,158,11,0.05)' : 'rgb(var(--fg-rgb) / 0.025)',
                  border: `1px solid ${flag ? 'rgba(245,158,11,0.3)' : 'rgb(var(--fg-rgb) / 0.06)'}`,
                }}>
                <div className="grid grid-cols-[minmax(0,1fr)_auto_auto_auto] gap-2 items-center">
                  {l.poLineId ? (
                    <p className="text-sm font-bold text-white/85">{l.description}</p>
                  ) : (
                    <Select value={l.inventoryItemId ?? ''} onChange={(e) => pickItem(l.key, e.target.value)} className={fieldCls}>
                      <option value="">— inventory item —</option>
                      {items.map((i) => <option key={i.id} value={i.id}>{i.name} ({i.unit})</option>)}
                    </Select>
                  )}
                  {l.outstanding != null && <span className="text-xs text-white/45 font-mono whitespace-nowrap">Due: {l.outstanding} {l.unit}</span>}
                  <NumberField decimals={3} min={0} value={numOf(l.receivedQty)} onValueChange={(v) => patchLine(l.key, { receivedQty: textOf(v) })}
                    aria-label={`Received quantity${l.description ? ` of ${l.description}` : ''}`}
                    className={fieldCls + ' w-24'} placeholder="Recv" />
                  <div className="flex items-center gap-1">
                    <span className="text-xs text-white/45 w-10">{l.unit}</span>
                    {!poId && <button type="button" onClick={() => rmLine(l.key)} className="text-white/30 hover:text-s-red text-sm px-2 [@media(pointer:coarse)]:min-h-11" aria-label="Remove line">×</button>}
                  </div>
                </div>
                {!l.poLineId && (
                  <div className="flex items-center gap-2">
                    <label htmlFor={`cost-${l.key}`} className="text-xs text-white/55 whitespace-nowrap">Unit cost paid (PKR per {l.unit || 'unit'})</label>
                    <MoneyInput id={`cost-${l.key}`} value={centsOf(l.unitCostPkr)} onChange={(c) => patchLine(l.key, { unitCostPkr: pkrOf(c) })}
                      className={fieldCls + ' w-32'} placeholder="0.00" />
                  </div>
                )}
                {variance != null && Math.abs(variance) > 0.5 && (
                  <p className="text-[11px] font-bold" style={{ color: flag ? 'var(--erp-warning)' : 'rgb(var(--fg-rgb) / 0.55)' }}>
                    {variance > 0 ? '+' : ''}{variance.toFixed(1)}% {flag ? '— will flag' : ''}
                  </p>
                )}
                <input value={l.notes} onChange={(e) => patchLine(l.key, { notes: e.target.value })}
                  aria-label={`Note for ${l.description || 'this line'}`}
                  placeholder="Note (damaged, wrong cut, expiry near…)" className={fieldCls + ' text-xs'} />
              </div>
            )
          })}
          </div>
          {!poId && supplierId && (
            <button type="button" onClick={addBlankLine} className="text-xs text-primary-ink hover:underline mt-2">+ Add line</button>
          )}
        </Section>

        <Section title="Step 3 — Outlet and evidence">
          {activeOutlets.length > 0 && (
            <div className="mb-3">
              <label htmlFor="recv-outlet" className="text-xs text-white/55">Outlet it arrived at (optional)</label>
              <Select id="recv-outlet" value={locationId} onChange={(e) => setLocationId(e.target.value)} className={fieldCls + ' mt-1'}>
                <option value="">No particular outlet</option>
                {activeOutlets.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
              </Select>
              <p className="text-[11px] text-white/35 mt-1">Stock is still one pool per company; the outlet is recorded for when per-outlet stock arrives.</p>
            </div>
          )}
          <div id="recv-photo">
            <PendingFilesPicker ownerType="goods_receipt" max={5} value={photos} onChange={setPhotos} label="Dock-door photos" hint="Required above your company's photo threshold. Settles supplier disputes later." />
          </div>
          <FormField className="mt-3" label="Notes">
            <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} placeholder="Driver name, time, anything off about the delivery." className={fieldCls} />
          </FormField>
        </Section>

        {submit.error && <ErrorBanner label="Save failed:" error={submit.error} />}
        {tried && problem && <p role="alert" className="text-xs font-bold text-right" style={{ color: 'var(--erp-warning)' }}>{problem}</p>}

        <p className="text-xs text-white/50 text-right">
          Booked to Goods received not invoiced until the bill arrives.
        </p>

        <div className="flex justify-end gap-3 pt-2">
          <button type="submit" disabled={submit.isPending}
            className="rounded-xl bg-primary px-6 py-3 text-sm font-black text-primary-on hover:opacity-90 disabled:opacity-50">
            {submit.isPending ? 'Saving…' : 'Accept delivery →'}
          </button>
        </div>
        </form>)}

        <div className="pt-6 mt-6 border-t border-white/[0.05]">
          <h2 className="text-xs font-black uppercase tracking-[0.24em] text-white/55 mb-3">Recent deliveries{receiptsError ? '' : ` · ${receipts.length}`}</h2>
          <div className="space-y-1.5">
            {receipts.slice(0, 20).map((r) => (
              <div key={r.id} className="flex items-center justify-between rounded-lg px-3 py-2 text-xs"
                style={{ background: 'rgb(var(--fg-rgb) / 0.02)', border: '1px solid rgb(var(--fg-rgb) / 0.05)' }}>
                <span className="text-white/75">{new Date(r.receivedAt).toLocaleString()} · {supplierName.get(r.supplierId) ?? 'Supplier'}</span>
                <span className="text-white/45">{r.poId ? 'PO' : 'No PO'} · {r.lines.length} lines · <span style={{ color: r.varianceFlag ? 'var(--erp-warning)' : undefined }}>{r.status}</span></span>
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
      style={{ background: 'rgb(var(--fg-rgb) / 0.025)', border: '1px solid rgb(var(--fg-rgb) / 0.06)' }}>
      <h2 className="text-sm font-black uppercase tracking-[0.18em] text-white/65">{title}</h2>
      <div className="mt-3">{children}</div>
    </div>
  )
}
function ErrorBanner({ label, error }: { label: string; error: unknown }) {
  const msg = error instanceof Error ? stockErrorText(error, 'Something went wrong') : 'Something went wrong'
  return <div role="alert" className="rounded-xl px-4 py-3 text-sm" style={{ background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.3)', color: 'var(--erp-danger)' }}><strong>{label}</strong> {msg}</div>
}
const fieldCls = "w-full rounded-lg bg-white/[0.03] border border-white/[0.08] px-3 py-2 text-sm text-white/85 focus:border-primary focus:outline-none"
