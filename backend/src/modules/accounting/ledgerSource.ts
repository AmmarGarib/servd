// What document an entry came from, in plain words (owner, 2026-11-06: "highlighted details are not mandatory to
// mention, keep the ledger clean and understandable for non accounting person … mention required details to
// comprehend the ledger as per IFRS"). The ledger screen shows this instead of the system key
// (`cashvoucher.pay:<id>`); the key stays stored and is never shown. Read only.

const LABELS: Array<[RegExp, string]> = [
  [/^manual\.reversal$/, 'Cancellation of a journal entry'],
  [/^manual$/, 'Journal entry'],
  [/\.(reversal|void)$/, 'Cancellation / reversal'],
  [/^cashvoucher\./, 'Cash voucher'],
  [/^pettycash\./, 'Petty cash'],
  [/^order\.refund/, 'Refund to customer'],
  [/^order\.credit_note/, 'Credit note to customer'],
  [/^order\./, 'Sale'],
  [/^pos\./, 'Till'],
  [/^shift\.close/, 'Till day close (sales)'],
  [/^deposit\.drop/, 'Cash deposited in bank'],
  [/^supplier\.bill\.variance/, 'Supplier bill (price difference)'],
  [/^supplier\.bill/, 'Supplier bill'],
  [/^supplier\.credit_note/, 'Supplier credit note'],
  [/^supplier\.payment/, 'Payment to supplier'],
  [/^supplier\.opening/, 'Supplier opening balance'],
  [/^grn|^goods_receipt|^inventory\.receive|^procurement\.receipt|^transfer_in/, 'Goods received'],
  [/^procurement\.grni/, 'Goods received, not billed'],
  [/^inventory\.|^stock|^prep/, 'Stock movement'],
  [/^hr\.payroll/, 'Payroll'],
  [/^hr\.final|^hr\.settlement|^hr\.fnf/, 'Final settlement (employee leaving)'],
  [/^hr\.loan/, 'Employee loan / advance'],
  [/^hr\./, 'HR'],
  [/^tippool|^tip_pool/, 'Tip pool'],
  [/^capex/, 'Capital expenditure (equipment / fit-out)'],
  [/^fixed_asset\.depreciation|^depreciation/, 'Depreciation'],
  [/^fixed_asset/, 'Fixed asset'],
  [/^opex/, 'Operating expense'],
  [/^salestax|^tax\./, 'Tax payment'],
  [/^receivable|^cityledger/, 'Customer account (receivable)'],
  [/^ic\.|^intercompany/, 'Between companies'],
  [/^card\.|^keenu/, 'Card settlement'],
  [/^raast/, 'Raast'],
  [/^reconciliation\.adjustment/, 'Bank reconciliation adjustment'],
  [/^reservation/, 'Reservation deposit'],
  [/^fifo_cutover/, 'Stock opening'],
  [/^loyalty/, 'Loyalty points'],
  [/^giftcard|^gift_card/, 'Gift card'],
  [/^wallet/, 'Customer wallet'],
  [/^allocation/, 'Cost allocation'],
  [/^cod\./, 'Cash on delivery'],
]

/** "cashvoucher.pay:abc" → "Cash voucher"; unknown → "Automatic entry"; none → "Entry". */
export function ledgerSourceLabel(reference: string | null | undefined): string {
  if (!reference) return 'Entry'
  const type = reference.split(':')[0]!.replace(/@\d+$/, '')
  for (const [re, label] of LABELS) if (re.test(type)) return label
  return 'Automatic entry'
}
