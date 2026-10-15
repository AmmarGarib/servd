'use client'
// The two 409 dialogs of the Trash: a clash on restore (rename the field) and
// "still in use" on delete forever (what points at it).

import { useState } from 'react'
import { Modal } from '../ui/Modal'
import { FormField } from '../ui/FormField'
import type { ClashState } from './useTrashActions'
import type { TrashItem } from '../../lib/trash'

const input = 'w-full rounded-xl px-3 py-2 text-sm text-white/90 outline-none'
const inputStyle = { background: 'var(--bg)', border: '1px solid var(--border)' }

export function ClashDialog({ state, busy, onClose, onRestore }: {
  state: ClashState; busy: boolean; onClose: () => void
  onRestore: (rename: Record<string, string>) => void
}) {
  const { clash, message } = state
  const [value, setValue] = useState(clash.suggestion ?? '')
  return (
    <Modal title="Something live already uses this" onClose={onClose}
      footer={clash.renamable ? (
        <div className="flex justify-end gap-2">
          <button className="s-btn-ghost" onClick={onClose}>Cancel</button>
          <button className="s-btn-primary" disabled={busy || !value.trim() || value.trim() === clash.value}
            onClick={() => onRestore({ [clash.field]: value.trim() })}>Restore with new {clash.field}</button>
        </div>
      ) : (
        <div className="flex justify-end"><button className="s-btn-secondary" onClick={onClose}>Close</button></div>
      )}>
      <p className="text-sm text-white/70">{message}</p>
      {clash.renamable ? (
        <FormField label={`New ${clash.field}`} hint={`"${clash.value}" is taken. Pick another to restore this one beside it.`}>
          <input className={input} style={inputStyle} value={value} onChange={(e) => setValue(e.target.value)} />
        </FormField>
      ) : (
        <p className="text-xs text-white/50">This one cannot be renamed. Edit or delete the live one first, then restore.</p>
      )}
    </Modal>
  )
}

export function InUseDialog({ item, refs, onClose }: {
  item: TrashItem; refs: Array<{ label: string; count: number }>; onClose: () => void
}) {
  return (
    <Modal title="Still in use" onClose={onClose} footer={<div className="flex justify-end"><button className="s-btn-secondary" onClick={onClose}>Close</button></div>}>
      <p className="text-sm text-white/70">&ldquo;{item.title}&rdquo; is still referenced, so it cannot be erased. Archive it to tidy the list.</p>
      <ul className="text-sm space-y-1">
        {refs.map((r) => (
          <li key={r.label} className="flex justify-between gap-3 rounded-lg px-3 py-1.5" style={{ background: 'var(--elevated)' }}>
            <span className="text-white/80">{r.label}</span><span className="font-bold text-white/60">{r.count}</span>
          </li>
        ))}
      </ul>
    </Modal>
  )
}
