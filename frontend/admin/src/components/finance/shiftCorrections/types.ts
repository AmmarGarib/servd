// Shapes of /pos/shift-corrections (backend/src/modules/shiftCorrections/service.ts).
export const MIN_REASON = 10

export type SetStatus = 'submitted' | 'approved' | 'rejected' | 'applied' | 'failed'

export const STATUS_LABEL: Record<SetStatus, string> = {
  submitted: 'Waiting for CEO',
  approved: 'Applying',
  applied: 'Applied',
  rejected: 'Rejected',
  failed: 'Failed to apply',
}
export const STATUS_BADGE: Record<SetStatus, string> = {
  submitted: 's-badge-amber',
  approved: 's-badge-blue',
  applied: 's-badge-green',
  rejected: 's-badge-muted',
  failed: 's-badge-red',
}

export interface Tender { method: string; amountCents: number; status: string; onThisDrawer?: boolean }

export interface ItemPreview {
  orderRef: string
  brand: string | null
  status: string | null
  totalCents: number
  tenders: Tender[]
  effect: {
    order: 'void_final_bill' | 'cancel_ticket' | 'not_available'
    reversesRevenue: boolean
    money: 'voided' | 'owed_back' | 'none'
    stock: 'back_to_stock' | 'waste'
    fiscal: 'void_document' | 'void_document_manual' | 'none'
  }
  blockedBy: { code: string; message: string } | null
}

export interface SetItem {
  id: string
  kind: 'void_bill' | 'cancel_kot' | 'void_reissue'
  orderId: string
  orderRef: string
  reason: string
  moneyReturned: boolean
  foodMade: boolean
  result: { applied?: boolean; error?: string } | null
  preview?: ItemPreview
}

export interface Drawer { expectedCents: number; countedCents: number | null; varianceCents: number | null }

export interface CorrectionSet {
  id: string
  shiftId: string
  businessDay: string
  status: SetStatus
  reason: string
  requestedBy: { id: string; name: string | null }
  decidedBy: { id: string; name: string | null } | null
  decidedAt: string | null
  decisionNote: string | null
  appliedAt: string | null
  error: string | null
  result: { drawer?: Drawer & { varianceBeforeCents?: number | null } } | null
  createdAt: string
  shift: { id: string; cashierName: string | null; locationName: string | null; openedAt: string; closedAt: string | null } | null
  drawer?: Drawer
  items: SetItem[]
}

export interface Candidate {
  orderId: string
  orderRef: string
  brand: string
  status: string
  placedAt: string
  completedAt: string | null
  totalCents: number
  settlementChannel: string | null
  tenders: Tender[]
  lines: Array<{ name: string; quantity: number }>
  kind: 'void_bill' | 'cancel_kot' | null
  blockedBy: { code: string; message: string } | null
}

export interface ShiftCandidates {
  shift: {
    id: string; businessDay: string; cashierName: string | null; locationName: string | null
    openedAt: string; closedAt: string | null; closingFloatCents: number | null; expectedCents: number
  }
  pendingCorrectionId: string | null
  booksClosed: { code: string; message: string } | null
  orders: Candidate[]
}

export const KIND_LABEL = { void_bill: 'Void the bill', cancel_kot: 'Cancel the open ticket', void_reissue: 'Void and re-issue' } as const

export const TENDER_LABEL: Record<string, string> = {
  cash: 'Cash', card: 'Card', keenu_qr: 'Keenu QR', raast: 'Raast QR', on_account: 'On account', comp: 'Comp', wallet: 'Wallet', gift_card: 'Gift card',
}
// A tender a correction voided is stored as 'failed' (never 'refunded'): it reads "voided".
const TENDER_STATUS: Record<string, string> = { failed: 'voided', pending: 'not yet paid', refunded: 'refunded' }
export const tenderText = (t: Tender[]) =>
  t.length ? t.map((x) => `${TENDER_LABEL[x.method] ?? x.method}${x.status !== 'paid' ? ` (${TENDER_STATUS[x.status] ?? x.status})` : ''}`).join(', ') : 'No payment'

export const fmtDateTime = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Karachi' }) : '—'

export const fmtDay = (ymd: string) => {
  const d = new Date(`${ymd}T12:00:00Z`)
  return Number.isNaN(d.getTime()) ? ymd : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })
}

const dayShort = (ymd: string) => {
  const d = new Date(`${ymd}T12:00:00Z`)
  return Number.isNaN(d.getTime()) ? ymd : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' })
}

/** What approving a fix does, in plain words. */
export function effectText(p: ItemPreview, businessDay: string): string {
  const day = dayShort(businessDay)
  const parts: string[] = []
  if (p.effect.order === 'cancel_ticket') parts.push('Open ticket cancelled')
  else parts.push('Bill voided')
  if (p.effect.reversesRevenue) parts.push(`revenue and GST reversed on ${day}`)
  if (p.effect.money === 'voided') parts.push('payment cancelled (no refund)')
  else if (p.effect.money === 'owed_back') parts.push('money handed back, shown as a refund due on till clearing')
  parts.push(p.effect.stock === 'waste' ? 'food was made, so stock is written off as waste' : 'stock back to stock')
  if (p.effect.fiscal === 'void_document') parts.push('void sent to FBR/SRB')
  else if (p.effect.fiscal === 'void_document_manual') parts.push('manual filing')
  if (p.effect.order === 'void_final_bill') parts.push('bill moves to the Trash')
  else parts.push('moves to the Trash')
  return parts.join(' · ')
}
