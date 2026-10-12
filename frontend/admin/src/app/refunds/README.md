# refunds

Admin route: **/refunds**. Next.js App Router page module — `page.tsx` is the entry, any sibling `layout.tsx` wraps it.

## Files

- `page.tsx` — refunds and cancellations: a refund through the one refund engine, a cancel through `POST /orders/:id/cancel` (a manager approves — their session or their PIN)
- `refundEngine.ts` — `POST /pos/orders/:id/refund` (manager PIN above your cap), the tenders a refund may use (only those the order was paid with), refund to the card on the card machine (`POST /pos/terminal/refunds`, managers, with the policy's photo), the cancel with approval, and the fiscal refund line
- `RefundOptions.tsx` — the shared "give back as" picker (tender, card machine, evidence photo) used here and on `/orders/[id]`
