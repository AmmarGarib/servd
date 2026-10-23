'use client'
import { useEffect, useRef, useState } from 'react'
import { ArrowLeft, ArrowRight, CircleCheck, Clock, TriangleAlert, Utensils } from 'lucide-react'
import { useQuery, useMutation } from '@tanstack/react-query'
import { api, menuApi, type Category, type MenuItem, type ModifierGroup, type Modifier } from '../../../lib/api'
import { usePosStore } from '../../../store/pos'
import Link from 'next/link'
import { useCurrentShift } from '../../../hooks/useCurrentShift'
import {
  newIdempotencyKey, isOfflinePlaceholder, preBillErrorMessage, printPreBill, tillErrorMessage,
  type TillBrand, type TillOrder,
} from '../../../components/pos/tillApi'
import { postOrderOrQueue, summariseLines } from '../../../lib/offline-queue'
import { OfflineQueueBar } from '../../../components/pos/OfflineQueue'
import { useAuthStore } from '../../../store/auth'

type Step = 'table' | 'menu' | 'confirm' | 'done'

interface Table { id: string; label: string; section?: string; status: string }

export default function WaiterPage() {
  const [step, setStep] = useState<Step>('table')
  const [selectedTable, setSelectedTable] = useState<Table | null>(null)
  const [selectedCategory, setSelectedCategory] = useState<string | null>(null)
  const [cart, setCart] = useState<Array<{ item: MenuItem; qty: number; mods: Modifier[] }>>([])
  const [modifierItem, setModifierItem] = useState<MenuItem | null>(null)
  const [orderNote, setOrderNote] = useState('')
  const [submittedOrderId, setSubmittedOrderId] = useState<string | null>(null)
  const [queuedOffline, setQueuedOffline] = useState(false)
  // The table's pre-bill (spec §17.1): not a tax invoice, never sent to the POS.
  const [preBillNote, setPreBillNote] = useState<{ ok: boolean; text: string } | null>(null)
  const [preBillBusy, setPreBillBusy] = useState(false)
  // FOH-06: one random idempotency key per SUBMISSION. A retry of the same
  // submission (same brand, table, lines and note — after a timeout or a
  // double tap) reuses it, so the server returns that one order instead of
  // firing a second ticket. Any edit is a new submission and a new key, and
  // the key is dropped once the order is sent, so the next table's identical
  // round is never deduped onto this one. (The screen used to send no key at
  // all, and the server keyed it on the current millisecond: two waiters in
  // the same millisecond got ONE order back — one table's items never
  // reached the kitchen.)
  const submission = useRef<{ signature: string; key: string } | null>(null)

  const storedConceptId = usePosStore(s => s.conceptId)
  const shiftId = usePosStore(s => s.shiftId)
  // The server, not this browser, says which drawer this user is on.
  useCurrentShift()

  // FOH-01: the company's brands, readable by waiters (narrow fields).
  const { data: concepts = [], isError: brandsFailed } = useQuery({
    queryKey: ['pos', 'brands'],
    queryFn: () => api.get<TillBrand[]>('/concepts'),
  })
  // The remembered brand only if it is still one of ours, else the first.
  const conceptId = (storedConceptId && concepts.some((c) => c.id === storedConceptId))
    ? storedConceptId
    : concepts[0]?.id ?? ''
  // UI-03: store the auto-selected brand, so the brand shown is the one rung.
  useEffect(() => {
    if (conceptId && conceptId !== storedConceptId) usePosStore.getState().setConceptId(conceptId)
  }, [conceptId, storedConceptId])

  const { data: tables = [] } = useQuery({
    queryKey: ['tables', conceptId],
    queryFn: () => api.get<Table[]>(`/tables?conceptId=${conceptId}`),
    enabled: !!conceptId,
  })

  const { data: categories = [] } = useQuery<Category[]>({
    queryKey: ['menu', conceptId],
    queryFn: () => menuApi.getMenu(conceptId),
    enabled: !!conceptId,
  })

  const currentCategory = categories.find(c => c.id === selectedCategory) ?? categories[0]

  const submitMutation = useMutation({
    meta: { inlineErrors: true },
    mutationFn: async () => {
      if (!conceptId) throw new Error('No brand to ring this under — reload, or ask a manager')
      const body = {
        conceptId,
        tableId: selectedTable?.id ?? null,
        shiftId: shiftId ?? null,
        items: cart.flatMap(({ item, qty, mods }) =>
          Array.from({ length: qty }, () => ({
            menuItemId: item.id,
            name: item.name,
            quantity: 1,
            unitPriceCents: item.priceCents,
            notes: orderNote || undefined,
            modifiers: mods.map(m => ({ modifierId: m.id, name: m.name, priceDeltaCents: m.priceDeltaCents })),
          }))
        ),
        discountCents: 0,
      }
      // The drawer isn't part of what was ordered: a shift re-sync between a
      // timed-out attempt and its retry must not mint a second key.
      const { shiftId: _drawer, ...ordered } = body
      const signature = JSON.stringify(ordered)
      if (submission.current?.signature !== signature) {
        submission.current = { signature, key: newIdempotencyKey() }
      }
      // Offline: kept on this device with the same key and sent later (lib/offline-queue.ts).
      return postOrderOrQueue<TillOrder>({ ...body, idempotencyKey: submission.current.key },
        summariseLines(body.items, { label: selectedTable ? `Table ${selectedTable.label}` : 'Waiter', brandName: concepts.find((c) => c.id === conceptId)?.name ?? null }))
    },
    onSuccess: (order) => {
      // Sent: the next submission — even an identical round — is a new order.
      submission.current = null
      setQueuedOffline(isOfflinePlaceholder(order))
      setSubmittedOrderId(order.id)
      setStep('done')
    },
  })

  function addToCart(item: MenuItem, mods: Modifier[] = []) {
    setCart(prev => {
      const existing = prev.find(c => c.item.id === item.id && JSON.stringify(c.mods) === JSON.stringify(mods))
      if (existing) return prev.map(c => c === existing ? { ...c, qty: c.qty + 1 } : c)
      return [...prev, { item, qty: 1, mods }]
    })
    setModifierItem(null)
  }

  function changeQty(idx: number, delta: number) {
    setCart(prev => {
      const next = [...prev]
      const item = next[idx]!
      if (item.qty + delta <= 0) return prev.filter((_, i) => i !== idx)
      next[idx] = { ...item, qty: item.qty + delta }
      return next
    })
  }

  const cartTotal = cart.reduce((s, c) => {
    const modTotal = c.mods.reduce((ms, m) => ms + m.priceDeltaCents, 0)
    return s + (c.item.priceCents + modTotal) * c.qty
  }, 0)

  if (step === 'done') {
    return (
      <div className="erp-kitchen-dark flex flex-col items-center justify-center h-screen h-dvh gap-6 bg-kds-bg px-6 text-center">
        {queuedOffline ? <Clock size={56} aria-hidden="true" className="text-kds-amber" /> : <CircleCheck size={56} aria-hidden="true" className="text-kds-green" />}
        <h1 className="text-2xl font-black text-kds-text">{queuedOffline ? 'Kept on this device — not sent yet' : 'Order Sent!'}</h1>
        <p className="text-kds-subtext">
          Table {selectedTable?.label} · {cart.reduce((s, c) => s + c.qty, 0)} items
          {queuedOffline ? ' are NOT in the kitchen yet. They are sent when the connection is back — check "waiting to sync" on the till.' : ' sent to kitchen'}
        </p>
        {!queuedOffline && submittedOrderId && (
          <div className="w-full max-w-xs space-y-2">
            <button
              type="button"
              disabled={preBillBusy}
              onClick={() => {
                setPreBillNote(null)
                setPreBillBusy(true)
                printPreBill(submittedOrderId, 'cash', useAuthStore.getState().token)
                  .then(() => setPreBillNote({ ok: true, text: 'Pre-bill printed — not a tax invoice. The full & final bill prints after payment.' }))
                  .catch((e: unknown) => setPreBillNote({ ok: false, text: preBillErrorMessage(e) }))
                  .finally(() => setPreBillBusy(false))
              }}
              className="w-full rounded-xl border border-kds-border py-3 text-sm font-bold text-kds-text disabled:opacity-30">
              {preBillBusy ? 'Printing pre-bill…' : 'Print pre-bill'}
            </button>
            {preBillNote && (
              <p className={`text-xs ${preBillNote.ok ? 'text-kds-subtext' : 'text-kds-red'}`} role={preBillNote.ok ? 'status' : 'alert'}>
                {preBillNote.text}
              </p>
            )}
          </div>
        )}
        <div className="flex gap-3 w-full max-w-xs">
          <button onClick={() => {
            submission.current = null
            setCart([]); setStep('table'); setSelectedTable(null); setOrderNote(''); setSubmittedOrderId(null); setQueuedOffline(false)
            setPreBillNote(null)
          }} className="flex-1 rounded-xl bg-kds-green py-3 font-bold text-primary-on text-sm">
            New Order
          </button>
          <Link href="/orders" className="flex-1 rounded-xl border border-kds-border py-3 font-bold text-kds-subtext text-sm text-center">
            View Orders
          </Link>
        </div>
      </div>
    )
  }

  return (
    <div className="erp-kitchen-dark flex flex-col h-screen h-dvh bg-kds-bg overflow-hidden">
      <OfflineQueueBar />

      {/* Header */}
      <div className="flex items-center gap-3 h-12 px-4 border-b border-kds-border bg-kds-card shrink-0">
        {step !== 'table' ? (
          <button onClick={() => setStep(step === 'confirm' ? 'menu' : 'table')}
            className="inline-flex min-h-11 items-center gap-1 text-kds-subtext text-sm hover:text-kds-text"><ArrowLeft size={16} aria-hidden="true" /> Back</button>
        ) : (
          <Link href="/pos" className="inline-flex min-h-11 items-center gap-1 text-kds-subtext text-sm hover:text-kds-text"><ArrowLeft size={16} aria-hidden="true" /> POS</Link>
        )}
        <span className="font-bold text-kds-text flex-1 text-center">
          {step === 'table' ? 'Select Table' : step === 'menu' ? `Table ${selectedTable?.label}` : 'Confirm Order'}
        </span>
        {cart.length > 0 && step === 'menu' && (
          <button onClick={() => setStep('confirm')}
            className="min-h-11 rounded-xl bg-kds-green px-3 py-1.5 text-xs font-bold text-primary-on">
            Order ({cart.reduce((s, c) => s + c.qty, 0)}) <ArrowRight size={14} aria-hidden="true" className="inline-block align-[-2px]" />
          </button>
        )}
      </div>

      {/* Step: Table selection */}
      {step === 'table' && (
        <div className="flex-1 overflow-y-auto p-4">
          {!shiftId && (
            <div className="mb-3 rounded-xl bg-kds-red/15 border border-kds-red/40 px-3 py-2 text-sm font-semibold text-kds-red">
              <TriangleAlert size={16} aria-hidden="true" className="inline-block align-[-3px] mr-1" />No shift open — orders won't have a shift assigned
            </div>
          )}
          {brandsFailed && (
            <div className="mb-3 rounded-xl bg-kds-red/15 border border-kds-red/40 px-3 py-2 text-sm font-semibold text-kds-red">
              Could not load your brands — reload, or ask a manager
            </div>
          )}
          {concepts.length > 1 && (
            <div className="mb-3 flex gap-2 overflow-x-auto scrollbar-hide">
              {concepts.map((c) => (
                <button key={c.id} onClick={() => {
                  // Another brand's dishes can't go on this brand's ticket.
                  if (c.id !== conceptId) { setCart([]); setSelectedCategory(null) }
                  usePosStore.getState().setConceptId(c.id)
                }}
                  className={`min-h-11 shrink-0 rounded-lg px-3 py-1.5 text-sm font-semibold ${
                    c.id === conceptId ? 'bg-kds-green text-primary-on' : 'border border-kds-border text-kds-subtext'
                  }`}>
                  {c.name}
                </button>
              ))}
            </div>
          )}
          <div className="grid grid-cols-3 gap-3">
            {tables.map(t => (
              <button key={t.id} onClick={() => { setSelectedTable(t); setStep('menu') }}
                className={`rounded-xl p-4 text-center transition-colors border ${
                  t.status === 'occupied'
                    ? 'border-kds-amber/50 bg-kds-amber/10'
                    : 'border-kds-border bg-kds-card hover:border-kds-green'
                }`}>
                <div className="text-2xl font-black text-kds-text">{t.label}</div>
                {t.section && <div className="text-[11px] text-kds-subtext mt-0.5">{t.section}</div>}
                {t.status === 'occupied' && <div className="text-[10px] text-kds-amber font-bold mt-1">occupied</div>}
              </button>
            ))}
            {tables.length === 0 && (
              <div className="col-span-3 text-center py-10 text-kds-subtext text-sm">No tables found</div>
            )}
          </div>
        </div>
      )}

      {/* Step: Menu browsing */}
      {step === 'menu' && (
        <div className="flex flex-col flex-1 overflow-hidden">
          {/* Category scroll */}
          <div className="flex gap-2 overflow-x-auto px-3 py-2 border-b border-kds-border bg-kds-card shrink-0 scrollbar-hide">
            {categories.map(cat => (
              <button key={cat.id} onClick={() => setSelectedCategory(cat.id)}
                className={`min-h-11 shrink-0 rounded-lg px-4 py-2 text-sm font-semibold transition-colors ${
                  cat.id === (selectedCategory ?? categories[0]?.id)
                    ? 'bg-kds-green text-primary-on'
                    : 'text-kds-subtext hover:bg-kds-border'
                }`}>
                {cat.name}
              </button>
            ))}
          </div>

          {/* Items grid */}
          <div className="flex-1 overflow-y-auto p-3">
            <div className="grid grid-cols-2 gap-3">
              {currentCategory?.items.map(item => (
                <button key={item.id} onClick={() => {
                  const hasReq = item.modifierGroups?.some((g: ModifierGroup) => g.isRequired)
                  if (hasReq) setModifierItem(item)
                  else addToCart(item)
                }}
                  disabled={!item.isAvailable}
                  className={`rounded-xl border p-3 text-left transition-all active:scale-95 relative ${
                    item.isAvailable ? 'border-kds-border bg-kds-card hover:border-kds-green' : 'border-kds-border opacity-40'
                  }`}>
                  {item.imageUrl && <img src={item.imageUrl} alt="" className="w-full h-20 object-cover rounded-lg mb-2" />}
                  <div className="font-semibold text-kds-text text-sm leading-tight">{item.name}</div>
                  <div className="text-kds-green font-bold text-sm mt-1">PKR {(item.priceCents / 100).toFixed(0)}</div>
                  {/* Cart badge */}
                  {cart.some(c => c.item.id === item.id) && (
                    <div className="absolute top-2 right-2 h-5 w-5 rounded-full bg-kds-green text-primary-on text-[10px] font-black flex items-center justify-center">
                      {cart.filter(c => c.item.id === item.id).reduce((s, c) => s + c.qty, 0)}
                    </div>
                  )}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Step: Confirm order */}
      {step === 'confirm' && (
        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          <div className="rounded-2xl border border-kds-border bg-kds-card overflow-hidden">
            {cart.map((entry, idx) => {
              const modTotal = entry.mods.reduce((s, m) => s + m.priceDeltaCents, 0)
              const lineTotal = (entry.item.priceCents + modTotal) * entry.qty
              return (
                <div key={idx} className="flex items-center gap-3 px-4 py-3 border-b border-kds-border last:border-0">
                  <div className="flex-1">
                    <div className="font-semibold text-kds-text text-sm">{entry.item.name}</div>
                    {entry.mods.length > 0 && (
                      <div className="text-[11px] text-kds-subtext">{entry.mods.map(m => m.name).join(', ')}</div>
                    )}
                  </div>
                  <div className="flex items-center gap-2">
                    <button onClick={() => changeQty(idx, -1)}
                      className="h-11 w-11 rounded-full border border-kds-border text-kds-subtext font-bold text-base flex items-center justify-center">
                      -
                    </button>
                    <span className="w-4 text-center font-bold text-kds-text text-sm">{entry.qty}</span>
                    <button onClick={() => changeQty(idx, 1)}
                      className="h-11 w-11 rounded-full border border-kds-border text-kds-subtext font-bold text-base flex items-center justify-center">
                      +
                    </button>
                  </div>
                  <div className="text-kds-green font-bold text-sm w-20 text-right">
                    PKR {(lineTotal / 100).toFixed(0)}
                  </div>
                </div>
              )
            })}
          </div>

          <div>
            <label className="text-xs font-semibold text-kds-subtext block mb-1">Order note (optional)</label>
            <textarea value={orderNote} onChange={e => setOrderNote(e.target.value)}
              rows={2} placeholder="Allergies, special requests…"
              className="min-h-11 w-full rounded-xl border border-kds-border bg-kds-card px-3 py-2 text-sm text-kds-text resize-none" />
          </div>

          {submitMutation.isError && (
            <p className="text-kds-red text-sm">{tillErrorMessage(submitMutation.error, 'Failed to send order')}</p>
          )}
        </div>
      )}

      {/* Bottom bar for confirm step */}
      {step === 'confirm' && (
        <div className="shrink-0 px-4 py-3 border-t border-kds-border bg-kds-card">
          <div className="flex items-center justify-between mb-3">
            <span className="text-sm text-kds-subtext">{cart.reduce((s, c) => s + c.qty, 0)} items · Table {selectedTable?.label}</span>
            <span className="font-bold text-kds-text">
              PKR {(cartTotal / 100).toFixed(0)} <span className="text-xs font-normal text-kds-subtext">before GST</span>
            </span>
          </div>
          <button onClick={() => submitMutation.mutate()}
            disabled={submitMutation.isPending || cart.length === 0}
            className="w-full rounded-xl bg-kds-green py-4 font-bold text-primary-on text-base disabled:opacity-30 active:scale-95">
            {submitMutation.isPending ? 'Sending…' : <span className="inline-flex items-center justify-center gap-2">Send to Kitchen <Utensils size={18} aria-hidden="true" /></span>}
          </button>
        </div>
      )}

      {/* Modifier modal */}
      {modifierItem && (
        <WaiterModifierModal item={modifierItem} onConfirm={(mods) => addToCart(modifierItem, mods)} onClose={() => setModifierItem(null)} />
      )}
    </div>
  )
}

function WaiterModifierModal({ item, onConfirm, onClose }: { item: MenuItem; onConfirm: (mods: Modifier[]) => void; onClose: () => void }) {
  const [selected, setSelected] = useState<Set<string>>(new Set())
  function toggle(id: string) {
    setSelected(prev => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n })
  }
  function confirm() {
    const all = item.modifierGroups.flatMap((g: ModifierGroup) => g.modifiers)
    onConfirm(all.filter((m: Modifier) => selected.has(m.id)))
  }
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/70">
      <div className="w-full max-w-md rounded-t-2xl bg-kds-card p-5">
        <h2 className="mb-4 text-base font-bold text-kds-text">{item.name}</h2>
        {item.modifierGroups.map((g: ModifierGroup) => (
          <div key={g.id} className="mb-4">
            <p className="text-sm font-semibold text-kds-subtext mb-2">{g.name}{g.isRequired && <span className="text-kds-red ml-1">*</span>}</p>
            <div className="grid grid-cols-2 gap-2">
              {g.modifiers.map((m: Modifier) => (
                <button key={m.id} onClick={() => toggle(m.id)}
                  className={`min-h-11 rounded-lg border px-3 py-2 text-sm transition-colors ${selected.has(m.id) ? 'border-kds-green bg-kds-green/20 text-kds-green' : 'border-kds-border text-kds-text'}`}>
                  {m.name}{m.priceDeltaCents !== 0 && <span className="text-kds-subtext ml-1">+{(m.priceDeltaCents/100).toFixed(0)}</span>}
                </button>
              ))}
            </div>
          </div>
        ))}
        <div className="flex gap-3">
          <button onClick={onClose} className="flex-1 rounded-xl border border-kds-border py-3 text-kds-subtext">Cancel</button>
          <button onClick={confirm} className="flex-1 rounded-xl bg-kds-green py-3 font-bold text-primary-on">Add to Order</button>
        </div>
      </div>
    </div>
  )
}
