# Raast QR — cashier and finance guide

Raast QR replaced Keenu QR at the till on 2026-10-12. Tills now take **Cash,
Card – Keenu and Raast QR**. Raast is taxed like card (the digital rate).

## Before the first Raast sale (finance)

1. Finance → Bank accounts: for the account customers pay into, fill in its
   **Raast ID** and tick **Company default Raast account**. The account must be
   linked to a bank code in the chart. A brand that banks elsewhere gets its own
   account under **Raast by brand**.
2. Print the shop's Raast QR / Raast ID for the counter.
3. **Remove the old Keenu QR standees.** A payment someone still makes to an old
   Keenu QR is recorded as **Card – Keenu**.

## At the till (cashier)

1. Choose **Raast QR** before printing the final bill (the total is at the
   digital rate).
2. The customer pays the exact amount to the shop's Raast QR / ID.
3. **Check the money on the counter phone** (bank SMS or merchant app).
   **Never accept the customer's phone screen or a screenshot** — fake payment
   screens are common.
4. Type the **transaction ID** from the counter phone, tick *"I saw PKR X arrive
   on the counter phone"*, and take the payment.

The till refuses a reference already used on another bill, one that looks
wrong, or one from an older transfer. Refunds by Raast need a manager and the
reference of the transfer you sent back from the bank.

## Every day (finance)

Import the bank statement (Finance → Reconciliation). servd matches each Raast
payment to its statement line by reference, amount and date. In the **Raast**
tab:

- **Provisional** payments are waiting for the statement. A flag is raised when
  one is older than the configured number of days.
- **Match** pairs a payment with a line by hand; **Fix reference** corrects a
  mistyped reference (approvers only).
- **Not received** writes off a payment that never arrived (approvers; posts a
  balanced entry against the bank it should have reached). See "Not received or
  void" below.
- **Void, never booked** (CEO only) removes a provisional payment that the books
  never counted as bank money. See "Not received or void" below.
- **Resolve** closes a payment marked *needs attention* (refunded to the
  customer, not a sale, or booked elsewhere).

A month cannot be closed while Raast payments are unmatched, unless the CEO
closes it anyway (recorded).

## Not received, or void? (finance and the CEO)

Both are for a *provisional* Raast payment: the cashier said the money arrived,
but no bank statement line has matched it. They differ in **whether the books
already counted the money as in the bank**. Use this table.

| Question | Not received | Void, never booked |
|---|---|---|
| Who | Approvers (finance, management, owner, CEO) | **CEO only.** Finance, management and owners may **ask** (Void request, with a reason); the CEO voids or turns the ask down. |
| The bill | Any closed bill whose sale is **on the books** (the till shift is closed and posted, or the order completed) | A **cancelled or rejected** bill, and **no entry ever debited the bank** for this money |
| Ledger | Posts **Dr a contra account / Cr the bank it should have reached** (the receipt's receiving account). The contra is chosen when you press it: **1115** customer owes / till clearing (the default; **1110** for a company
that has not been cut over yet), **8010** cash short, or **1350** staff owes | **Posts nothing** |
| The reference | Stays used | Stays used: the same transfer can never pay another bill |
| Month close | The receipt no longer blocks the close | A voided receipt no longer blocks the close or the daily flag |

How to choose:

1. Was the sale **booked** with that money going to the bank? That is true
   when the till shift closed with the Raast money in it, or the order
   completed on the website. If **yes**, the books say "the bank has this
   money", so if it never arrived use **Not received**. The loss goes to the
   contra you choose (almost always the **till-clearing** account, "customer
   owes": **1110** for entries made before the till-clearing cut-over, **1115**
   after it; see below).
2. Was the bill **cancelled** (or rejected) and the money **never** put on the
   books as bank money (the drawer holding it is closed, nothing refused is
   waiting to be re-posted, and no refund was paid back against it)? Then
   there is nothing in the bank account to take out: use **Void, never
   booked**. If the money *did* arrive in the bank, finance books the
   statement credit with the bank line's own adjustment, like any other
   unexplained credit.

The void is refused (409) when: the receipt is not provisional
(`RAAST_NOT_PROVISIONAL`); a journal entry did debit the bank for it
(`RAAST_SALE_BOOKED` - use *Not received*); the bill is not cancelled or
rejected (`RAAST_ORDER_NOT_CANCELLED`); a till drawer that took the bill's
money is still open, or its close or a posting for the bill was refused and is
waiting to be re-posted (`RAAST_CLOSE_PENDING` - close the drawer or re-post
under Reconciliation -> Backfill unposted first); or money was already paid
back against that receipt (`RAAST_REFUND_EXISTS`). A void request already
waiting is `RAAST_VOID_ALREADY_REQUESTED`.

**At the till** a voided Raast payment is **not money taken**. On a cancelled
ticket the refund due, the choice of hand-back tender and the Z-report's
"cancelled and paid" no longer include it: a hand-back by Raast of a voided
payment is refused (`REFUND_METHOD_NOT_TENDERED`), and the Z-report shows the
voided amount on its own line ("Raast voided") so the Raast breakdown still
adds up. Voiding does not touch the sale itself.

## Wrong-brand QR (unchanged)

Nothing changed in this release about a customer paying to another brand's QR.
The receiving account on each receipt is still fixed when the bill is paid
(the brand's own **Raast by brand** account, else the company default), a
statement line on a different account still never matches (422), and finance
handles a payment that landed in the wrong place with the normal match, fix
reference or resolve actions. Till clearing (cancelled tickets whose money is
owed back, card tenders that failed after the close, Raast "customer owes"
write-offs) is **till clearing**. Before the company's one-time cut-over it sat
on **1110**; after it, all new till clearing posts to **1115 Till Clearing**
and the old balance has been moved from 1110 to 1115 (the CEO's split, see
`docs/on-account.md`). 1110 now means money owed by corporate clients and
ordinary invoices only. Entries posted before the cut-over are not rewritten:
a "not received" write-off already booked to 1110 stays there until the
cut-over moves it, and its reversal mirrors its own lines.

## Bank SMS matching (optional, off until the CEO switches it on)

A cheap Android phone at the counter holds the SIM that gets the bank's alerts
and forwards them to servd. Then a Raast bill can wait for the bank SMS and
complete itself. Set-up for IT: `docs/raast-sms-forwarder.md`. servd only
completes a bill when exactly one waiting bill matches the SMS — anything else
goes to the till's **Bank alerts** list for a person to attach. It never
guesses, and the bank statement is still the final check.
