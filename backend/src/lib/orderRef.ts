// The one short order reference every staff screen, receipt, ledger memo and
// customer/rider message shows: the LAST 8 characters of the order id,
// uppercased (pos/receipt.ts prints the same). The admin and tablet keep the
// same rule in their own lib/orderRef.ts.
export function orderRefOf(orderId: string): string {
  return orderId.slice(-8).toUpperCase()
}
