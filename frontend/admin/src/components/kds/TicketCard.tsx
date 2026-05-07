'use client'
import { useState, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { formatDistanceToNowStrict } from 'date-fns'
import type { Order, OrderItem } from '../../lib/api'
import { useKdsActions } from '../../hooks/useKdsSocket'
import { useKdsStore } from '../../store/kds'
import { PhotoBumpModal } from './PhotoBumpModal'

const SOURCE_COLORS: Record<string, string> = {
  servd: 'bg-source-servd',
  ubereats: 'bg-source-ubereats',
  doordash: 'bg-source-doordash',
  deliveroo: 'bg-source-deliveroo',
  pos: 'bg-source-pos',
  cart: 'bg-source-cart',
  manual: 'bg-source-manual',
}

const SOURCE_LABELS: Record<string, string> = {
  servd: 'DIRECT',
  ubereats: 'UBER',
  doordash: 'DD',
  deliveroo: 'ROOOO',
  pos: 'POS',
  cart: 'CART',
  manual: 'MANUAL',
}

const UR = {
  ago: 'پہلے',
  hold: '⏸',
  bump: '✓',
  recall: 'واپس',
  fire: 'شروع',
  course: 'کورس',
  notes: 'نوٹ',
  allClear: 'سب ٹھیک ✓',
  instructions: 'ہدایات',
  close: 'بند',
  noInstructions: 'کوئی ہدایات نہیں',
}

function getAgeClass(placedAt: string): string {
  const ageMs = Date.now() - new Date(placedAt).getTime()
  const minutes = ageMs / 60_000
  if (minutes < 8) return 'age-fresh'
  if (minutes < 15) return 'age-warm'
  return 'age-hot'
}

function formatPKR(cents: number): string {
  return `PKR ${(cents / 100).toFixed(0)}`
}

// ─── Recipe data fetched on modal open ───────────────────────────────────────

const API_URL = typeof window !== 'undefined'
  ? (process.env['NEXT_PUBLIC_API_URL'] ?? 'http://localhost:3001')
  : 'http://localhost:3001'

interface RecipeData {
  steps:        string | null
  stepsUrdu:    string | null
  notes:        string | null
  servings:     number
  laborMinutes: number
  ingredients:  Array<{ id: string; name: string; quantity: number; unit: string; notes: string | null }>
}

async function fetchRecipe(menuItemId: string): Promise<RecipeData | null> {
  const token = typeof window !== 'undefined' ? localStorage.getItem('servd_token') : null
  const res = await fetch(`${API_URL}/api/v1/recipes/by-item/${menuItemId}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  })
  if (!res.ok || res.status === 204) return null
  const data = await res.json() as RecipeData | null
  return data
}

// ─── Instruction modal ────────────────────────────────────────────────────────

interface InstructionModalProps {
  item: OrderItem
  isUrdu: boolean
  onClose: () => void
}

function InstructionModal({ item, isUrdu, onClose }: InstructionModalProps) {
  const [recipe, setRecipe] = useState<RecipeData | null | 'loading'>('loading')

  const displayName = (isUrdu && item.menuItem?.nameUrdu) ? item.menuItem.nameUrdu : item.name
  const imageUrl = item.menuItem?.imageUrl

  // Fetch recipe on mount
  useEffect(() => {
    if (!item.menuItemId) { setRecipe(null); return }
    fetchRecipe(item.menuItemId)
      .then(setRecipe)
      .catch(() => setRecipe(null))
  }, [item.menuItemId])

  // Close on Escape
  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  // Resolve steps: prefer recipe steps, fall back to MenuItem.instructions
  const steps = recipe !== 'loading' && recipe !== null
    ? (isUrdu ? (recipe.stepsUrdu || recipe.steps) : (recipe.steps || recipe.stepsUrdu))
    : (isUrdu
        ? (item.menuItem?.instructionsUrdu || item.menuItem?.instructions)
        : (item.menuItem?.instructions || item.menuItem?.instructionsUrdu))

  const modal = (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 overflow-y-auto"
      onClick={onClose}
    >
      <div
        className="relative w-full max-w-lg rounded-2xl bg-kds-card border border-kds-border overflow-hidden shadow-2xl my-4"
        dir={isUrdu ? 'rtl' : 'ltr'}
        style={isUrdu ? { fontFamily: 'sans-serif' } : undefined}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Image */}
        {imageUrl && (
          <img src={imageUrl} alt={displayName} className="w-full h-48 object-cover" />
        )}
        {!imageUrl && (
          <div className="w-full h-24 bg-kds-border/30 flex items-center justify-center text-4xl">🍽</div>
        )}

        {/* Content */}
        <div className="p-5 space-y-4">
          <div>
            <h2 className="text-2xl font-black text-kds-text">{displayName}</h2>
            <p className="text-sm text-kds-subtext">×{item.quantity}</p>
          </div>

          {/* Steps / Instructions */}
          <div>
            <h3 className="text-xs font-bold uppercase tracking-wider text-kds-subtext mb-2">
              {isUrdu ? 'طریقہ کار' : 'Assembly / Cooking Steps'}
            </h3>
            {recipe === 'loading' ? (
              <p className="text-sm text-kds-subtext animate-pulse">Loading…</p>
            ) : steps ? (
              <p className="text-base text-kds-text leading-relaxed whitespace-pre-wrap">{steps}</p>
            ) : (
              <p className="text-sm text-kds-subtext italic">
                {isUrdu ? 'کوئی ہدایات نہیں' : 'No steps added yet — add them in Recipe Costing'}
              </p>
            )}
          </div>

          {/* Ingredients from recipe */}
          {recipe !== 'loading' && recipe !== null && recipe.ingredients.length > 0 && (
            <div>
              <h3 className="text-xs font-bold uppercase tracking-wider text-kds-subtext mb-2">
                {isUrdu ? 'اجزاء' : 'Ingredients'}
              </h3>
              <div className="space-y-1.5">
                {recipe.ingredients.map((ing) => (
                  <div key={ing.id} className="flex items-center justify-between text-sm">
                    <span className="text-kds-text font-medium">{ing.name}</span>
                    <span className="text-kds-subtext">
                      {ing.quantity % 1 === 0 ? ing.quantity : ing.quantity.toFixed(2)} {ing.unit}
                    </span>
                  </div>
                ))}
              </div>
              {recipe.servings > 1 && (
                <p className="text-xs text-kds-subtext mt-2">
                  {isUrdu ? `(${recipe.servings} حصوں کے لیے)` : `(yields ${recipe.servings} portions)`}
                </p>
              )}
            </div>
          )}
        </div>

        {/* Close button */}
        <button
          onClick={onClose}
          className="absolute top-3 right-3 rounded-full bg-black/40 w-10 h-10 flex items-center justify-center text-white text-xl hover:bg-black/60 transition-colors"
          aria-label="Close"
        >
          ✕
        </button>
      </div>
    </div>
  )

  return createPortal(modal, document.body)
}

// ─── TicketCard ───────────────────────────────────────────────────────────────

interface TicketCardProps {
  order: Order
  stationId?: string
  compact?: boolean
}

export function TicketCard({ order, stationId, compact }: TicketCardProps) {
  const [age, setAge] = useState(() => formatDistanceToNowStrict(new Date(order.placedAt)))
  const [ageClass, setAgeClass] = useState(() => getAgeClass(order.placedAt))
  const actions = useKdsActions()
  const lang = useKdsStore((s) => s.lang)
  const showImages = useKdsStore((s) => s.showImages)

  useEffect(() => {
    const interval = setInterval(() => {
      setAge(formatDistanceToNowStrict(new Date(order.placedAt)))
      setAgeClass(getAgeClass(order.placedAt))
    }, 30_000)
    return () => clearInterval(interval)
  }, [order.placedAt])

  const visibleItems = stationId
    ? order.items.filter((i) => i.stationId === stationId && !['bumped', 'voided'].includes(i.status))
    : order.items.filter((i) => !['bumped', 'voided'].includes(i.status))

  if (visibleItems.length === 0) return null

  const sourceLabel = SOURCE_LABELS[order.source] ?? order.source.toUpperCase()
  const sourceBg = SOURCE_COLORS[order.source] ?? 'bg-gray-600'
  const isUrdu = lang === 'ur'

  return (
    <div
      className={`ticket-card ${ageClass} animate-slide-in`}
      dir={isUrdu ? 'rtl' : 'ltr'}
      style={isUrdu ? { fontFamily: 'sans-serif' } : undefined}
    >
      {/* Header */}
      <div className="mb-3 flex items-start justify-between gap-2">
        <div className="flex items-center gap-2 flex-wrap">
          <span className={`source-badge text-white ${sourceBg}`}>{sourceLabel}</span>
          {order.table && (
            <span className="rounded bg-kds-border px-2 py-0.5 text-xs font-bold text-kds-text">
              {order.table.label}
            </span>
          )}
          {order.customerName && (
            <span className="text-sm text-kds-subtext">{order.customerName}</span>
          )}
        </div>
        <div className="text-right shrink-0">
          <div className="text-xs text-kds-subtext">
            {age} {isUrdu ? UR.ago : 'ago'}
          </div>
          {!compact && (
            <div className="text-xs text-kds-subtext">{formatPKR(order.totalCents)}</div>
          )}
        </div>
      </div>

      {/* Items */}
      <div className="space-y-2">
        {visibleItems.map((item) => (
          <TicketItem
            key={item.id}
            item={item}
            compact={compact ?? false}
            isUrdu={isUrdu}
            showImages={showImages}
            onBump={() => actions.bump(item.id)}
            onHold={() => actions.hold(item.id)}
            onRecall={() => actions.recall(item.id)}
            onFire={() => actions.fire(item.id)}
          />
        ))}
      </div>

      {/* Notes */}
      {order.items.some((i) => i.notes) && (
        <div className="mt-2 rounded bg-kds-border/50 px-2 py-1 text-xs text-kds-amber">
          {order.items.filter((i) => i.notes).map((i) => (
            <div key={i.id}>
              ⚠ {isUrdu && i.menuItem?.nameUrdu ? i.menuItem.nameUrdu : i.name}: {i.notes}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ─── TicketItem ───────────────────────────────────────────────────────────────

interface TicketItemProps {
  item: OrderItem
  compact: boolean
  isUrdu: boolean
  showImages: boolean
  onBump: () => Promise<unknown>
  onHold: () => Promise<unknown>
  onRecall: () => Promise<unknown>
  onFire: () => Promise<unknown>
}

function useCountdown(scheduledFireAt: string | null): string | null {
  const [, setTick] = useState(0)
  useEffect(() => {
    if (!scheduledFireAt) return
    const interval = setInterval(() => setTick((t) => t + 1), 1000)
    return () => clearInterval(interval)
  }, [scheduledFireAt])

  if (!scheduledFireAt) return null
  const diffMs = new Date(scheduledFireAt).getTime() - Date.now()
  if (diffMs <= 0) return null
  const totalSec = Math.ceil(diffMs / 1000)
  const m = Math.floor(totalSec / 60)
  const s = totalSec % 60
  return `${m}:${s.toString().padStart(2, '0')}`
}

function TicketItem({ item, compact, isUrdu, showImages, onBump, onHold, onRecall, onFire }: TicketItemProps) {
  const [loading, setLoading] = useState(false)
  const [showInstructions, setShowInstructions] = useState(false)
  const [showPhotoCapture, setShowPhotoCapture] = useState(false)

  const fireCountdown = useCountdown(item.status === 'pending' ? item.scheduledFireAt : null)

  async function handle(action: () => Promise<unknown>) {
    if (loading) return
    setLoading(true)
    try { await action() }
    finally { setLoading(false) }
  }

  async function handleBump() {
    await handle(onBump)
    setShowPhotoCapture(true) // prompt for plating photo after bump
  }

  const statusColor =
    item.status === 'preparing' ? 'text-kds-amber' :
    item.status === 'ready' ? 'text-kds-green' :
    item.status === 'held' ? 'text-kds-red' :
    'text-kds-text'

  const displayName = (isUrdu && item.menuItem?.nameUrdu) ? item.menuItem.nameUrdu : item.name
  const imageUrl = item.menuItem?.imageUrl
  const hasInstructions = !!(item.menuItem?.instructions || item.menuItem?.instructionsUrdu)

  return (
    <>
      <div className={`flex items-start gap-3 ${loading ? 'opacity-50' : ''}`}>
        {/* Item image — only when showImages is on */}
        {showImages && imageUrl && (
          <img
            src={imageUrl}
            alt={displayName}
            className="h-14 w-14 shrink-0 rounded-lg object-cover border border-kds-border cursor-pointer"
            onClick={() => setShowInstructions(true)}
          />
        )}
        {showImages && !imageUrl && (
          <div
            className="h-14 w-14 shrink-0 rounded-lg border border-kds-border bg-kds-border/30 flex items-center justify-center text-2xl cursor-pointer"
            onClick={() => setShowInstructions(true)}
          >
            🍽
          </div>
        )}

        <div className="flex-1 min-w-0">
          <div className="flex items-baseline gap-2 flex-wrap">
            <span className="text-lg font-bold text-kds-text">×{item.quantity}</span>
            {/* Tap item name to open instruction modal */}
            <button
              className={`font-semibold text-left ${statusColor} ${hasInstructions ? 'underline decoration-dotted underline-offset-2 cursor-pointer' : 'cursor-default'}`}
              onClick={() => setShowInstructions(true)}
              title={hasInstructions ? (isUrdu ? 'ہدایات دیکھیں' : 'View instructions') : undefined}
            >
              {displayName}
            </button>
            {item.course != null && (
              <span className="text-xs text-kds-subtext">
                {isUrdu ? UR.course : 'Course'} {item.course}
              </span>
            )}
            {fireCountdown && (
              <span className="text-xs font-mono font-bold text-kds-blue rounded bg-kds-blue/10 px-1.5 py-0.5">
                ⏱ {isUrdu ? 'فائر' : 'fires in'} {fireCountdown}
              </span>
            )}
          </div>
          {item.modifiers.length > 0 && (
            <div className="mt-0.5 space-y-0.5" style={{ marginInlineStart: '1.5rem' }}>
              {item.modifiers.map((mod) => (
                <div key={mod.id} className="text-sm text-kds-subtext">+ {mod.name}</div>
              ))}
            </div>
          )}
        </div>

        {/* Action buttons */}
        {!compact && (
          <div className="flex shrink-0 gap-1">
            {item.status === 'held' ? (
              <button
                onClick={() => handle(onRecall)}
                className="kds-btn-warning px-3 text-sm"
                aria-label="Recall item"
              >
                {isUrdu ? UR.recall : 'Recall'}
              </button>
            ) : (
              <>
                {item.status === 'pending' && (
                  <button
                    onClick={() => handle(onFire)}
                    className="kds-btn-ghost px-3 text-sm"
                    aria-label="Fire item"
                  >
                    {isUrdu ? UR.fire : 'Fire'}
                  </button>
                )}
                <button
                  onClick={() => handle(onHold)}
                  className="kds-btn-warning h-12 w-12"
                  aria-label="Hold item"
                >
                  {UR.hold}
                </button>
                <button
                  onClick={handleBump}
                  className="kds-btn-primary h-12 w-12"
                  aria-label="Bump item"
                >
                  {UR.bump}
                </button>
              </>
            )}
          </div>
        )}
      </div>

      {showInstructions && (
        <InstructionModal
          item={item}
          isUrdu={isUrdu}
          onClose={() => setShowInstructions(false)}
        />
      )}
      {showPhotoCapture && (
        <PhotoBumpModal
          itemId={item.id}
          itemName={displayName}
          isUrdu={isUrdu}
          onClose={() => setShowPhotoCapture(false)}
        />
      )}
    </>
  )
}
