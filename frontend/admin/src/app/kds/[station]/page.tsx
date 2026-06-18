'use client'
import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useParams } from 'next/navigation'
import Link from 'next/link'
import { formatDistanceToNowStrict } from 'date-fns'
import { api } from '../../../lib/api'
import { useKdsSocket } from '../../../hooks/useKdsSocket'
import { useKdsStore } from '../../../store/kds'
import { KdsHeader } from '../../../components/kds/KdsHeader'
import { NewOrderFlash } from '../../../components/kds/NewOrderFlash'

// Recipe payload — matches /recipes/by-item/:menuItemId.
// Used by the per-card expand panel to show free-text + per-step
// instructions in the operator's chosen language with an optional photo.
interface RecipeData {
  steps:        string | null   // free-text English
  stepsUrdu:    string | null   // free-text Urdu
  notes:        string | null
  servings:     number
  laborMinutes: number
  ingredients:  Array<{ id: string; name: string; quantity: number; unit: string }>
  recipeSteps?: Array<{
    id: string; phase: string; ordinal: number
    instruction: string; instructionUrdu: string | null
    estimatedSeconds: number
    stationName: string | null
  }>
  menuItem?: { name: string; imageUrl: string | null }
}

/**
 * Per-station KDS — only what THIS station needs to cook right now.
 *
 * Two data sources unioned by /expo/station/:id/queue:
 *
 *   1. Step-level tickets: items whose recipe has steps configured. Each
 *      card is one step (e.g. "Sear steak" on Grill, "Boil rice" on Rice).
 *      Bumping fires the cascade — downstream steps appear on their station
 *      automatically.
 *
 *   2. Legacy items: menu items that don't have recipe steps yet still flow
 *      through the old per-item routing. Bumping uses the existing item
 *      status endpoint. As recipes get their steps, items naturally migrate.
 */

type FulfilmentType = 'dine_in' | 'takeout' | 'delivery'

// Loud per-card badge so the line cook sees plate-vs-package at a glance.
const FULFILMENT_META: Record<FulfilmentType, { emoji: string; label: string; short: string; accent: string; bg: string }> = {
  dine_in:  { emoji: '🍽',  label: 'Dine-in',  short: 'PLATE',    accent: '#22c55e', bg: 'rgba(34,197,94,0.12)' },
  takeout:  { emoji: '🥡', label: 'Takeout',  short: 'PACK',     accent: '#f59e0b', bg: 'rgba(245,158,11,0.12)' },
  delivery: { emoji: '🛵', label: 'Delivery', short: 'PACK+LBL', accent: '#ec4899', bg: 'rgba(236,72,153,0.12)' },
}

interface StepTicket {
  stepId:    string
  itemId:    string
  menuItemId: string | null   // null for custom-typed items; recipe lookup skipped
  itemName:  string
  qty:       number
  itemNotes: string | null
  status:    'preparing' | 'waiting'
  firedAt:   string | null
  instruction:      string
  instructionUrdu:  string | null
  phase:            string
  estimatedSeconds: number
  order: {
    id: string; customerName: string | null; source: string; placedAt: string
    fulfilmentType: FulfilmentType
    tableLabel: string | null
    concept: { name: string; slug: string }
  }
}

interface LegacyTicket {
  itemId:    string
  menuItemId: string | null
  itemName:  string
  qty:       number
  itemNotes: string | null
  status:    string
  firedAt:   string | null
  order: {
    id: string; customerName: string | null; source: string; placedAt: string
    fulfilmentType: FulfilmentType
    tableLabel: string | null
    concept: { name: string; slug: string }
  }
}

interface QueuePayload {
  steps:  StepTicket[]
  legacy: LegacyTicket[]
}

export default function StationKdsPage() {
  const { station } = useParams<{ station: string }>()
  const qc = useQueryClient()
  // Subscribe to socket events for live cascade updates.
  useKdsSocket({ stationId: station, role: 'kitchen' })

  // ── Display mode (global, persisted by useKdsStore) ──────────────────
  // - lang  = 'en' | 'ur'  → swaps instruction text + recipe steps to Urdu
  // - showImages           → renders MenuItem.imageUrl in the expanded panel
  //                          when on; pure-text otherwise (older iPad screens)
  const lang        = useKdsStore((s) => s.lang)
  const setLang     = useKdsStore((s) => s.setLang)
  const showImages  = useKdsStore((s) => s.showImages)
  const setShowImg  = useKdsStore((s) => s.setShowImages)
  const isUrdu      = lang === 'ur'

  // Which card is currently expanded for full instructions. Only one card can
  // be open at a time so the cook can focus.
  const [expandedId, setExpandedId] = useState<string | null>(null)

  const { data, isLoading } = useQuery<QueuePayload>({
    queryKey: ['station-queue', station],
    queryFn:  () => api.get<QueuePayload>(`/expo/station/${station}/queue`),
    refetchInterval: 5_000,
    staleTime: 2_000,
  })

  const bumpStep = useMutation({
    mutationFn: (stepId: string) => api.post(`/expo/steps/${stepId}/bump`, {}),
    onSuccess:  () => qc.invalidateQueries({ queryKey: ['station-queue', station] }),
  })

  const bumpLegacy = useMutation({
    mutationFn: (itemId: string) => api.patch(`/order-items/${itemId}/status`, { status: 'bumped' }),
    onSuccess:  () => qc.invalidateQueries({ queryKey: ['station-queue', station] }),
  })

  const steps = data?.steps ?? []
  const legacy = data?.legacy ?? []
  const total = steps.filter((s) => s.status === 'preparing').length + legacy.length
  const waitingCount = steps.filter((s) => s.status === 'waiting').length

  // Split into "ready to cook" (preparing/legacy) and "on deck" (waiting on deps)
  const cooking: Array<StepTicket | { __legacy: true } & LegacyTicket> = [
    ...steps.filter((s) => s.status === 'preparing'),
    ...legacy.map((l) => ({ __legacy: true as const, ...l })),
  ]
  const waiting = steps.filter((s) => s.status === 'waiting')

  return (
    <div className="flex h-screen flex-col bg-kds-bg">
      <NewOrderFlash />
      <div className="shrink-0 px-4 pt-3 pb-1 flex items-center justify-between gap-3 flex-wrap">
        <Link href="/expo" className="text-sm text-gray-500 hover:text-gray-300 flex items-center gap-1 transition-colors">
          ← Expo
        </Link>
        <div className="flex items-center gap-2">
          {/* Display toggles — global to the KDS, persisted. The cook picks
              their preferred language (EN / Urdu) and whether picture mode
              shows photos in the expanded instruction panel. */}
          <div className="flex items-center gap-0.5 rounded-lg p-0.5"
            style={{ background: 'rgba(255,255,255,0.05)' }}>
            {(['en', 'ur'] as const).map((opt) => (
              <button key={opt} onClick={() => setLang(opt)}
                className="px-2 py-1 text-[11px] font-bold rounded-md transition-colors"
                style={lang === opt
                  ? { background: 'rgba(0,212,177,0.18)', color: '#00D4B1' }
                  : { color: 'rgba(255,255,255,0.55)' }}>
                {opt === 'en' ? 'EN' : 'اردو'}
              </button>
            ))}
          </div>
          <button onClick={() => setShowImg(!showImages)}
            title={showImages ? 'Hide photos' : 'Show photos'}
            className="px-2 py-1 text-[11px] font-bold rounded-md transition-colors"
            style={showImages
              ? { background: 'rgba(99,102,241,0.18)', color: '#A5B4FC' }
              : { background: 'rgba(255,255,255,0.05)', color: 'rgba(255,255,255,0.55)' }}>
            {showImages ? '🖼 Pics on' : '🖼 Pics off'}
          </button>
          {waitingCount > 0 && (
            <span className="text-xs font-bold rounded-full px-2.5 py-1"
              style={{ background: 'rgba(99,102,241,0.12)', color: '#A5B4FC' }}>
              {waitingCount} on deck
            </span>
          )}
        </div>
      </div>
      <KdsHeader title={`Station: ${station.slice(0, 8)}`} stationId={station} />

      <div className="flex-1 overflow-y-auto p-4 space-y-6">
        {/* Cooking right now */}
        <section>
          <p className="text-[10px] uppercase tracking-[0.2em] font-black text-kds-subtext mb-3">
            Cooking now ({cooking.length})
          </p>

          {isLoading && <p className="text-sm text-kds-subtext">Loading…</p>}

          {!isLoading && cooking.length === 0 && (
            <div className="rounded-2xl p-12 text-center"
              style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.05)' }}>
              <p className="text-4xl mb-2">✓</p>
              <p className="text-base font-bold text-kds-text">All clear</p>
              <p className="text-xs text-kds-subtext mt-1">New tickets will appear here when expo fires.</p>
            </div>
          )}

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5 gap-3">
            {cooking.map((t) => {
              const isLegacy = '__legacy' in t
              const id = isLegacy ? t.itemId : t.stepId
              const onBump = () => isLegacy ? bumpLegacy.mutate(t.itemId) : bumpStep.mutate(t.stepId)
              const pending = isLegacy
                ? bumpLegacy.isPending && bumpLegacy.variables === t.itemId
                : bumpStep.isPending && bumpStep.variables === t.stepId
              const elapsed = t.firedAt
                ? formatDistanceToNowStrict(new Date(t.firedAt), { addSuffix: false })
                : 'just now'
              const eta = !isLegacy ? (t as StepTicket).estimatedSeconds : 0
              const fm = FULFILMENT_META[t.order.fulfilmentType] ?? FULFILMENT_META.dine_in
              const expanded = expandedId === id
              const stepInstruction = !isLegacy
                ? (isUrdu && (t as StepTicket).instructionUrdu
                    ? (t as StepTicket).instructionUrdu
                    : (t as StepTicket).instruction)
                : null
              return (
                <div key={id} className="rounded-2xl relative overflow-hidden"
                  style={{ background: '#1f2230', border: `2px solid ${fm.accent}55` }}
                  dir={isUrdu ? 'rtl' : 'ltr'}>
                  {/* Card body — clickable, toggles the instruction panel.
                      The Bump button is outside this surface so it doesn't
                      accidentally trigger an expand. */}
                  <button
                    onClick={() => setExpandedId(expanded ? null : id)}
                    className="w-full text-left p-4 cursor-pointer hover:bg-white/[0.02] transition-colors">
                    {/* Loud fulfilment badge — first thing the cook sees */}
                    <div className="absolute -top-2 left-3 px-2 py-0.5 rounded-md text-[10px] font-black uppercase tracking-[0.15em]"
                      style={{ background: fm.bg, color: fm.accent, border: `1px solid ${fm.accent}50` }}>
                      {fm.emoji} {fm.short}
                      {t.order.tableLabel && <span className="ml-1 opacity-80">· {t.order.tableLabel}</span>}
                    </div>
                    <div className="flex items-center justify-between mb-2 mt-1 text-[10px] uppercase tracking-wider font-bold">
                      <span className="text-kds-subtext">{t.order.concept.name} · {t.order.source}</span>
                      <span className="text-kds-amber">{elapsed}</span>
                    </div>
                    <p className="text-lg font-black text-kds-text leading-tight mb-1">
                      {t.qty > 1 && <span className="text-kds-amber mr-1">{t.qty}×</span>}
                      {t.itemName}
                    </p>
                    {stepInstruction && (
                      <p className="text-sm font-semibold mt-2 leading-snug" style={{ color: '#5EEAD4' }}>
                        → {stepInstruction}
                      </p>
                    )}
                    {t.itemNotes && (
                      <p className="text-xs italic mt-1.5" style={{ color: '#FCD34D' }}>
                        ⚠ {t.itemNotes}
                      </p>
                    )}
                    <p className="text-[11px] text-kds-subtext mt-2">
                      {t.order.customerName ?? (isUrdu ? 'مہمان' : 'Walk-in')} · #{t.order.id.slice(-5).toUpperCase()}
                    </p>
                    {eta > 0 && (
                      <p className="text-[10px] text-kds-subtext mt-1">
                        {isUrdu ? 'ہدف' : 'Target'}: {Math.round(eta)}s
                      </p>
                    )}
                    <p className="text-[10px] text-kds-subtext/60 mt-2 italic">
                      {expanded ? (isUrdu ? '▲ بند کریں' : '▲ Hide instructions') : (isUrdu ? '▼ ہدایات' : '▼ Tap for full instructions')}
                    </p>
                  </button>

                  {/* Expanded instruction panel — recipe steps in chosen
                      language, item image when showImages is on. Recipe is
                      fetched on first expand. */}
                  {expanded && (
                    <StationInstructionPanel
                      menuItemId={t.menuItemId}
                      itemName={t.itemName}
                      isUrdu={isUrdu}
                      showImages={showImages}
                    />
                  )}

                  {/* Bump — always visible at the bottom, never inside the
                      clickable expand surface. */}
                  <div className="p-4 pt-0">
                    <button onClick={onBump} disabled={pending}
                      className="w-full rounded-xl py-3 text-base font-black transition-all disabled:opacity-40"
                      style={{ background: 'linear-gradient(135deg, #00D4B1 0%, #6366F1 100%)', color: '#000' }}>
                      {pending ? (isUrdu ? 'مکمل ہو رہا ہے…' : 'Bumping…') : (isUrdu ? 'مکمل ✓' : 'Bump ✓')}
                    </button>
                  </div>
                </div>
              )
            })}
          </div>
        </section>

        {/* Waiting (step deps not yet clear) */}
        {waiting.length > 0 && (
          <section>
            <p className="text-[10px] uppercase tracking-[0.2em] font-black text-kds-subtext mb-3">
              On deck — waiting on prior steps ({waiting.length})
            </p>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5 gap-3">
              {waiting.map((t) => {
                const fm = FULFILMENT_META[t.order.fulfilmentType] ?? FULFILMENT_META.dine_in
                return (
                  <div key={t.stepId} className="rounded-2xl p-4 opacity-50"
                    style={{ background: 'rgba(255,255,255,0.02)', border: '1px dashed rgba(255,255,255,0.08)' }}>
                    <p className="text-[10px] uppercase tracking-wider font-bold mb-2"
                      style={{ color: fm.accent }}>
                      {fm.emoji} {fm.short} · {t.order.concept.name} · waiting
                    </p>
                    <p className="text-base font-bold text-kds-text/70 leading-tight">
                      {t.qty > 1 && <span className="text-kds-subtext mr-1">{t.qty}×</span>}
                      {t.itemName}
                    </p>
                    <p className="text-sm font-semibold mt-2 text-kds-subtext italic">
                      → {t.instruction}
                    </p>
                  </div>
                )
              })}
            </div>
          </section>
        )}

        {/* Footer total */}
        <p className="text-center text-xs text-kds-subtext pt-2">
          {total} active · auto-refreshes every 5s
        </p>
      </div>
    </div>
  )
}

// ─── StationInstructionPanel ───────────────────────────────────────────────
//
// Expanded body that appears when the cook taps a card. Fetches the recipe
// for the item's menu-item id and renders the full step list in the chosen
// language. When showImages is on, the menu item's photo is shown across the
// top for picture-mode kitchens. Cooks who can't read either language can
// still cook off the photo + recipe ingredient list.

function StationInstructionPanel({
  menuItemId, itemName, isUrdu, showImages,
}: {
  menuItemId: string | null
  itemName:   string
  isUrdu:     boolean
  showImages: boolean
}) {
  const { data, isLoading } = useQuery<RecipeData | null>({
    queryKey: ['recipe-by-item', menuItemId],
    queryFn:  () => menuItemId ? api.get<RecipeData | null>(`/recipes/by-item/${menuItemId}`) : Promise.resolve(null),
    enabled:  !!menuItemId,
    staleTime: 5 * 60_000,
  })

  if (!menuItemId) {
    return (
      <div className="px-4 pb-4 border-t border-white/[0.06] pt-3">
        <p className="text-xs italic text-kds-subtext">
          {isUrdu ? 'یہ ایک حسبِ ضرورت آرڈر ہے — کوئی ترکیب دستیاب نہیں۔' : 'Custom item — no recipe on file.'}
        </p>
      </div>
    )
  }

  if (isLoading) {
    return (
      <div className="px-4 pb-4 border-t border-white/[0.06] pt-3">
        <p className="text-xs text-kds-subtext animate-pulse">
          {isUrdu ? 'لوڈ ہو رہا ہے…' : 'Loading recipe…'}
        </p>
      </div>
    )
  }

  if (!data) {
    return (
      <div className="px-4 pb-4 border-t border-white/[0.06] pt-3">
        <p className="text-xs italic text-kds-subtext">
          {isUrdu ? 'اس آئٹم کی ترکیب ابھی شامل نہیں کی گئی۔' : 'No recipe configured yet — add one in /accounting/recipes.'}
        </p>
      </div>
    )
  }

  // Prefer free-text recipe steps in the chosen language. If only the other
  // language is filled in, fall back to it so the cook gets *something*.
  const freeText = isUrdu
    ? (data.stepsUrdu || data.steps)
    : (data.steps || data.stepsUrdu)

  return (
    <div className="border-t border-white/[0.06] bg-black/30 p-4 space-y-3 text-sm"
      dir={isUrdu ? 'rtl' : 'ltr'}>
      {/* Photo — picture mode for kitchens that work off the photo */}
      {showImages && data.menuItem?.imageUrl && (
        <img
          src={data.menuItem.imageUrl}
          alt={itemName}
          className="w-full h-40 object-cover rounded-lg border border-white/[0.06]"
        />
      )}

      {/* Per-step recipe (structured) — preferred over free-text when present */}
      {data.recipeSteps && data.recipeSteps.length > 0 ? (
        <div>
          <p className="text-[10px] font-black uppercase tracking-wider text-kds-subtext mb-2">
            {isUrdu ? 'ترکیب' : 'Recipe steps'}
          </p>
          <ol className="space-y-1.5">
            {data.recipeSteps.map((s, idx) => {
              const text = isUrdu ? (s.instructionUrdu || s.instruction) : s.instruction
              return (
                <li key={s.id} className="flex items-start gap-2.5 text-kds-text leading-snug">
                  <span className="shrink-0 h-5 w-5 rounded-full bg-white/10 text-[10px] font-black flex items-center justify-center mt-0.5">
                    {idx + 1}
                  </span>
                  <div className="flex-1 min-w-0">
                    <p className="text-[13px]">{text}</p>
                    <p className="text-[10px] text-kds-subtext mt-0.5">
                      {s.stationName ?? '—'} · {s.estimatedSeconds}s
                    </p>
                  </div>
                </li>
              )
            })}
          </ol>
        </div>
      ) : freeText ? (
        <div>
          <p className="text-[10px] font-black uppercase tracking-wider text-kds-subtext mb-2">
            {isUrdu ? 'تیاری' : 'Method'}
          </p>
          <p className="text-[13px] text-kds-text whitespace-pre-wrap leading-snug">{freeText}</p>
        </div>
      ) : (
        <p className="text-xs italic text-kds-subtext">
          {isUrdu ? 'کوئی ہدایات نہیں — کک یاد سے بنائیں گے۔' : 'No instructions on file — cook from memory.'}
        </p>
      )}

      {/* Ingredients — handy for the cook to double-check mise en place */}
      {data.ingredients.length > 0 && (
        <div>
          <p className="text-[10px] font-black uppercase tracking-wider text-kds-subtext mb-1.5">
            {isUrdu ? 'اجزاء' : 'Ingredients'}
          </p>
          <div className="grid grid-cols-2 gap-x-3 gap-y-0.5">
            {data.ingredients.map((ing) => (
              <div key={ing.id} className="flex items-baseline justify-between text-[12px]">
                <span className="text-kds-text/85 truncate pr-2">{ing.name}</span>
                <span className="text-kds-subtext shrink-0 font-mono">
                  {ing.quantity % 1 === 0 ? ing.quantity : ing.quantity.toFixed(2)} {ing.unit}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {data.notes && (
        <p className="text-[11px] italic text-kds-amber/80 border-t border-white/[0.04] pt-2">
          ⚠ {data.notes}
        </p>
      )}
    </div>
  )
}
