All seven findings are fixed and tested; nothing is committed. `npx tsc --noEmit -p .` is clean across the whole backend. In the related test run, 364 of 367 pass; the 3 failures come from other agents' in-progress files.

**Tests:** I added two new files, `tests/auditLedgerLoyalty.test.ts` (9 tests, two companies) and `tests/auditLedgerSales.test.ts` (14 tests). Together with the existing accounting, posting, loyalty, gift-card and refund suites, plus other agents' audit tests that use these modules, that's 24 files. The 3 failures:
- 2 promo tests in `customersReconcile` were already failing before I changed anything.
- 1 storefront quote test in `ordersReconcile` fails because the online agent's new `assertPaymentMethodAvailable` check refuses an unconfigured jazzcash quote. It has nothing to do with loyalty or posting.

## Per finding

- **BOOKS-08 / ONL-06 / FOH-17 (refund clawback booked nothing):** Fixed. When a refund claws back earned points, it now posts the exact mirror of the earn's entry (Dr 2060 / Cr 6060) in the order's company. The points and the entry move in one transaction, keyed per earn row, so a replay does nothing. The review bonus on the same order is reversed separately. New function `postLoyaltyReversal` in `loyaltyPosting.ts`.
- **ONL-07 (spent points lost on cancel/reject/auto-cancel/refund):** Fixed. The spent points come back and the redemption is mirrored (Dr 7020 / Cr 2060), claimed once per redeem row. Tested directly and through `cancelOrder`, which the auto-cancel worker uses.
- **ONL-05 (gift card never reached the ledger):** Fixed.
  - Sales now debit 2080 per order and take revenue from the pre-card total. Your example books exactly Dr 1010 164,500 + Dr 2080 100,000 / Cr revenue 230,000 + Cr tax 34,500.
  - A refund books the mirror once, so revenue, tax and 2080 all net back. A cancel re-credits the card with no entry.
  - Sales booked before tonight are detected, and their refund re-credits the card without crediting 2080 a second time.
  - A till bill paid entirely by gift card was never booked by any shift close; it is now posted when it completes. A part-paid till bill gets its 2080 line in the shift close.
- **ONL-04 (points spent across companies):** Fixed. There is now one loyalty account per customer per company. Earn, redeem, expiry, reversal and tiers all use the order's company's account. Changes:
  - The loyalty service, loyalty routes and the expiry worker.
  - The readers you handed me: CRM, WhatsApp greeting, tier perks, and the review bonus, which now also books its liability.
  - CRM and storefront responses still include the single `loyaltyAccount` field, now showing the right company's account.
- **BOOKS-10 (sales-tax return not fileable):** Fixed.
  - Output tax follows the brand's province: Sindh to 2032 (SRB), Punjab 2031, KP 2033, Balochistan 2034, Islamabad or no province stays on 2030. A brand with only an SRB POS ID counts as Sindh. This applies to sales, refunds and shift closes.
  - The return now shows each authority with its own net, a per-rate breakdown (15% cash / 8% card, value and tax, refunds netted), and a list of tax still sitting in 2030 that needs reclassifying.
  - FBR input tax is never netted against SRB output. In the test, the old netting would have given 12,200 payable; the correct figure is 13,100 payable to SRB plus 900 carried forward with FBR.
  - The fields the admin page reads are kept.
- **FOH-09, shift-close part (cancelled order booked as a sale):** Fixed. Money taken on a cancelled or rejected order is no longer revenue or tax. It is booked Dr 1015 / 1030 against **Cr 1110 Customer Accounts Receivable**, with the memo "REFUND DUE — paid on cancelled order …". I chose 1110 because the chart has no customer-deposits liability, and a credit balance there is the customer's money owed back.
- **FOH-14, posting part (till tips):** Fixed. The POS agent records the tip on both the order and the payment's `gatewayMeta.tipCents`. The posting books it to 2095 either way, never as an overpayment to 1110, and never counts it twice.

## Prod migration notes
- **`20261010150300_loyalty_per_company`:**
  - **How accounts are split:** each existing account goes to the company where the customer earned the most. If that's ambiguous, it goes to their first-order company; with no orders at all, to the oldest active company. For every other company with order activity, a new account is created holding that company's points, transactions and stamps.
  - **Totals:** the customer's total points never change. Points spent at a company that didn't issue them are absorbed by the issuing company's balance.
  - **Verification:** I ran it on a scratch copy of the pre-change schema. Totals were preserved, the result matched the new schema, and a second run changed nothing.
- **What the migration does not touch, and needs a decision:**
  - **Cross-company redemptions (ONL-04):** the ledger keeps its old figures; the issuing company's 2060 is too high and the spending company's is negative. Find the affected accounts with `SELECT "tenantId","customerId",SUM("pointsDelta") FROM loyalty_transactions lt JOIN loyalty_accounts la ON la.id=lt."loyaltyAccountId" GROUP BY 1,2 HAVING SUM("pointsDelta")<0`. The fix is an inter-company entry, which needs your CA to choose the account because the chart has none.
  - **SRB tax already sitting in 2030:** one manual journal per Sindh brand, Dr 2030 / Cr 2032, tagged with the brand and dated in the open period. The return's reclassification list gives the amount per period, or sum 2030 lines by brand for the Sindh brands to get the all-time figure. Until this is posted, refunds of pre-deploy Sindh sales will push 2032 below zero.
  - **Old refunds and cancels (BOOKS-08, ONL-07):** points already clawed back can have their entries booked today by calling `postLoyaltyReversal(earnId)` for each clawed-back earn without one. Points lost on past cancels and refunds can be restored by re-running `postOrderRefund(orderId, …)`, which is safe to repeat. Restoring them is a customer-facing decision for you.
  - **Past gift-card sales (ONL-05):** each needs Dr 2080 / Cr revenue for the card amount.
  - **Past cancelled-but-paid shift closes (FOH-09):** each needs Dr revenue + Dr tax / Cr 1110.

## Changes needed in files I don't own
- **storefront/routes.ts:** nothing needed. The online agent already moved `/account`, `/my-perks` and `/my-referrals` to per-company accounts, and it typechecks. Checkout's loyalty calls are unchanged; the points are now taken from the order's company's account.
- **reservations/routes.ts:** another agent made it per company. The 100-point reservation bonus still moves points with no ledger entry, and only if an account already exists. It should go through the same earn function plus liability booking that I used for reviews.
- **pos/service.ts (Z-report):** should show the new refund-due figure for cancelled tickets and the gift-card total.
- **workers/loyaltyTriggers.ts:** the referral bonus should pass the referee's first-order company instead of relying on the latest-order fallback.
- **receivables/routes.ts:** B2B invoice tax is still hard-coded to 2030; it should use the brand's tax account the same way.
- **Admin sales-tax-return page and the CSV in accounting/routes.ts:** should display the per-authority, per-rate and reclassification sections.
- **Follow-up, not done:** the database-level access policy on `loyalty_accounts` could be tightened to filter by company.

## Other files I touched
- The three existing tests that looked up loyalty accounts by customer alone: `customersReconcile.test.ts`, `loyalty.test.ts`, `orderLifecycle.test.ts`.
- `schema.prisma`, the LoyaltyAccount model plus the matching relation on Customer, with the client regenerated.

`chartOfAccounts.ts` was not changed: 2032 and 2080 already exist in every company's chart.
