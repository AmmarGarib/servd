'use client'
import { useState } from 'react'
import { useQuery, useMutation } from '@tanstack/react-query'
import { api, menuApi, type Category, type MenuItem, type ModifierGroup, type Modifier } from '../../../lib/api'
import { usePosStore } from '../../../store/pos'
import Link from 'next/link'
import { useCurrentShift } from '../../../hooks/useCurrentShift'

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

  const storedConceptId = usePosStore(s => s.conceptId)
  const shiftId = usePosStore(s => s.shiftId)
  // The server, not this browser, says which drawer this user is on.
  useCurrentShift()

  const { data: concepts = [] } = useQuery({
    queryKey: ['concepts'],
    queryFn: () => api.get<{ id: string; name: string; slug: string }[]>('/concepts'),
  })
  const conceptId = storedConceptId || concepts[0]?.id || ''

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
    mutationFn: async () => {
      const order = await api.post<{ id: string }>('/pos/orders', {
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
      })
      return order
    },
    onSuccess: (order) => {
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
      <div className="erp-kitchen-dark flex flex-col items-center justify-center h-screen gap-6 bg-kds-bg px-6 text-center">
        <div className="text-6xl">✅</div>
        <h1 className="text-2xl font-black text-kds-text">Order Sent!</h1>
        <p className="text-kds-subtext">Table {selectedTable?.label} · {cart.reduce((s, c) => s + c.qty, 0)} items sent to kitchen</p>
        <div className="flex gap-3 w-full max-w-xs">
          <button onClick={() => {
            setCart([]); setStep('table'); setSelectedTable(null); setOrderNote(''); setSubmittedOrderId(null)
          }} className="flex-1 rounded-xl bg-kds-green py-3 font-bold text-white text-sm">
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
    <div className="flex flex-col h-screen bg-kds-bg overflow-hidden">

      {/* Header */}
      <div className="flex items-center gap-3 h-12 px-4 border-b border-kds-border bg-kds-card shrink-0">
        {step !== 'table' ? (
          <button onClick={() => setStep(step === 'confirm' ? 'menu' : 'table')}
            className="text-kds-subtext text-sm hover:text-kds-text">← Back</button>
        ) : (
          <Link href="/pos" className="text-kds-subtext text-sm hover:text-kds-text">← POS</Link>
        )}
        <span className="font-bold text-kds-text flex-1 text-center">
          {step === 'table' ? 'Select Table' : step === 'menu' ? `Table ${selectedTable?.label}` : 'Confirm Order'}
        </span>
        {cart.length > 0 && step === 'menu' && (
          <button onClick={() => setStep('confirm')}
            className="rounded-xl bg-kds-green px-3 py-1.5 text-xs font-bold text-white">
            Order ({cart.reduce((s, c) => s + c.qty, 0)}) →
          </button>
        )}
      </div>

      {/* Step: Table selection */}
      {step === 'table' && (
        <div className="flex-1 overflow-y-auto p-4">
          {!shiftId && (
            <div className="mb-3 rounded-xl bg-kds-red/15 border border-kds-red/40 px-3 py-2 text-sm font-semibold text-kds-red">
              ⚠ No shift open — orders won't have a shift assigned
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
                className={`shrink-0 rounded-lg px-4 py-2 text-sm font-semibold transition-colors ${
                  cat.id === (selectedCategory ?? categories[0]?.id)
                    ? 'bg-kds-green text-white'
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
                    <div className="absolute top-2 right-2 h-5 w-5 rounded-full bg-kds-green text-white text-[10px] font-black flex items-center justify-center">
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
              className="w-full rounded-xl border border-kds-border bg-kds-card px-3 py-2 text-sm text-kds-text resize-none" />
          </div>

          {submitMutation.isError && (
            <p className="text-kds-red text-sm">{submitMutation.error instanceof Error ? submitMutation.error.message : 'Failed to send order'}</p>
          )}
        </div>
      )}

      {/* Bottom bar for confirm step */}
      {step === 'confirm' && (
        <div className="shrink-0 px-4 py-3 border-t border-kds-border bg-kds-card">
          <div className="flex items-center justify-between mb-3">
            <span className="text-sm text-kds-subtext">{cart.reduce((s, c) => s + c.qty, 0)} items · Table {selectedTable?.label}</span>
            <span className="font-bold text-kds-text">PKR {(cartTotal / 100).toFixed(0)}</span>
          </div>
          <button onClick={() => submitMutation.mutate()}
            disabled={submitMutation.isPending || cart.length === 0}
            className="w-full rounded-xl bg-kds-green py-4 font-bold text-white text-base disabled:opacity-30 active:scale-95">
            {submitMutation.isPending ? 'Sending…' : 'Send to Kitchen 🍽'}
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
                  className={`rounded-lg border px-3 py-2 text-sm transition-colors ${selected.has(m.id) ? 'border-kds-green bg-kds-green/20 text-kds-green' : 'border-kds-border text-kds-text'}`}>
                  {m.name}{m.priceDeltaCents !== 0 && <span className="text-kds-subtext ml-1">+{(m.priceDeltaCents/100).toFixed(0)}</span>}
                </button>
              ))}
            </div>
          </div>
        ))}
        <div className="flex gap-3">
          <button onClick={onClose} className="flex-1 rounded-xl border border-kds-border py-3 text-kds-subtext">Cancel</button>
          <button onClick={confirm} className="flex-1 rounded-xl bg-kds-green py-3 font-bold text-white">Add to Order</button>
        </div>
      </div>
    </div>
  )
}
