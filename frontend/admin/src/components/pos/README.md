# pos

Source files for `frontend/admin/src/components/pos` — the admin till (`/pos`, `/pos/waiter`).

The till computes no tax: GST (cash 15% / card 8%) and the service charge are
priced by the server, and the till shows and charges the server's bill.

## Files

- `tillApi.ts` — the till's server calls: ring-up, the server's bill per tender (`GET /pos/orders/:id/quote`), cart preview (`POST /pos/quote`), payment (with idempotency key and optional tip), open tickets, the drawer close (`closeDrawer` with `confirmOpenTickets`, `fetchDrawerOpenTickets`), printing (`printHtml`, the full & final bill `fetchReceiptHtml` and its 409 `PRE_BILL_REQUIRED`, `printPreBill`), the order's fiscal documents (`fetchOrderFiscal`, `retryOrderFiscal`, `fiscalLine`) and the card machine (`/pos/terminal/*`: config, start / follow / cancel / resolve a charge, refund to card, the per-attempt idempotency key)
- `PaymentModal.tsx` — ring up the cart, then take payment for the server's bill (cash / card / QR / comp / staff meal); also pays an open ticket. "Print pre-bill" before payment; after payment the fiscal line (filed number, "pending — will file automatically", or TEST) and the full & final bill print
- `TerminalCharge.tsx` — "Charge on card machine" (spec §7): pick the terminal, start the charge, follow it live (awaiting card / approved / declined / reversed), Cancel, and "Check the card machine" when the outcome is unknown (read the machine, never re-key). The manual reference is offered by the modal only when the machine is offline
- `OpenTickets.tsx` — unpaid till orders for the brand (e.g. tables a waiter sent), paid in one go; "Pre-bill" per ticket
- `VoidLineDialog.tsx` — void one line (`POST /pos/orders/:id/void`): every void needs a manager — a manager's PIN unless the signed-in user is one; shows the bill the void leaves, a refund of a paid line and a cleared split
- `OrderFiscalPanel.tsx` — the order's fiscal documents on `/orders/[id]` (number, authority, QR, status; Retry for managers; Reprint)
- `managerRole.ts` — `useIsManager()`: the signed-in role against the server's override approvers (`GET /permissions/role-modules`)
- `PosCart.tsx` — the cart, with the server's cash / card totals when available
- `OpenTicketsCloseConfirm.tsx` — a drawer close refused with 409 `OPEN_TICKETS`: names the unpaid tickets and offers "Close anyway" (used by `/pos/shift` and `/reconciliation`)
