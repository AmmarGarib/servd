'use client'
import { useRef, useState } from 'react'
import { X } from 'lucide-react'
import type { MenuItem, ModifierGroup, Modifier } from '../../../lib/api'
import { fmtPkrWhole } from '../../../lib/money'
import { useDialog } from '../../ui/Modal'

// The modifier picker (moved here from app/pos/page.tsx unchanged in behaviour).
export function ModifierModal({ item, onConfirm, onClose }: {
  item: MenuItem
  onConfirm: (mods: Modifier[]) => void
  onClose: () => void
}) {
  const panelRef = useRef<HTMLDivElement>(null)
  useDialog(panelRef, { onClose })
  // F14: selections per group so minSelect / maxSelect are enforced.
  const [selectedByGroup, setSelectedByGroup] = useState<Record<string, Set<string>>>({})

  function toggle(groupId: string, modId: string, maxSelect: number) {
    setSelectedByGroup((prev) => {
      const current = new Set(prev[groupId] ?? [])
      if (current.has(modId)) {
        current.delete(modId)
      } else {
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

  const groupErrors: Record<string, string | null> = {}
  let canConfirm = true
  for (const g of item.modifierGroups ?? []) {
    const picked = selectedByGroup[g.id]?.size ?? 0
    const min = g.isRequired ? Math.max(g.minSelect ?? 0, 1) : 0
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

  const allMods = item.modifierGroups.flatMap((g: ModifierGroup) => g.modifiers)
  const pickedIds = new Set<string>()
  for (const set of Object.values(selectedByGroup)) for (const id of set) pickedIds.add(id)
  const pickedMods = allMods.filter((m: Modifier) => pickedIds.has(m.id))
  const runningTotalCents = item.priceCents + pickedMods.reduce((s: number, m: Modifier) => s + m.priceDeltaCents, 0)

  return (
    <div className="erp-kitchen-dark fixed inset-0 z-50 flex items-end justify-center bg-black/70 sm:items-center" role="presentation">
      <div ref={panelRef} role="dialog" aria-modal="true" aria-labelledby="modifier-modal-title"
        className="flex max-h-[90dvh] w-full max-w-md flex-col rounded-t-2xl bg-kds-card outline-none sm:rounded-2xl"
        style={{ overscrollBehavior: 'contain' }}>
        <div className="flex shrink-0 items-center justify-between border-b border-kds-border pl-5 pr-1">
          <h2 id="modifier-modal-title" className="py-3 text-lg font-bold text-kds-text">{item.name} — Options</h2>
          <button type="button" data-dialog-close onClick={onClose} aria-label="Close"
            className="flex h-11 w-11 items-center justify-center text-kds-subtext hover:text-kds-text"><X size={20} aria-hidden="true" /></button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 pt-4" style={{ overscrollBehavior: 'contain' }}>
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
                      {group.minSelect === group.maxSelect ? `pick ${group.minSelect}` : `${group.minSelect}–${group.maxSelect}`}
                    </p>
                  )}
                </div>
                <div className="grid grid-cols-2 gap-2">
                  {group.modifiers.map((mod: Modifier) => {
                    const isOn = picked?.has(mod.id) ?? false
                    return (
                      <button key={mod.id} type="button" aria-pressed={isOn} onClick={() => toggle(group.id, mod.id, max)}
                        className={`min-h-11 rounded-lg border px-3 py-2 text-left text-sm transition-colors ${
                          isOn ? 'border-kds-green bg-kds-green/20 text-kds-green' : 'border-kds-border text-kds-text hover:border-kds-subtext'
                        }`}>
                        <span>{mod.name}</span>
                        {mod.priceDeltaCents !== 0 && <span className="ml-1 text-kds-subtext">+{fmtPkrWhole(mod.priceDeltaCents)}</span>}
                      </button>
                    )
                  })}
                </div>
                {err && <p className="mt-1 text-xs font-semibold text-kds-amber">{err}</p>}
              </div>
            )
          })}
        </div>
        <div className="sticky bottom-0 flex shrink-0 gap-3 border-t border-kds-border bg-kds-card px-5 py-3">
          <button type="button" onClick={onClose} className="kds-btn-ghost min-h-11 flex-1 py-3">Cancel</button>
          <button type="button" onClick={() => canConfirm && onConfirm(pickedMods)} disabled={!canConfirm}
            className="kds-btn-primary flex-1 py-3 disabled:cursor-not-allowed disabled:opacity-40">
            Add to order · {fmtPkrWhole(runningTotalCents)}
          </button>
        </div>
      </div>
    </div>
  )
}
