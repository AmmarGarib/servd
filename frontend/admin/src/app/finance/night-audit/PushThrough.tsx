'use client'
// CEO-only "push through": tick every block, give a reason (>= 10 chars),
// then the caller sends acknowledge { keys, reason }. Same UX as Period close.
import { Button, CheckLabel, FieldLabel, Textarea } from '@/components/finance/ui'
import { useState } from 'react'
import { fmtPkr } from '../../../lib/money'
import { type CloseProblem, MIN_REASON } from './types'

export function PushThrough({ blocks, busy, label, onGo }: {
  blocks: CloseProblem[]
  busy: boolean
  label: string
  onGo: (ack: { keys: string[]; reason: string }) => void
}) {
  const [open, setOpen] = useState(false)
  const [ticked, setTicked] = useState<Set<string>>(new Set())
  const [reason, setReason] = useState('')
  const keys = blocks.map((b) => b.key)
  const all = keys.length > 0 && keys.every((k) => ticked.has(k))
  const ok = all && reason.trim().length >= MIN_REASON

  if (!open) {
    return <Button variant="secondary" type="button" onClick={() => setOpen(true)}>Push through (CEO)</Button>
  }
  return (
    <div className="rounded-lg border border-s-border p-3 space-y-2">
      <p className="text-xs font-semibold text-s-text">Push through over these blocks (CEO, audited, raised in Exceptions)</p>
      {blocks.map((b) => (
        <CheckLabel key={b.key} className="flex items-start gap-2 text-xs text-s-text">
          <input type="checkbox" className="accent-primary mt-0.5" checked={ticked.has(b.key)}
            onChange={() => setTicked((p) => { const n = new Set(p); if (n.has(b.key)) n.delete(b.key); else n.add(b.key); return n })} />
          <span>{b.title} — {b.count}{b.cents ? ` · ${fmtPkr(b.cents)}` : ''}</span>
        </CheckLabel>
      ))}
      <FieldLabel htmlFor="na-ack-reason" className="block">Reason (at least {MIN_REASON} characters)</FieldLabel>
      <Textarea id="na-ack-reason" rows={2} value={reason} onChange={(e) => setReason(e.target.value)}
        className="w-full" />
      <p className={`text-xs ${reason.trim().length >= MIN_REASON ? 'text-success' : 'text-s-muted'}`}>{reason.trim().length} / {MIN_REASON}</p>
      <div className="flex gap-2">
        <Button type="button" disabled={!ok || busy} onClick={() => onGo({ keys, reason: reason.trim() })}>
          {busy ? 'Working…' : label}
        </Button>
        <Button variant="secondary" type="button" onClick={() => setOpen(false)}>Cancel</Button>
      </div>
      {!all && <p className="text-xs text-s-muted">Tick every block to push the day through.</p>}
    </div>
  )
}
