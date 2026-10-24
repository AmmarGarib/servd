// PARTICULARS of a ledger line (owner, 2026-10-24: "Rename "Entry" column to
// Particulars, and it should show main narration rather than all the updates
// along"). The entry's stored description carries the system's status words
// ("Cash voucher CV-00002 paid from cash on hand to Asif Ali — documents
// awaited: For Mobile package …"); the particulars are the document's own
// narration — a cash voucher's purpose and payee, a petty-cash spend's reason,
// a manual entry's description without its cheque reference. Read only: the
// stored description is never changed. Anything not recognised keeps its
// description (system keys turned into "the original entry").

import { prisma } from '../../lib/prisma.js'
import { splitDescription } from './manualJournal.js'

const MANUAL = 'manual:'
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
const VOUCHER_REF = /^cashvoucher\.[a-z_]+:([A-Za-z0-9-]+)(?:@\d+)?$/
const SPEND_REF = /^pettycash\.spend:([A-Za-z0-9-]+)(?:@\d+)?$/

/** System keys (`order.complete:<uuid>`) in text → "the original entry". */
export function readableDescription(d: string): string {
  return d.replace(new RegExp(`([a-z_]+(?:\\.[a-z_]+)*):${UUID}(@\\d+)?`, 'gi'), 'the original entry')
}

function voucherNarration(v: { purpose: string; payeeName: string | null }): string {
  const purpose = v.purpose.trim()
  const payee = v.payeeName?.trim()
  if (!payee || purpose.toLowerCase().includes(payee.toLowerCase())) return purpose
  return `${purpose} — ${payee}`
}

/** "Petty cash spend — Box: reason" / "Cash request CV-1 paid — Box: reason" → reason. */
function strippedSystemText(d: string): string {
  const m = /^(?:Petty cash spend|Cash request \S+ paid|Cash voucher \S+ [^:]*?) — [^:]*: (.+)$/s.exec(d)
    ?? /^Cash voucher \S+ [^:]+: (.+)$/s.exec(d)
  return m ? m[1].trim() : d
}

/**
 * The particulars of each entry, keyed by the entry's reference + description
 * of the companies in `tenantIds` (the caller's scope — a document of another company is never read).
 */
export async function particularsOf(
  tenantIds: Array<string | null>,
  entries: Array<{ description: string; reference: string | null }>,
): Promise<(e: { description: string; reference: string | null }) => string> {
  const voucherIds = new Set<string>()
  const movementIds = new Set<string>()
  for (const e of entries) {
    const ref = e.reference ?? ''
    const v = VOUCHER_REF.exec(ref)
    if (v) voucherIds.add(v[1])
    const s = SPEND_REF.exec(ref)
    if (s) movementIds.add(s[1])
  }
  const scope = { tenantId: { in: tenantIds.filter((t): t is string => !!t) } }
  const movements = movementIds.size
    ? await prisma.pettyCashMovement.findMany({ where: { id: { in: [...movementIds] }, ...scope }, select: { id: true, reason: true, cashVoucherId: true } })
    : []
  for (const m of movements) if (m.cashVoucherId) voucherIds.add(m.cashVoucherId)
  const vouchers = voucherIds.size
    ? await prisma.cashVoucher.findMany({ where: { id: { in: [...voucherIds] }, ...scope }, select: { id: true, purpose: true, payeeName: true } })
    : []
  const byVoucher = new Map(vouchers.map((v) => [v.id, voucherNarration(v)]))
  const byMovement = new Map(movements.map((m) => [m.id, (m.cashVoucherId && byVoucher.get(m.cashVoucherId)) || m.reason.trim()]))

  return (e) => {
    const ref = e.reference ?? ''
    if (ref.startsWith(MANUAL)) return readableDescription(splitDescription(e.description).description)
    const v = VOUCHER_REF.exec(ref)
    if (v) { const n = byVoucher.get(v[1]); if (n) return n }
    const s = SPEND_REF.exec(ref)
    if (s) { const n = byMovement.get(s[1]); if (n) return n }
    return readableDescription(strippedSystemText(e.description))
  }
}
