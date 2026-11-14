'use client'
// The line that tells a person their unsaved typing was put back (lib/formDraft.ts), with "Discard draft".
// Shows nothing when the form opened clean.
import { useState } from 'react'
import type { FormDraft } from '../../lib/formDraft'

function when(at: number): string {
  const mins = Math.round((Date.now() - at) / 60_000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins} min ago`
  return new Date(at).toLocaleString('en-PK', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })
}

export function DraftNotice({ draft, className = '' }: { draft: FormDraft; className?: string }) {
  const [confirming, setConfirming] = useState(false)
  if (!draft.restoredAt) return null
  return (
    <div role="status" className={`flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border px-3 py-2 text-xs ${className}`}
      style={{ borderColor: 'rgb(var(--erp-success-rgb) / 0.35)', background: 'rgb(var(--erp-success-rgb) / 0.08)' }}>
      <span className="flex-1 min-w-[12rem] text-s-text">
        Your unsaved entry from {when(draft.restoredAt)} was put back. Nothing is saved until you submit it.
      </span>
      {confirming ? (
        <span className="flex items-center gap-2">
          <span className="text-s-muted">Throw it away?</span>
          <button type="button" className="font-semibold text-s-red underline" onClick={() => { setConfirming(false); draft.discard() }}>Yes, discard</button>
          <button type="button" className="text-s-muted underline" onClick={() => setConfirming(false)}>Keep it</button>
        </span>
      ) : (
        <button type="button" className="font-semibold underline" style={{ color: 'var(--erp-primary)' }} onClick={() => setConfirming(true)}>Discard draft</button>
      )}
    </div>
  )
}
