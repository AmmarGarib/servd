# pos

Admin route: **/pos**. Next.js App Router page module — `page.tsx` is the entry, any sibling `layout.tsx` wraps it.

## Files

- `page.tsx` — the till flow controller: start menu (Dine In, Delivery, No Charge, Order Summary; Manager; Other/Takeaway) -> table board -> Order Information -> order screen -> Settle (close in servd / push to Keenu). Screens live in `components/pos/flow/`; contract `backend/src/modules/pos/TILL_FLOW.md`

## Subdirectories

- [`shift/`](./shift/) — see [`shift/README.md`](./shift/README.md)
- [`waiter/`](./waiter/) — see [`waiter/README.md`](./waiter/README.md)
- [`{shift}/`](./{shift}/) — see [`{shift}/README.md`](./{shift}/README.md)

## On account (new tender option)

The till's tender picker shows **On account** only when
`GET /pos/on-account/enabled?orderId` says the order's company has an active
client and its till clearing has been cut over to 1115 (enabled requires the
cut-over), and never offline. Flow: tap On account, scan or type the client's
card code (`POST /pos/on-account/lookup`), check the client name and
available credit, enter the client's reference if asked, then confirm
(`POST /pos/orders/:orderId/on-account`; no manager PIN). The whole bill is
charged (no split, tip, promo, wallet, gift card or loyalty on it) and the
receipt carries the label and a client signature line. A refusal shows the
route's reason (over limit, overdue, suspended, brand not allowed). Contract:
`backend/src/modules/pos/README.md`; runbook `docs/on-account.md`.

