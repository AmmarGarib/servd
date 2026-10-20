'use client'
import { tableName } from '../tillApi'
import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { api, ApiError } from '../../../lib/api'
import { orderRef } from '../../../lib/orderRef'
import { PasswordInput } from '../../ui/PasswordInput'
import { managerPinLockedMessage, WRONG_PIN_MESSAGE } from '../pinErrors'
import { useIsManager } from '../managerRole'
import type { TillOrder } from '../tillApi'
import { flowErrorMessage } from './flowApi'
import { FlowDialog, ErrorLine, ghostBtn, inputCls, labelCls, primaryBtn } from './ui'

// Cancel an open ticket: managers only (their own login, or a manager's PIN) — POST /orders/:id/cancel.
export function CancelTicketDialog({ ticket, onClose, onDone }: { ticket: TillOrder; onClose: () => void; onDone: () => void }) {
  const qc = useQueryClient()
  const isManager = useIsManager()
  const [reason, setReason] = useState('')
  const [pin, setPin] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function go(e: React.FormEvent) {
    e.preventDefault()
    if (busy || !reason.trim()) return
    setBusy(true); setError(null)
    try {
      await api.post(`/orders/${ticket.id}/cancel`, { reason: reason.trim(), ...(pin.trim() && { managerOverridePin: pin.trim() }) })
      void qc.invalidateQueries({ queryKey: ['pos'] })
      onDone()
    } catch (err) {
      if (err instanceof ApiError && (err.code === 'INVALID_MANAGER_PIN' || err.code === 'MANAGER_PIN_LOCKED')) setPin('')
      setError(managerPinLockedMessage(err) ?? (err instanceof ApiError && err.code === 'INVALID_MANAGER_PIN' ? WRONG_PIN_MESSAGE : flowErrorMessage(err, 'Could not cancel the order')))
    } finally { setBusy(false) }
  }

  return (
    <FlowDialog title="Cancel this ticket" subtitle={`${ticket.table?.label ? `${tableName(ticket.table.label)} · ` : ''}${orderRef(ticket.id)}`} onClose={onClose} width="max-w-sm">
      <form onSubmit={go} className="space-y-4">
        <p className="text-sm text-kds-subtext">Every cancel needs a manager. Nothing is sent to the fiscal POS.</p>
        <div><label htmlFor="ct-reason" className={labelCls}>Reason (required)</label><input id="ct-reason" autoFocus value={reason} onChange={(e) => setReason(e.target.value)} maxLength={200} className={inputCls} /></div>
        {!isManager && (
          <div><label htmlFor="ct-pin" className={labelCls}>Manager PIN</label><PasswordInput id="ct-pin" numeric maxLength={8} autoComplete="off" value={pin} onChange={(e) => setPin(e.target.value)} className={inputCls} /></div>
        )}
        <ErrorLine text={error} />
        <div className="flex gap-3">
          <button type="button" onClick={onClose} className={`${ghostBtn} flex-1`}>Keep it</button>
          <button type="submit" disabled={busy || !reason.trim() || (!isManager && !pin.trim())} className="min-h-11 flex-1 rounded-xl bg-kds-red px-4 py-3 font-bold text-white disabled:opacity-30">{busy ? 'Cancelling…' : 'Cancel ticket'}</button>
        </div>
      </form>
    </FlowDialog>
  )
}
