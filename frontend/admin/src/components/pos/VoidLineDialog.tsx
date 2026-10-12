'use client'
// Void one line (POST /pos/orders/:id/void). Owner, 2026-10-10: "This void is
// not a void that cashier or server can do. It must be manager that voids."
// So the dialog ALWAYS asks for a manager's PIN unless the signed-in user is
// a manager (the server's override approvers), sends it as
// managerOverridePin, and says plainly when the PIN is missing or wrong. The
// answer carries the bill the void leaves, which the page shows at once.
// Light admin page: colour tokens only.

import { useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { api, ApiError } from '../../lib/api'
import { fmtPkr } from '../../lib/money'
import { approvalErrorMessage } from '../../app/refunds/refundEngine'

/** What POST /pos/orders/:id/void answers (backend pos/service.ts voidOrderItem). */
export interface VoidLineResult {
  id: string
  order: { id: string; totalCents: number; taxCents: number; serviceChargeCents: number; discountCents: number }
  removedCents: number
  /** A check split was cleared because the bill changed — re-split it. */
  splitCleared: boolean
  /** The line was already paid for: this much went back to the guest. */
  refund: { id: string; amountCents: number; method: string; shiftId: string | null; entryId: string } | null
}

const VOID_MESSAGES: Record<string, string> = {
  ORDER_PARTLY_PAID: 'Part of this bill is paid and the payments would exceed the new total — refund first, then void.',
  VOID_LAST_LINE: 'This is the last item on a paid order — cancel the order instead of voiding it.',
  OPEN_DRAWER_REQUIRED: 'This item was paid in cash — open a shift so the refund can leave your drawer, then void it.',
  ALREADY_VOIDED: 'This item is already voided.',
  OVER_CAP: 'This void is above the manager limit — the CEO must approve it.',
}

export function voidErrorMessage(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.code === 'MANAGER_OVERRIDE_REQUIRED' || e.code === 'INVALID_MANAGER_PIN' || e.code === 'MANAGER_PIN_LOCKED') return approvalErrorMessage(e, 'void')
    return VOID_MESSAGES[e.code] ?? (e.message || e.code)
  }
  return e instanceof Error ? e.message : 'The void failed'
}

export function VoidLineDialog({ orderId, item, isManager, onClose, onVoided }: {
  orderId: string
  item: { id: string; name: string; quantity: number; lineCents: number }
  /** The signed-in user approves with their own session (no PIN asked). */
  isManager: boolean
  onClose: () => void
  onVoided: (r: VoidLineResult) => void
}) {
  const [reason, setReason] = useState('')
  const [pin, setPin] = useState('')
  // A manager whose session the server did not accept as approver still gets the PIN box.
  const [askPin, setAskPin] = useState(!isManager)

  const send = useMutation({
    mutationFn: () => api.post<VoidLineResult>(`/pos/orders/${encodeURIComponent(orderId)}/void`, {
      orderItemId: item.id,
      reason: reason.trim(),
      ...(askPin && pin.trim() && { managerOverridePin: pin.trim() }),
    }),
    onSuccess: (r) => onVoided(r),
    onError: (e) => {
      // A wrong PIN or the wrong-PIN lock-out (429 MANAGER_PIN_LOCKED): clear
      // the box; the message says whether to retype it or get a manager.
      if (e instanceof ApiError && (e.code === 'MANAGER_OVERRIDE_REQUIRED' || e.code === 'INVALID_MANAGER_PIN' || e.code === 'MANAGER_PIN_LOCKED')) {
        setAskPin(true)
        setPin('')
      }
    },
  })

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-secondary/50 p-4" role="dialog" aria-modal="true" aria-label={`Void ${item.name}`}>
      <form
        className="w-full max-w-sm space-y-4 rounded-2xl border border-s-border bg-s-surface p-6"
        onSubmit={(e) => { e.preventDefault(); if (!send.isPending) send.mutate() }}
      >
        <div>
          <p className="text-lg font-bold text-s-text">Void {item.quantity} × {item.name}</p>
          <p className="text-xs text-s-muted">Line value {fmtPkr(item.lineCents)}. Every void needs a manager.</p>
        </div>
        <div>
          <label htmlFor="void-reason" className="mb-1 block text-xs text-s-muted">Reason (required)</label>
          <input id="void-reason" value={reason} onChange={(e) => setReason(e.target.value)} autoFocus maxLength={200}
            placeholder="Wrong item, guest changed their mind…"
            className="w-full rounded-lg border border-s-border bg-s-bg px-3 py-2 text-sm text-s-text focus:border-primary focus:outline-none" />
        </div>
        {askPin ? (
          <div>
            <label htmlFor="void-pin" className="mb-1 block text-xs text-s-muted">Manager PIN</label>
            <input id="void-pin" type="password" inputMode="numeric" autoComplete="off" value={pin} onChange={(e) => setPin(e.target.value)}
              className="w-full rounded-lg border border-s-border bg-s-bg px-3 py-2 text-sm text-s-text focus:border-primary focus:outline-none" />
            <p className="mt-1 text-[11px] text-s-muted">The manager who enters their PIN is recorded as approving this void.</p>
          </div>
        ) : (
          <p className="text-xs text-s-muted">You are approving this void as a manager.</p>
        )}
        {send.isError && <p className="text-sm text-s-red" role="alert">{voidErrorMessage(send.error)}</p>}
        <div className="flex gap-3">
          <button type="submit" disabled={send.isPending || !reason.trim() || (askPin && !pin.trim())}
            className="flex-1 rounded-xl bg-s-red py-2 text-sm font-bold text-bone hover:opacity-90 disabled:opacity-40">
            {send.isPending ? 'Voiding…' : 'Void item'}
          </button>
          <button type="button" onClick={onClose} className="flex-1 rounded-xl border border-s-border py-2 text-sm text-s-muted hover:border-s-text">
            Keep it
          </button>
        </div>
      </form>
    </div>
  )
}
