'use client'
import { useLens } from '../../hooks/useLens'

// Strip under the header while a head-office lens is on: you can look at the
// company, and changes go to its approvers as requests.
export function LensBanner() {
  const { lens, exitLens } = useLens()
  if (!lens) return null
  const through = lens.via.map((v) => v.name).filter(Boolean).join(', ') || 'head office'
  return (
    <div role="status" className="shrink-0 flex items-center gap-2 px-4 py-1.5 text-xs"
      style={{
        background: 'color-mix(in srgb, var(--erp-primary) 10%, transparent)',
        borderBottom: '1px solid color-mix(in srgb, var(--erp-primary) 35%, transparent)',
        color: 'var(--text)',
      }}>
      <span className="font-black uppercase tracking-wider" style={{ color: 'var(--erp-primary)' }}>Lens</span>
      <span className="min-w-0 flex-1">
        Viewing <strong>{lens.name}</strong> through {through} — you can look, and send changes for approval.
      </span>
      <button onClick={exitLens}
        className="shrink-0 rounded-lg px-2.5 py-1 text-[11px] font-bold"
        style={{ color: 'var(--erp-primary)', border: '1px solid color-mix(in srgb, var(--erp-primary) 40%, transparent)' }}>
        Exit
      </button>
    </div>
  )
}
