'use client'
// The petty-cash page's small kit: types from GET /trustops/petty-cash/boxes,
// money words, the modal frame, fields and the server-error banner. Tokens
// only (purple = actions, green = state / good news, red = bad).

import { Modal as SharedModal } from '../../../components/ui/Modal'
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

/** Thin wrapper over the shared Modal (Escape, focus trap, dirty-close ask). */
export function Modal({ title, children, onClose, dirty }: { title: string; children: React.ReactNode; onClose: () => void; dirty?: boolean }) {
  return <SharedModal title={title} onClose={onClose} wide dirty={dirty}>{children}</SharedModal>
}
export function Footer({ onCancel, primary }: { onCancel: () => void; primary: React.ReactNode }) {
  return <div className="flex justify-between gap-3 pt-3 border-t border-white/[0.05] -mx-5 -mb-5 px-4 py-4 mt-4 bg-white/[0.01]">
    <button type="button" onClick={onCancel} className="rounded-xl border border-white/10 px-4 py-2.5 text-sm text-white/55 hover:text-white">Cancel</button>
    {primary}
  </div>
}
export { Field, firstMissing, focusField, useSubmitOnce } from '../cash-vouchers/ui'
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
  const msg = error instanceof Error ? error.message : 'Failed'
  return <div role="alert" ref={scrollIntoViewOnce} className="rounded-xl px-4 py-3 text-sm" style={{ color: 'var(--erp-danger)', background: 'color-mix(in srgb, var(--erp-danger) 8%, transparent)', border: '1px solid color-mix(in srgb, var(--erp-danger) 30%, transparent)' }}>{msg}</div>
}
export const fieldCls = 'w-full rounded-lg bg-white/[0.03] border border-white/[0.08] px-3 py-2 text-sm text-white/85 focus:border-primary focus:outline-none'
export const primaryBtn = 'rounded-xl bg-primary px-5 py-2.5 text-sm font-black text-primary-on hover:opacity-90 disabled:opacity-50'

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

/** Brings a freshly shown error into view (once, when it appears). */
const scrollIntoViewOnce = (el: HTMLElement | null) => {
  if (el && !el.dataset['seen']) { el.dataset['seen'] = '1'; el.scrollIntoView({ block: 'nearest' }) }
}
