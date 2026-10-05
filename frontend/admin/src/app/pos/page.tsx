'use client'
import { useState, useEffect } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api, menuApi, type Category, type MenuItem, type ModifierGroup, type Modifier } from '../../lib/api'
import { usePosStore } from '../../store/pos'
import { PosCart } from '../../components/pos/PosCart'
import { PaymentModal } from '../../components/pos/PaymentModal'
import { requestSync, listenForSync, getQueuedOrders } from '../../lib/offline-queue'
import Link from 'next/link'
import { useCurrentShift } from '../../hooks/useCurrentShift'

export default function PosPage() {
  const [selectedCategory, setSelectedCategory] = useState<string | null>(null)
  const [modifierItem, setModifierItem] = useState<MenuItem | null>(null)
  const [showPayment, setShowPayment] = useState(false)
  const [cartOpen, setCartOpen] = useState(false)
  const [isOnline, setIsOnline] = useState(true)
  const [queuedCount, setQueuedCount] = useState(0)
  const [syncedCount, setSyncedCount] = useState(0)

  useEffect(() => {
    // Register SW
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw.js').catch(() => {})
    }

    setIsOnline(navigator.onLine)
    const handleOnline = () => {
      setIsOnline(true)
      requestSync()
    }
    const handleOffline = () => setIsOnline(false)
    window.addEventListener('online', handleOnline)
    window.addEventListener('offline', handleOffline)

    // Check initial queue size
    getQueuedOrders().then(orders => setQueuedCount(orders.length)).catch(() => {})

    // Listen for sync completion
    const unsub = listenForSync((count) => {
      setSyncedCount(count)
      setQueuedCount(0)
      setTimeout(() => setSyncedCount(0), 4000)
    })

    return () => {
      window.removeEventListener('online', handleOnline)
      window.removeEventListener('offline', handleOffline)
      unsub()
    }
  }, [])
  const addItem = usePosStore((s) => s.addItem)
  const storedConceptId = usePosStore((s) => s.conceptId)
  const shiftId = usePosStore((s) => s.shiftId)
  // The server, not this browser, says which drawer this user is on.
  useCurrentShift()
  const cartCount = usePosStore((s) => s.cart.reduce((n, i) => n + i.quantity, 0))

  const { data: concepts = [] } = useQuery({
    queryKey: ['concepts'],
    queryFn: () => api.get<{ id: string; name: string; slug: string; taxRate: number }[]>('/concepts'),
  })

  // Auto-select first concept — no env var needed
  const conceptId = storedConceptId || concepts[0]?.id || ''

  const { data: categories = [] } = useQuery<Category[]>({
    queryKey: ['menu', conceptId],
    queryFn: () => menuApi.getMenu(conceptId),
    enabled: !!conceptId,
  })

  const activeConcept = concepts?.find((c) => c.id === conceptId)
  const taxRate = activeConcept?.taxRate ?? 17

  const currentCategory = categories.find((c) => c.id === selectedCategory) ?? categories[0]

  function handleItemTap(item: MenuItem) {
    const hasRequiredModifiers = item.modifierGroups?.some((g: ModifierGroup) => g.isRequired)
    if (hasRequiredModifiers) {
      setModifierItem(item)
    } else {
      addItem(item, [])
    }
  }

  return (
    <div className="flex h-screen overflow-hidden bg-kds-bg">

      {/* Mobile cart backdrop */}
      {cartOpen && (
        <div className="fixed inset-0 z-40 bg-black/60 lg:hidden" onClick={() => setCartOpen(false)} />
      )}

      {/* Mobile cart drawer */}
      {/* kds.card is a Tailwind colour, not a custom property, so the old
          `var(--kds-card, #141720)` always fell through to a hex that is in no
          palette. This drawer already uses border-kds-border / text-kds-text,
          so it takes the kds card colour via the class. */}
      <div className={`fixed inset-x-0 bottom-0 z-50 lg:hidden transition-transform duration-300 bg-kds-card ${cartOpen ? 'translate-y-0' : 'translate-y-full'}`}
        style={{ maxHeight: '85dvh', display: 'flex', flexDirection: 'column',
          borderTop: '1px solid rgba(255,255,255,0.08)',
          borderRadius: '16px 16px 0 0' }}>
        <div className="flex items-center justify-between px-4 py-3 border-b border-kds-border shrink-0">
          <span className="font-bold text-kds-text">Current Order</span>
          <button onClick={() => setCartOpen(false)} className="text-kds-subtext hover:text-kds-text text-xl leading-none">✕</button>
        </div>
        <div className="flex-1 min-h-0 overflow-y-auto">
          <PosCart taxRate={taxRate} onCheckout={() => { setCartOpen(false); setShowPayment(true) }} />
        </div>
      </div>

      {/* Mobile cart FAB */}
      {cartCount > 0 && !cartOpen && (
        <button
          onClick={() => setCartOpen(true)}
          className="fixed bottom-5 right-5 z-40 lg:hidden flex items-center gap-2 rounded-2xl px-5 py-3 font-bold text-sm text-black shadow-lg active:scale-95 transition-transform"
          style={{ background: 'linear-gradient(135deg, #00D4B1, #6366F1)', boxShadow: '0 4px 20px rgba(0,212,177,0.4)' }}>
          <span>🛒</span>
          <span>{cartCount} item{cartCount !== 1 ? 's' : ''}</span>
        </button>
      )}

      {/* Left — menu browser */}
      <div className="flex flex-1 flex-col">
        {/* Offline banner */}
        {!isOnline && (
          <div className="flex items-center gap-2 bg-kds-amber/15 border-b border-kds-amber/40 px-3 py-2">
            <span className="h-2 w-2 rounded-full bg-kds-amber shrink-0 animate-pulse" />
            <span className="text-sm font-semibold text-kds-amber flex-1">Offline — orders will be queued and synced when connection returns</span>
            {queuedCount > 0 && <span className="text-xs text-kds-amber font-bold">{queuedCount} queued</span>}
          </div>
        )}
        {/* Sync success banner */}
        {syncedCount > 0 && (
          <div className="flex items-center gap-2 bg-kds-green/15 border-b border-kds-green/30 px-3 py-2">
            <span className="text-sm font-semibold text-kds-green">✓ {syncedCount} offline order{syncedCount !== 1 ? 's' : ''} synced</span>
          </div>
        )}
        {/* Shift warning banner */}
        {!shiftId && (
          <div className="flex items-center justify-between bg-kds-red/20 border-b border-kds-red px-3 py-2">
            <span className="text-sm font-semibold text-kds-red">⚠ No shift open — payments will be blocked</span>
            <Link href="/pos/shift" className="rounded bg-kds-red px-3 py-1 text-xs font-bold text-white hover:opacity-90">
              Open Shift →
            </Link>
          </div>
        )}

        {/* Concept selector */}
        <div className="flex h-12 items-center gap-2 border-b border-kds-border bg-kds-card px-3">
          <Link href="/w" className="text-kds-subtext text-xs hover:text-kds-text mr-2">← Back</Link>
          <span className="text-sm text-kds-subtext">Concept:</span>
          {concepts.map((c) => (
            <button
              key={c.id}
              onClick={() => usePosStore.getState().setConceptId(c.id)}
              className={`rounded px-3 py-1 text-sm font-semibold ${
                c.id === conceptId
                  ? 'bg-kds-green text-white'
                  : 'text-kds-subtext hover:text-kds-text'
              }`}
            >
              {c.name}
            </button>
          ))}
        </div>

        {/* Category tabs */}
        <div className="flex gap-1 overflow-x-auto border-b border-kds-border bg-kds-card px-3 py-2 scrollbar-hide">
          {categories.map((cat) => (
            <button
              key={cat.id}
              onClick={() => setSelectedCategory(cat.id)}
              className={`shrink-0 rounded-lg px-4 py-2 text-sm font-semibold transition-colors ${
                cat.id === (selectedCategory ?? categories[0]?.id)
                  ? 'bg-kds-green text-white'
                  : 'text-kds-subtext hover:bg-kds-border hover:text-kds-text'
              }`}
            >
              {cat.name}
            </button>
          ))}
        </div>

        {/* Menu items grid */}
        <div className="flex-1 overflow-y-auto p-3">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-3 xl:grid-cols-4">
            {currentCategory?.items.map((item) => (
              <button
                key={item.id}
                onClick={() => handleItemTap(item)}
                disabled={!item.isAvailable}
                className={`flex min-h-[80px] flex-col items-start rounded-lg border p-3 text-left transition-all active:scale-95 ${
                  item.isAvailable
                    ? 'border-kds-border bg-kds-card hover:border-kds-green'
                    : 'border-kds-border bg-kds-border/30 opacity-40'
                }`}
              >
                {item.imageUrl && (
                  <img src={item.imageUrl} alt={item.name} className="mb-2 h-12 w-full rounded object-cover" />
                )}
                <span className="font-semibold text-kds-text leading-tight">{item.name}</span>
                <span className="mt-auto pt-1 text-sm text-kds-green font-bold">
                  PKR {(item.priceCents / 100).toFixed(0)}
                </span>
                {!item.isAvailable && (
                  <span className="mt-1 text-xs font-bold text-kds-red">86'd</span>
                )}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Right — cart side-rail (landscape tablet / desktop only; portrait uses the drawer) */}
      <div className="hidden lg:flex w-80 flex-col border-l border-kds-border bg-kds-card">
        <PosCart taxRate={taxRate} onCheckout={() => setShowPayment(true)} />
      </div>

      {/* Modifier modal */}
      {modifierItem && (
        <ModifierModal
          item={modifierItem}
          onConfirm={(mods) => { addItem(modifierItem, mods); setModifierItem(null) }}
          onClose={() => setModifierItem(null)}
        />
      )}

      {/* Payment modal */}
      {showPayment && (
        <PaymentModal taxRate={taxRate} onClose={() => setShowPayment(false)} />
      )}
    </div>
  )
}

// ─── Modifier Modal ─────────────────────────────────────────────────────────

function ModifierModal({
  item,
  onConfirm,
  onClose,
}: {
  item: MenuItem
  onConfirm: (mods: Modifier[]) => void
  onClose: () => void
}) {
  // F14: track selections per-group so we can enforce minSelect/maxSelect.
  // A flat selected set wasn't enough to tell "0 from required group" apart
  // from "5 from a max-3 group" — the new structure makes both visible.
  const [selectedByGroup, setSelectedByGroup] = useState<Record<string, Set<string>>>({})

  function toggle(groupId: string, modId: string, maxSelect: number) {
    setSelectedByGroup((prev) => {
      const current = new Set(prev[groupId] ?? [])
      if (current.has(modId)) {
        current.delete(modId)
      } else {
        // If adding would exceed maxSelect, drop the oldest pick first so
        // single-select groups (max=1) behave like radio buttons naturally.
        if (current.size >= maxSelect && maxSelect > 0) {
          if (maxSelect === 1) current.clear()
          else {
            const oldest = current.values().next().value
            if (oldest) current.delete(oldest)
          }
        }
        current.add(modId)
      }
      return { ...prev, [groupId]: current }
    })
  }

  // For each required group, the user must pick at least minSelect items.
  // Compute a friendly message and a disabled state for the confirm button.
  const groupErrors: Record<string, string | null> = {}
  let canConfirm = true
  for (const g of item.modifierGroups ?? []) {
    const picked = selectedByGroup[g.id]?.size ?? 0
    const min = g.minSelect ?? (g.isRequired ? 1 : 0)
    const max = g.maxSelect ?? Infinity
    if (picked < min) {
      groupErrors[g.id] = min === 1 ? 'Please choose 1' : `Please choose at least ${min}`
      canConfirm = false
    } else if (picked > max) {
      groupErrors[g.id] = `Choose at most ${max}`
      canConfirm = false
    } else {
      groupErrors[g.id] = null
    }
  }

  function confirm() {
    if (!canConfirm) return
    const picked = new Set<string>()
    for (const set of Object.values(selectedByGroup)) for (const id of set) picked.add(id)
    const allMods = item.modifierGroups.flatMap((g: ModifierGroup) => g.modifiers)
    onConfirm(allMods.filter((m: Modifier) => picked.has(m.id)))
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/70 sm:items-center" role="dialog" aria-modal="true" aria-labelledby="modifier-modal-title">
      <div className="w-full max-w-md rounded-t-2xl bg-kds-card p-5 sm:rounded-2xl">
        <h2 id="modifier-modal-title" className="mb-4 text-lg font-bold">{item.name} — Options</h2>

        {item.modifierGroups.map((group: ModifierGroup) => {
          const picked = selectedByGroup[group.id]
          const max = group.maxSelect ?? Infinity
          const err = groupErrors[group.id]
          return (
            <div key={group.id} className="mb-4">
              <div className="mb-2 flex items-baseline justify-between">
                <p className="text-sm font-semibold text-kds-subtext">
                  {group.name}
                  {group.isRequired && <span className="ml-1 text-kds-red">*</span>}
                </p>
                {(group.minSelect > 0 || group.maxSelect < 99) && (
                  <p className="text-[10px] uppercase tracking-wider text-kds-subtext">
                    {group.minSelect === group.maxSelect
                      ? `pick ${group.minSelect}`
                      : `${group.minSelect}–${group.maxSelect}`}
                  </p>
                )}
              </div>
              <div className="grid grid-cols-2 gap-2">
                {group.modifiers.map((mod: Modifier) => {
                  const isOn = picked?.has(mod.id) ?? false
                  return (
                    <button
                      key={mod.id}
                      onClick={() => toggle(group.id, mod.id, max)}
                      className={`rounded-lg border px-3 py-2 text-left text-sm transition-colors ${
                        isOn
                          ? 'border-kds-green bg-kds-green/20 text-kds-green'
                          : 'border-kds-border text-kds-text hover:border-kds-subtext'
                      }`}
                    >
                      <span>{mod.name}</span>
                      {mod.priceDeltaCents !== 0 && (
                        <span className="ml-1 text-kds-subtext">
                          +{(mod.priceDeltaCents / 100).toFixed(0)}
                        </span>
                      )}
                    </button>
                  )
                })}
              </div>
              {err && (
                <p className="mt-1 text-xs font-semibold text-kds-amber">{err}</p>
              )}
            </div>
          )
        })}

        <div className="flex gap-3 pt-2">
          <button onClick={onClose} className="kds-btn-ghost flex-1 py-3">
            Cancel
          </button>
          <button onClick={confirm} disabled={!canConfirm}
            className="kds-btn-primary flex-1 py-3 disabled:cursor-not-allowed disabled:opacity-40">
            Add to Order
          </button>
        </div>
      </div>
    </div>
  )
}
