# pos

Source files for `frontend/admin/src/components/pos` — the admin till (`/pos`, `/pos/waiter`).

The till computes no tax: GST (cash 15% / card 8%) and the service charge are
priced by the server, and the till shows and charges the server's bill.

## Files

- `tillApi.ts` — the till's server calls: ring-up, the server's bill per tender (`GET /pos/orders/:id/quote`), cart preview (`POST /pos/quote`), payment (with idempotency key and optional tip), open tickets, the drawer close (`closeDrawer` with `confirmOpenTickets`, `fetchDrawerOpenTickets`), printing (`printHtml`, the full & final bill `fetchReceiptHtml` and its 409 `PRE_BILL_REQUIRED`, `printPreBill`), the order's fiscal documents (`fetchOrderFiscal`, `retryOrderFiscal`, `fiscalLine`) and the card machine (`/pos/terminal/*`: config, start / follow / cancel / resolve a charge, refund to card, the per-attempt idempotency key)
  and "Box given" (`boxGiven(orderId, itemId, undo?)` → `POST /pos/orders/:orderId/items/:itemId/box-given`, `boxGivenOffer` for when a line offers it, `boxGivenErrorMessage` for the 409s)
- `TerminalCharge.tsx` — "Charge on card machine" (spec §7): pick the terminal, start the charge, follow it live (awaiting card / approved / declined / reversed), Cancel, and "Check the card machine" when the outcome is unknown (read the machine, never re-key). The manual reference is offered by the modal only when the machine is offline
- `OpenTickets.tsx` — unpaid till orders for the brand (e.g. tables a waiter sent), paid in one go; "Pre-bill" per ticket
- `VoidLineDialog.tsx` — void one line (`POST /pos/orders/:id/void`): every void needs a manager — a manager's PIN unless the signed-in user is one; shows the bill the void leaves, a refund of a paid line and a cleared split
- `OrderFiscalPanel.tsx` — the order's fiscal documents on `/orders/[id]` (number, authority, QR, status; Retry for managers; Reprint)
- `managerRole.ts` — `useIsManager()`: the signed-in role against the server's override approvers (`GET /permissions/role-modules`)
- `flow/` — the new till flow (owner, 2026-10-20; contract `backend/src/modules/pos/TILL_FLOW.md`): `flowApi.ts` (board, waiters, guests, item search, zones, order info, Save, servd channel, Keenu push), `StartMenu`, `TableBoard`, `OrderInfoModal`, `DeliveryForm`, `OrderScreen`, `SettleScreen` (Close in servd: cash with keypad, Split = several tenders in one payment, Bank = Raast, Credit = on account, Card; or Push to Keenu), `DiscountDialog`, `NoChargeDialog` (the comp), `CancelTicketDialog`, `OrderSummary`, `ModifierModal`, `ui.tsx`
- `PosCart.tsx` — the order screen's cart (lines, Amount / Tax / Total(n) from the server's `POST /pos/quote`)
  and, below it, **Box given** (packaging rule, owner 2026-10-13): the brand's open dine-in tickets with a "Box given" toggle on each plate line (a "Boxed" chip with Undo once tapped). Hidden on takeaway / delivery lines and on a packaging-vessel brand's lines (Stackd), which already count their packaging. The cart itself has no order yet, so only rung tickets can be boxed; the same toggle is on `/orders/[id]`. 409s (`BOX_NOT_NEEDED`, `ORDER_COMPLETED`, `LINE_VOIDED`, `ORDER_ENDED`) are shown in words
- `OpenTicketsCloseConfirm.tsx` — a drawer close refused with 409 `OPEN_TICKETS`: names the unpaid tickets and offers "Close anyway" (used by `/pos/shift` and `/reconciliation`)
