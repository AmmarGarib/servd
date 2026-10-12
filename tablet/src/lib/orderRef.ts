/**
 * THE staff-facing order number: the LAST 8 characters of the order id,
 * uppercased (e.g. "…-4f3a9c1b" → "4F3A9C1B").
 *
 * Same rule as the printed receipts and pre-bills (backend `orderRef` in
 * backend/src/modules/pos/receipt.ts) and the admin's
 * frontend/admin/src/lib/orderRef.ts, so the number on a receipt is the
 * number every tablet screen shows. Never slice an order id inline — change
 * this file, the admin copy and the receipts together.
 */
export function orderRef(id: string | null | undefined): string {
  if (!id) return ''
  return id.slice(-8).toUpperCase()
}
