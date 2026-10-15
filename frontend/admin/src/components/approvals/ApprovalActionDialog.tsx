'use client'
// The panel under an inbox item when its button needs more than a click: a
// free-text field (action.input) and/or tick-boxes (action.options — a
// recharge run's "post in the open month", "I have read the warnings").
// It sends the module's own route as the item carries it; nothing is decided
// here. Ticked boxes go in the body as `field: true`.

import { useId, useRef, useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { api } from '../../lib/api'
import { Modal } from '../ui/Modal'
import type { ApprovalAction } from '../../app/ceo/approvalsData'

export function ApprovalActionDialog({ action, tenantId, warnings, onClose, onDone }: {
  action: ApprovalAction
  /** The item's company: pins the write so "All companies" view never asks. */
  tenantId: string | null
  /** The run's warnings, shown above the boxes. */
  warnings?: string | null
  onClose: () => void
  onDone: () => void
}) {
  const [text, setText] = useState('')
  const [ticked, setTicked] = useState<Record<string, boolean>>({})
  const [err, setErr] = useState<string | null>(null)

  const options = action.options ?? []
  // A box named acknowledge* is the "I have read it" tick: the button waits for it.
  const needsAck = options.filter((o) => o.field.startsWith('acknowledge'))
  const ackMissing = needsAck.some((o) => !ticked[o.field])

  const run = useMutation({
    mutationFn: () => {
      const body: Record<string, unknown> = { ...action.body }
      if (action.input && text.trim()) body[action.input.field] = text.trim()
      for (const o of options) if (ticked[o.field]) body[o.field] = true
      const extra = tenantId ? { tenantId } : undefined
      return action.method === 'PATCH' ? api.patch(action.path, body, extra) : api.post(action.path, body, extra)
    },
    onSuccess: () => { setErr(null); onDone() },
    onError: (e: Error) => setErr(e.message),
  })

  const blocked = run.isPending || ackMissing || (!!action.input?.required && !text.trim())
  const danger = action.kind === 'reject'
  const taRef = useRef<HTMLTextAreaElement>(null)
  const noteId = useId()
  const submit = () => { if (!blocked) run.mutate() }

  return (
    <Modal title={action.label} onClose={onClose} initialFocusRef={action.input ? taRef : undefined}
      footer={
        <div className="flex items-center gap-2">
          <button disabled={blocked} onClick={submit}
            className="rounded-lg px-3 py-2 text-xs font-black disabled:opacity-50"
            style={danger
              ? { background: 'var(--erp-danger)', color: 'var(--erp-on-secondary)' }
              : { background: 'var(--erp-primary)', color: 'var(--erp-on-primary)' }}>
            {run.isPending ? 'Working…' : action.label}
          </button>
          <button onClick={onClose} className="text-xs font-bold text-white/60 px-3 py-2">Cancel</button>
          {action.input && <span className="ml-auto hidden sm:block text-[10px] text-white/35">Ctrl+Enter to send</span>}
        </div>
      }>
      <div onKeyDown={(e) => {
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); submit() }
      }}>
        {warnings && (
          <p className="mb-2 text-xs rounded-lg px-2 py-1.5" style={{ color: 'var(--erp-warning)', border: '1px solid var(--erp-warning)' }}>
            {warnings}
          </p>
        )}
        {action.input && (
          <>
            <label htmlFor={noteId} className="text-[11px] font-bold text-white/60">{action.input.label}</label>
            <textarea id={noteId} ref={taRef} value={text} onChange={(e) => setText(e.target.value)} rows={3}
              aria-required={action.input.required ? true : undefined}
              className="mt-1 w-full rounded-lg px-2 py-1.5 text-sm"
              style={{ background: 'var(--surface)', border: '1px solid var(--border)', color: 'var(--text)' }} />
          </>
        )}
        {options.length > 0 && (
          <div className="mt-2 space-y-1.5">
            {options.map((o) => (
              <label key={o.field} className="flex items-start gap-2 text-xs text-white/75">
                <input type="checkbox" className="mt-0.5" checked={!!ticked[o.field]}
                  onChange={(e) => setTicked((t) => ({ ...t, [o.field]: e.target.checked }))} />
                <span>{o.label}</span>
              </label>
            ))}
          </div>
        )}
        {action.confirm && (
          <p className="mt-2 text-xs font-semibold text-white/75">{action.confirm}</p>
        )}
        {err && <p role="alert" className="mt-2 text-xs" style={{ color: 'var(--erp-danger)' }}>{err}</p>}
      </div>
    </Modal>
  )
}

export default ApprovalActionDialog
