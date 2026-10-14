# giftCards

Backend module: **giftCards**. HTTP routes + business logic for the Gift Cards domain. Registered into Fastify by `src/index.ts` under the `/gift-cards` URL prefix.

## Files

- `routes.ts` — Fastify route registrations for this module (list, books check `GET /reconcile`, issue, book a missing issue, balance, redeem, void)
- `service.ts` — THE redeem engine (storefront checkout, the till tender, POST /gift-cards/redeem)
- `books.ts` — gift cards in the books: issue + its 2080 entry in one transaction, void with a disposition, the expiry sweep with breakage (`workers/giftCardExpiry.ts` → `expireDueGiftCards` → `expireOneGiftCard`), the 2080 books check

## Breakage (owner + accountant H11, wave B)

- At a card's FIRST expiry the nightly sweep (00:10 PKT) expires it and books its unused value as breakage, in one row-locked transaction: `giftcard.expire:<cardId>` Dr 2080 / Cr **4200** Gift Card Breakage (other income, no sales tax) for a sold card, Cr **6060** Marketing & Promo for a promotional one; `GiftCard.breakageCents` / `breakageAt` record it. Company = the card's; date = the sweep day.
- Breakage is taken ONCE. Value a refund later puts back on an expired card is never swept: it waits on the card (books check `expiredHoldingValue`) and a manager settles it with Void.
- Held breakage: the card's sale (`giftcard.issue`) is not in the books → the card expires, `breakagePendingAt` / `breakagePendingReason` = `ISSUE_NOT_BOOKED`, flag `gift_card_breakage_held`; the posting is refused (e.g. 4200 missing) → the balance claim rolls back, flag `posting_failed` (sourceType `giftcard.expire`, entity `GiftCard`). The next sweep retries every held card (each card once per run, `(expiresAt, id)` cursor); `expireOneGiftCard` is also the re-poster's post function.
- Forfeiting a SOLD card (void disposition `forfeit`) is breakage too — Dr 2080 / Cr 4200, `breakageCents += B` — and is the CEO's (role `admin`) only: anyone else gets 403 `FORFEIT_NEEDS_CEO`. A promotional card's forfeit stays any manager's (Cr 6060).
- The books check (`GET /gift-cards/reconcile`, per company) adds `breakage {count, cents}`, `breakageHeld` and `expiredHoldingValue`.
