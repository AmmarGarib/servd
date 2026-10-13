All nine findings are fixed. My new tests pass (39 of 39), and `tsc` is clean in the backend (0 errors) and in `frontend/admin`. Three tests in files I don't own now fail because of my changes; the exact edits they need are below. Nothing is committed.

**Loyalty typecheck fix (you asked me to flag this):** after the ledger agent made `LoyaltyAccount` one per customer per company, four lookups in my files stopped compiling. I made the minimal fix in each:
- **`GET /storefront/account`:** now takes `?conceptSlug=` and returns `loyaltyAccount` for that brand's company (or, without a slug, the company the customer last ordered from). It also returns `loyaltyAccounts`, which lists every company.
- **`/my-perks`:** same rule, using `loyaltyAccountOf`.
- **`/my-referrals`:** adds up referral points across all the customer's accounts.
- **Reservation-completion bonus:** goes to the account at the reservation's brand's company.

A two-company test covers the account and perks lookups.

## Findings
- **ONL-01 (fixed promos at 100×):** fixed promos are now stored and applied in paisa. `lib/promoEval.ts` reads the value as paisa, and the description shows rupees ("PKR 150 off", or "PKR 150.50" when there are paisa). `POST/PATCH /promos` reject a non-whole paisa amount or a percentage outside 0–100. The admin page already worked in paisa; I added a comment and made it show save errors. Nothing else reads the promo value: POS discounts are percent-only, and the quote and checkout both use `promoEval`.
  - **Effect on prod promos:** the admin form has always saved fixed amounts in paisa (checked in git history back to the earliest commit). So every live fixed promo is already stored in paisa and becomes correct with this fix. No data migration is needed.
  - **Optional checks:** find any fixed promo that looks like it was entered in rupees with `SELECT id,"tenantId",code,"discountValue" FROM promo_codes WHERE "discountType"='fixed' AND ("discountValue"<1000 OR "discountValue"<>round("discountValue"))`. Find past orders that got too much off with `SELECT o.id,o."placedAt",p.code,p."discountValue",o."promoDiscountCents" FROM orders o JOIN promo_codes p ON p.id=o."promoCodeId" WHERE p."discountType"='fixed' AND o."promoDiscountCents">p."discountValue"`.
- **ONL-02 (card payments never charged):** new `storefront/paymentMethods.ts`. Keenu, JazzCash and EasyPaisa are offered only when their credentials are set *and* checkout really charges through them. That second condition is a flag in code, and it is off for all three today. So quote and checkout return 422 `PAYMENT_METHOD_UNAVAILABLE`, with `details.available: ['cash']`. The accepted methods are listed in the menu and quote responses as `paymentMethods`, and at a new `GET /storefront/payment-methods`. I also made `wallet` as the payment method acceptable only when wallet plus gift card cover the whole bill; otherwise it would leave an unpaid online payment nobody collects.
- **ONL-03 (tip missing from the payment):** the tip now goes into the order total and the pending payment in the same insert, and checkout returns the order re-read from the database. While checking the other paths, I found that a failed wallet deduction raised the order total but not the pending payment; it now raises both. Tests confirm total = pending payments for tip alone, tip with gift card, tip with wallet, the wallet-emptied-mid-checkout case, and two checkouts racing on one wallet.
- **ONL-08 (no booking capacity):** new `reservations/capacity.ts`. A public booking now gets a table inside a per-brand lock, and only if one still fits after every overlapping booking (with or without a table) is placed. Otherwise it gets 409 `SLOT_FULL`. Availability uses the same rule. The rule is deliberately cautious: it treats every booking that overlaps any part of the slot as needing a table for the whole slot.
- **ONL-09 (messages to any number):** I kept booking open to anyone, but servd only messages a phone or email that the signed-in customer has verified on their account and typed into the booking. Anonymous or unverified bookings are still recorded, and the response includes `confirmUrl` and a `notified` flag. To stop reminders without touching the worker, those bookings get `reminder24hSentAt` set when created. A cleaner "contact verified" column would need a schema and worker change.
- **ONL-12 (promo codes unique across companies):** the key is now `@@unique([tenantId, code])`, with migration `20261010150100_promo_code_per_company`. Create or rename onto an existing code gives 409 `PROMO_CODE_TAKEN`; lookups were already scoped to the company.
- **ONL-13 (menu sections in UTC):** sections now follow Karachi time, including sections that run past midnight. Checkout and quote refuse items from a hidden section.
- **ONL-14 (orders while closed):** checkout and quote return 409 `BRAND_CLOSED` with a message like "… closed right now. Opens at HH:MM today/tomorrow" and `details.opensAt`. Closure blockouts count as closed, a brand with no hours set stays open, and a pre-order for an open time is accepted. The menu response now has `ordering: {open, opensAt, message}`.
- **ONL-15 (bad gift card ignored):** an unknown or other-company card, or an expired, empty or inactive one, gets a 422 before anything is claimed or created. The quote returns `giftCardError`, and checkout returns `giftCardAppliedCents` and `giftCardError`. I also moved the curbside vehicle check before order creation; it used to create the order and then return 422.

## Files
- **Changed:** `backend/src/modules/storefront/routes.ts`, `backend/src/lib/promoEval.ts`, `backend/src/modules/promos/routes.ts`, `backend/src/modules/reservations/routes.ts`, `frontend/admin/src/app/promos/page.tsx`, and the PromoCode unique key in `backend/prisma/schema.prisma` (then `prisma generate`).
- **New:** `backend/src/modules/storefront/paymentMethods.ts`, `backend/src/modules/storefront/serviceHours.ts`, `backend/src/modules/reservations/capacity.ts`, and the migration `backend/prisma/migrations/20261010150100_promo_code_per_company/migration.sql`.

## Tests
- **Added:** `backend/tests/auditOnlineCheckout.test.ts` (24) and `backend/tests/auditOnlineReservations.test.ts` (15). They use two companies throughout.
- **Existing suites passing:** reservations, riderApp, sepContent, brandReconcile, waitlist, groupOrderSubmit, discountsPublic.
- **Three failures caused by my changes, in files I don't own.** I ran these exact edits on temporary copies and they pass:
  - `tests/customersReconcile.test.ts:255`: change `discountValue: 500` to `discountValue: 50_000`.
  - `tests/customersReconcile.test.ts:265`: change `findUniqueOrThrow({ where: { code } })` to `findUniqueOrThrow({ where: { tenantId_code: { tenantId: tenantA, code } } })`.
  - `tests/ordersReconcile.test.ts:362`: change `quote('jazzcash')` to `quote('wallet')`, and add `expect((await quote('jazzcash')).statusCode).toBe(422)`.
- **Other failures, not mine:** 5 in customersReconcile, 4 in loyalty and 1 in orderLifecycle. They come from the per-company `LoyaltyAccount` change (fixtures create accounts without `tenantId`).

## Storefront UI changes needed
1. **Payment methods (checkout):** show only the options listed in `quote.paymentMethods` (or `menu.paymentMethods`, or `GET /storefront/payment-methods`). Today that is cash only. That means hiding JazzCash, EasyPaisa and Keenu, the payment-phone field, the "You'll be redirected to Keenu" text and the "Continue to Keenu" button label. If the selected method is not in the list, reset to `cash`. On a 422 `PAYMENT_METHOD_UNAVAILABLE`, reset to cash and show the message.
2. **Closed brand:** on 409 `BRAND_CLOSED` from quote or checkout, show `error.message` and disable Place Order. The brand page can show a "closed, opens at …" banner from `menu.ordering`.
3. **Gift card:** show `quote.giftCardError.message` under the gift-card field, the way promo errors show. Send `giftCardCode` only when the card is valid. After placing, if `giftCardError` is set, show it.
4. **Loyalty balance:** fetch `/storefront/account?conceptSlug=${slug}` so the points shown belong to this brand's company.
5. **Reserve page (`reserve/[slug]/page.tsx`):**
   - Send the customer token when signed in, and pre-fill phone and email from the account.
   - If `notified.whatsapp` or `notified.email` is false, replace "Check your phone…" with the confirm/cancel link (`confirmUrl`) and a hint to sign in for WhatsApp confirmations and reminders.
   - On 409 `SLOT_FULL`, show the message and reload availability.

## Needs another file's owner
- **`orders/service.ts`:** an optional `tip_cents` field in the order DTO would write the tip column in the same insert. Today the total and payment are written together, and the tip column is set in the update immediately after.
- **Gateways, when wired later:** hold the order in a payment-pending state until the gateway confirms, and block completion of orders whose only payment is an unsettled card payment. Then turn the flag on in `paymentMethods.ts`.
