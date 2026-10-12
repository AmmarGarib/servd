/**
 * THE staff-facing order number: the LAST 8 characters of the order id,
 * uppercased (e.g. "…-4f3a9c1b" → "4F3A9C1B").
 *
 * It is the same rule the printed receipts, pre-bills, the Voided pre bills
 * page and the fiscal payload use (backend `orderRef` in
 * backend/src/modules/pos/receipt.ts and `orderRefOf` in
 * modules/prebills/service.ts), so the number a guest reads off a receipt is
 * the number the till, expo, the KDS and the order page show. The Order model
 * has no separate human number; every screen used to cut the uuid its own way
 * (first 6, first 8, last 5, last 6), so a cashier and the pass could not
 * match an order by number. Use this for every order number a person reads;
 * never slice an order id inline. (The tablet keeps an identical copy in
 * tablet/src/lib/orderRef.ts — change both together, and receipts with them.)
 *
 * The customer's order-status messages, the rider app's job card, the
 * hand-over-code WhatsApp and the order ledger memos must carry the same
 * number (backend `orderRefOf`), so a guest or a rider quoting it can be
 * matched on any staff screen.
 */
export function orderRef(id: string | null | undefined): string {
  if (!id) return ''
  return id.slice(-8).toUpperCase()
}
