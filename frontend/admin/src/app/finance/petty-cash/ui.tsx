'use client'
// The petty-cash page's small kit: types from GET /trustops/petty-cash/boxes,
// money words, the modal frame, fields and the server-error banner. Tokens
// only (purple = actions, green = state / good news, red = bad).

import { ApiError } from '../../../lib/api'
import { managerPinLockedMessage, WRONG_PIN_MESSAGE } from '../../../components/pos/pinErrors'

export interface SpendLineRow {
  id: string
  kind: string
  categoryKey: string | null
  accountCode: string
  amountCents: number
  description: string
  conceptId: string | null
}
export interface Movement {
  id: string
  type: 'topup' | 'spend' | 'reconcile' | 'transfer' | 'return'
  amountCents: number
  category: string | null
  reason: string
  receiptUrl: string | null
  vendorName: string | null
  source: string | null
  accountCode: string | null
  journalEntryId: string | null
  transferRef: string | null
  supplierPaymentId: string | null
  cashVoucherId: string | null
  createdAt: string
  /** 'booked' | 'no_entry' | 'not_booked' (server). */
  ledger: 'booked' | 'no_entry' | 'not_booked'
  lines: SpendLineRow[]
  attachments: Array<{ id: string; mime: string; sizeBytes: number }>
}
export interface Box {
  id: string
  tenantId: string | null
  name: string
  conceptId: string | null
  custodianId: string
  /** The custodian's name, sent with the box (GET /trustops/petty-cash/boxes). */
  custodianName?: string | null
  floatCents: number
  topUpLimitCents: number
  isActive: boolean
  movements: Movement[]
}

export const pkr = (cents: number) => `PKR ${(cents / 100).toLocaleString('en-PK', { maximumFractionDigits: 2 })}`

export const TYPE_LABEL: Record<Movement['type'], string> = {
  topup: 'Top-up', spend: 'Spend', reconcile: 'Count', transfer: 'Transfer', return: 'Returned',
}

/** Where the cash came from / went, in plain words. */
export function sourceLabel(m: Pick<Movement, 'type' | 'source' | 'accountCode' | 'supplierPaymentId' | 'cashVoucherId'>): string | null {
  if (m.type === 'transfer') return 'Between boxes'
  if (m.type === 'reconcile') return 'Count difference (8010)'
  if (m.type === 'spend') {
    if (m.supplierPaymentId) return 'Paid a supplier bill'
    if (m.accountCode === '1355') return 'Cash request advance (1355)'
    return null
  }
  const words: Record<string, string> = {
    garibsons: 'Garibsons cashier (2210)', safe: 'Safe (1010)', bank: 'Bank', till: 'Till drawer (1015)',
    cash_request: 'Change returned (1355)', opening: 'Safe (1010)',
  }
  const w = m.source ? words[m.source] ?? m.source : null
  if (m.source === 'bank' && m.accountCode) return `Bank (${m.accountCode})`
  return m.type === 'return' && w ? `To ${w}` : w ? `From ${w}` : null
}

import { Dialog, DialogFooter, ErrorBanner as SharedErrorBanner } from '../../../components/finance/ui'
/** Thin wrapper over the shared Dialog (Escape, focus trap, dirty-close ask). */
export function Modal({ title, children, onClose, dirty }: { title: string; children: React.ReactNode; onClose: () => void; dirty?: boolean }) {
  return <Dialog title={title} onClose={onClose} wide dirty={dirty}>{children}</Dialog>
}
export function Footer({ onCancel, primary }: { onCancel: () => void; primary: React.ReactNode }) {
  return <DialogFooter onCancel={onCancel} flush>{primary}</DialogFooter>
}
export { Field, firstMissing, focusField, useSubmitOnce, fieldCls, primaryBtn } from '../../../components/finance/ui'
/**
 * A top-up over the box limit (or raising the limit) is approved with a
 * manager PIN: the same words as every other PIN prompt for a wrong PIN or a
 * lock-out (pinErrors.ts).
 */
export function pinRefusal(e: unknown): Error | null {
  const locked = managerPinLockedMessage(e)
  if (locked) return new Error(locked)
  if (e instanceof ApiError && e.code === 'INVALID_MANAGER_PIN') return new Error(WRONG_PIN_MESSAGE)
  return null
}
/** The server's own message (403 / 404 / 409 / 422 included). */
export function ErrorBanner({ error }: { error: unknown }) {
  return <SharedErrorBanner message={error instanceof Error ? error.message : 'Failed'} />
}

/** A segmented choice (e.g. where the cash came from). */
export function Choice<T extends string>({ value, options, onChange }: { value: T; options: ReadonlyArray<{ value: T; label: string; disabled?: boolean }>; onChange: (v: T) => void }) {
  return <div className="grid grid-cols-2 gap-2">
    {options.map((o) => {
      const on = o.value === value
      return <button key={o.value} type="button" disabled={o.disabled} onClick={() => onChange(o.value)}
        className="rounded-lg px-3 py-2 text-xs font-bold disabled:opacity-40"
        style={on
          ? { background: 'rgb(var(--erp-primary-rgb) / 0.12)', color: 'var(--erp-primary)', border: '1px solid var(--erp-primary)' }
          : { background: 'rgb(var(--fg-rgb) / 0.04)', color: 'rgb(var(--fg-rgb) / 0.6)', border: '1px solid rgb(var(--fg-rgb) / 0.08)' }}>
        {o.label}
      </button>
    })}
  </div>
}

