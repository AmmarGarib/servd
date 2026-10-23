'use client'
import { requireOnline } from '../../../lib/offline-queue'
import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { ApiError, posApi } from '../../../lib/api'
import { PasswordInput } from '../../ui/PasswordInput'
import { fmtPkr } from '../../../lib/money'
import { orderRef } from '../../../lib/orderRef'
import { useConfirm } from '../../ui/ConfirmDialog'
import { compOverrideMessage, managerPinLockedMessage, WRONG_PIN_MESSAGE } from '../pinErrors'
import { useIsManager } from '../managerRole'
import { storedQuote, tillErrorMessage, type TillOrder, tableName } from '../tillApi'
import { FlowDialog, ErrorLine, ghostBtn, inputCls, labelCls, primaryBtn } from './ui'

// No Charge — the EXISTING comp (POST /pos/orders/:id/comp, TILL_FLOW §4): a reason, a manager PIN above
// the comp limit; a staff meal is a comp rung through the till (every staff meal needs a manager).
export function NoChargeDialog({ ticket, shiftId, onClose, onDone }: {
  ticket: TillOrder
  shiftId: string
  onClose: () => void
  onDone: () => void
}) {
  const qc = useQueryClient()
  const confirm = useConfirm()
  const isManager = useIsManager()
  const stored = storedQuote(ticket)
  const [kind, setKind] = useState<'comp' | 'staff_meal'>('comp')
  const [reason, setReason] = useState('')
  const [staffFor, setStaffFor] = useState('')
  const [pin, setPin] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const pinShown = kind === 'comp' || !isManager

  const blocked = busy || stored.dueCents <= 0 || (kind === 'comp' ? !reason.trim() : !staffFor.trim())

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (blocked) return
    const n = ticket.items.filter((i) => i.status !== 'voided').reduce((c, i) => c + i.quantity, 0)
    const ok = await confirm({
      title: kind === 'comp' ? 'Mark this order No Charge?' : 'Ring this as a staff meal?',
      body: `${n} item${n !== 1 ? 's' : ''}, ${fmtPkr(stored.dueCents)} — written off. No money is taken.`,
      confirmLabel: kind === 'comp' ? 'No Charge' : 'Ring as staff meal', cancelLabel: 'Go back', danger: true,
    })
    if (!ok) return
    setBusy(true); setError(null)
    try {
      requireOnline() // a comp is never queued offline: "No internet — not sent"
      await posApi.compOrder(ticket.id, {
        amountCents: stored.dueCents,
        reason: kind === 'staff_meal' ? 'staff_meal' : reason.trim(),
        shiftId,
        ...(kind === 'staff_meal' && { staffMealFor: staffFor.trim() }),
        ...(pinShown && pin && { managerOverridePin: pin }),
      })
      void qc.invalidateQueries({ queryKey: ['pos'] })
      onDone()
    } catch (err) {
      if (err instanceof ApiError && (err.code === 'INVALID_MANAGER_PIN' || err.code === 'MANAGER_PIN_LOCKED')) setPin('')
      setError(managerPinLockedMessage(err)
        ?? (err instanceof ApiError && err.code === 'MANAGER_OVERRIDE_REQUIRED' ? compOverrideMessage(kind)
        : err instanceof ApiError && err.code === 'INVALID_MANAGER_PIN' ? WRONG_PIN_MESSAGE
        : tillErrorMessage(err, 'No Charge failed')))
    } finally { setBusy(false) }
  }

  return (
    <FlowDialog title="No Charge" subtitle={`${ticket.table?.label ? `${tableName(ticket.table.label)}` : 'Order'} · ${orderRef(ticket.id)} · ${fmtPkr(stored.dueCents)}`} onClose={onClose} width="max-w-sm">
      <form onSubmit={submit} className="space-y-4">
        <div className="grid grid-cols-2 gap-2" role="group" aria-label="Kind of No Charge">
          <button type="button" aria-pressed={kind === 'comp'} onClick={() => setKind('comp')} className={`min-h-11 rounded-lg border font-semibold ${kind === 'comp' ? 'border-kds-green bg-kds-green/20 text-kds-green' : 'border-kds-border text-kds-text'}`}>Complimentary</button>
          <button type="button" aria-pressed={kind === 'staff_meal'} onClick={() => setKind('staff_meal')} className={`min-h-11 rounded-lg border font-semibold ${kind === 'staff_meal' ? 'border-kds-green bg-kds-green/20 text-kds-green' : 'border-kds-border text-kds-text'}`}>Staff meal</button>
        </div>
        {kind === 'comp' ? (
          <div><label htmlFor="nc-reason" className={labelCls}>Reason (required)</label><input id="nc-reason" autoFocus value={reason} onChange={(e) => setReason(e.target.value)} className={inputCls} placeholder="Customer complaint, long wait…" /></div>
        ) : (
          <div><label htmlFor="nc-staff" className={labelCls}>Staff member</label><input id="nc-staff" autoFocus value={staffFor} onChange={(e) => setStaffFor(e.target.value)} className={inputCls} placeholder="Employee code" /></div>
        )}
        {pinShown && (
          <div>
            <label htmlFor="nc-pin" className={labelCls}>{kind === 'comp' ? 'Manager PIN (needed above your comp limit)' : 'Manager PIN (every staff meal needs a manager)'}</label>
            <PasswordInput id="nc-pin" numeric maxLength={8} autoComplete="off" value={pin} onChange={(e) => setPin(e.target.value)} className={inputCls} />
          </div>
        )}
        <ErrorLine text={error} />
        <div className="flex gap-3">
          <button type="button" onClick={onClose} className={`${ghostBtn} flex-1`}>Back</button>
          <button type="submit" disabled={blocked} className={`${primaryBtn} flex-1`}>{busy ? 'Working…' : 'No Charge'}</button>
        </div>
      </form>
    </FlowDialog>
  )
}
