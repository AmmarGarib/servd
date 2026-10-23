// Shared shapes + small helpers for the Journals screens (contract:
// backend modules/accounting/journalsRegister.ts, journalsRoutes.ts).

export type EntryStatus = 'live' | 'reversed' | 'reversal' | 'change_pending'

export interface RegLine {
  id: string
  accountId: string
  accountCode: string
  accountName: string
  type: 'debit' | 'credit'
  amountCents: number
  conceptId: string | null
  conceptName: string | null
  memo: string | null
  subAccounts: Array<{ subAccountId: string; name: string; amountCents: number }>
}

export interface PendingChange {
  requestId: string
  kind: string
  status: string
  reason: string | null
  preparedById: string | null
  preparedByName: string | null
  submittedAt: string | null
}

export interface EntryFlags {
  status: EntryStatus
  reversedBy: { id: string; entryDate: string } | null
  reverses: { id: string } | null
  pendingChange: PendingChange | null
  canTextEdit: boolean
  canRequestChange: boolean
  changeNeedsApproval: boolean
  blockedReason: string | null
}

export interface RegRow extends EntryFlags {
  id: string
  tenantId: string | null
  companyName: string | null
  voucherNo: string | null
  reference: string | null
  sourceType: string | null
  entryDate: string
  createdAt: string
  description: string
  operatorReference: string | null
  totalCents: number
  moneyNetCents: number
  moneyAccounts: Array<{ code: string; name: string; netCents: number }>
  counterSummary: string | null
  brands: Array<{ id: string; name: string }>
  postedBy: { id: string; name: string } | null
  lines: RegLine[]
}

export interface ChangeRequest {
  id: string
  kind: string
  status: string
  reason: string | null
  preparedByName: string | null
  submittedAt: string | null
  decidedByName: string | null
  decidedAt: string | null
  decisionNote: string | null
}

export interface EntryDetail {
  entry: RegRow
  changes: ChangeRequest[]
  textEdits: Array<{ at: string; userId: string | null; userName: string | null; before: unknown; after: unknown }>
}

export interface ChartAccount { id: string; tenantId: string | null; code: string; name: string; type: string; isActive: boolean; companyName?: string | null }
export interface SubAccount { id: string; accountId: string; name: string; code: string | null; kind: string; employeeId: string | null; isActive: boolean }
export interface Brand { id: string; name: string; tenantId: string | null }

const PKT_OFFSET_MS = 5 * 3600_000
export const pktDate = (iso: string) => (/^\d{4}-\d{2}-\d{2}$/.test(iso) ? iso : new Date(new Date(iso).getTime() + PKT_OFFSET_MS).toISOString().slice(0, 10))

export const PENDING_MSG = 'Sent to the CEO for approval — nothing changes in the books until approved.'

/** True when a write answered 202 (finance's money edit / cancel waits for the CEO). */
export const isPending = (r: unknown) => !!r && typeof r === 'object' && (r as { pendingApproval?: boolean }).pendingApproval === true

/** "1,234.5" -> paisa; null when invalid; '' -> undefined. */
export function rupeesToCents(s: string): number | null | undefined {
  const t = s.replace(/,/g, '').trim()
  if (!t) return undefined
  if (!/^\d+(\.\d{1,2})?$/.test(t)) return null
  const [r, p = ''] = t.split('.')
  return Number(r) * 100 + Number(p.padEnd(2, '0'))
}
