# Corporate clients on account — runbook

For finance, cashiers and the accountant. A corporate client (a company that
eats with us and pays later) gets QR cards. A cashier scans a card, the whole
bill is charged to the client's account, and finance sends a **monthly
statement**. Everything here is **off per company** until finance has created
a client and the CEO has approved it: until then the till shows no "On
account" button, and no statement or reminder is ever sent automatically.

Related: `docs/receivables.md` (statements and write-offs),
`docs/TAX_SETUP.md` section 15 (tax), `docs/raast.md` (till clearing),
`backend/src/modules/pos/README.md` (the till API).

---

## Part 1 - Finance

### 0. First, the CEO's till-clearing split (1110 -> 1115)

Before on-account, account **1110** held two different things: money owed
by customers on invoices, and "till clearing" (cancelled tickets whose money is
owed back, card tenders that failed after the close, Raast "customer owes"
write-offs). Clients are going to live on 1110, so till clearing moves to a new
account, **1115 Till Clearing**.

- It happens **once per company, automatically, at boot**; there is nothing
  to switch on. A settings marker `ledger.tillClearingCutoverAt:<company>`
  records it.
- It moves only the net of entries from till sources (shift close, the
  cancelled-ticket hand-back and unwind, card failed after close, Raast
  customer-owes write-off, and their reversals) as one entry
  `ledger.till_clearing_split:<company>` (Cr 1110 / Dr 1115, or the reverse if
  the net is negative).
- **Manual journals and opening balances on 1110 are never moved.** They are
  listed on the tie-out and flagged for finance to look at.
- After the cut-over a daily job (03:10 PKT) moves only the reversals of
  pre-cut-over till entries, and flags anything else posted to 1110 that is
  neither a receivable nor on-account (`till_clearing_unexpected`). Nothing is
  moved silently.
- If a period is closed over the date, the split is **refused and flagged**
  (not lost). Fix it from Reconciliation -> posting failures once the period is
  open; it posts once.
- Raast "Not received" write-offs now default to 1115.

### 1. Create a client (and the CEO approves it)

Finance -> Receivables -> **Clients** (`/accounting/receivables/clients`).
Roles: admin, owner, management, finance. The F&B manager cannot see
NTNs, CNICs or limits.

1. **New client**: legal name, trade name, NTN / STRN / CNIC, address, contact
   name, phone and **email** (needed for statements), **credit limit**,
   **terms** (days, default 30), **overdue grace** (days, default 7), "bill
   must carry a reference" (a PO number the cashier must type), and the brands
   the client may use (empty = every brand of the company). It gets a number
   `OA-0001` and starts **pending**.
2. The **CEO approves** in Approvals -> "On-account clients" (or on the client
   page). Not delegable; a CEO's own new client is approved at once. Until
   approved the client cannot be charged.
3. **Limit:** a higher limit is a request the CEO approves; a **lower** limit
   and a **suspension** apply at once. Only the CEO can reactivate a
   suspended client. A client can be **closed** only at zero balance.

### 2. Cards: issue, print, rotate, lost card

- **Issue**: client page -> Cards -> New card (a label such as "Ali - finance
  dept"). The code is shown **once**, as text and QR; servd stores only a hash
  and a hint. Print it right away.
- **Rotate**: a new code replaces the old, which is revoked at once ("rotated").
- **Lost or stolen card**: **Revoke** it with a reason. A revoked card used at a
  till is refused and raises one flag per card per day, so you see the attempt.
- A card belongs to one company; another company's till does not recognise it.

### 3. The monthly statement run

Receivables -> Clients -> **Issue statements** (or one client's page ->
New statement). Pick the period end (calendar month, Karachi time).

- A statement holds the client's charges up to the end of that day whose sale
  is **already booked** (its till shift is closed). Open-drawer bills stay "not
  billed yet" and go on the next one. Refunds already reduce it.
- One statement per client per period (`STATEMENT_EXISTS`); clients with
  nothing to bill are skipped.
- **Statement HTML**: every bill with date, order ref, brand, card, the
  client's reference and the **fiscal number** of the sale, the previous
  balance, total due, due date and our bank details. It says "Statement - not a
  tax invoice".
- **Send**: emails it with the company as reply-to. Nothing is automatic. A
  test company or the practice copy sends nothing. A client with no email gets
  `NO_EMAIL`.

### 4. Chasing

- The client list shows exposure (unbilled + owed), available credit and
  overdue. A daily flag (09:20 PKT) lists clients overdue or with unbilled
  charges that have sat too long.
- **Remind** sends an overdue email, at most once per Karachi day
  (`REMINDED_TODAY`).
- When a client is more than its grace days past a statement's due date, **the
  till refuses new charges** (`ON_ACCOUNT_OVERDUE`) until it pays. There is no
  override at the till.

### 5. Payments, withholding and sales tax withheld

Record on the **statement**, as for an invoice (receivables doc): the method,
the **payment reference #** (always required), and the bank account for a
bank method. Posts *Dr bank / Cr 1110*. There is no automatic spread across
statements: pick the statement.

- **Income tax the client withholds** is a withholding certificate on the
  statement.
- **Sales tax the client withholds** (H13) goes to 1335 and is netted in that
  authority's return. A statement mixing FBR and SRB brands is refused
  (`STATEMENT_MIXED_AUTHORITY`): record it per authority by hand.

### 6. Write-offs

A statement is written off like an invoice: finance asks with a reason and
evidence, the **CEO approves every write-off**. It posts *Dr 6160 / Cr 1110*
for the full amount including tax, **split per brand** in proportion to the
statement's bills. **The client is suspended automatically**; only the CEO
reactivates. Recoveries (and a bounced recovery) work as for invoices.

---

## Part 2 - Cashier

1. On the bill, tap **On account**. (If the button is not there, the company
   has no active client, or you are offline: it is not available offline.)
2. **Scan the client's card** (or type its code). The screen shows the
   client's name and the credit still available. You do **not** see their
   limit, NTN or balance.
3. If the screen asks for a **reference**, type the client's PO number.
4. Confirm. The **whole bill** is charged. No manager PIN is needed.
5. Print the receipt. It says "On account" and has a **client signature
   line**: ask the person to sign and keep the slip with the drawer.

**What the till refuses** (read the message to the guest; there is no override):

| Message | Meaning |
|---|---|
| Card not recognised | Wrong code or another company's card |
| Card revoked | The card was cancelled (lost or replaced). Do not accept it; finance is alerted |
| Client not active | Pending approval, suspended or closed |
| Brand not allowed | The client may not eat at this brand |
| Over limit | The bill is more than the available credit |
| Overdue | The client has an unpaid statement past its grace |
| Whole bill only | Something is already paid on the bill, or it has a tip, promo, wallet, gift card or loyalty credit. Remove it or use another tender |
| Not available here | Delivery, pickup, offline, or not a till bill |
| Reference required | Type the client's reference |

**Refunds:** a refund of an on-account bill goes **back to the client's
account only**, never cash or card. Use the normal refund screen; "On
account" is the only option offered. A manager's PIN rules for voids are the
same as for any bill. The refund files the fiscal return and lowers the
statement if one was already issued.

---

## Part 3 - Accountant

### 1110 versus 1115

| Account | Holds |
|---|---|
| **1110** Accounts Receivable | What corporate clients owe: *Dr 1110* per client when the charge is booked, *Cr 1110* on payment, refund, write-off. Also ordinary receivable invoices |
| **1115** Till Clearing | Everything the till owes or is owed that is not a client: cancelled-ticket money owed back, card tenders failed after the close, Raast "customer owes" write-offs |

Rules: all **new** till-clearing posts go to 1115. Reading old data looks at
**both** codes. Nothing on 1110 is a till line after the cut-over; any such line
is flagged, never moved quietly. Raast "customer owes" write-offs default to
**1115**. The 1110 -> 1115 cut-over moved only till-sourced net; see Part 1.

### The sale and the statement (H14)

- The charge is a **sale**, booked at the shift close (till) or at order
  completion (web) like any sale: revenue, output tax at the **cash** rate, and
  *Dr 1110 (client)* instead of cash. One fiscal document is filed at that
  moment, naming the client as buyer, with FBR payment mode 2 (cash) until the
  vendor confirms (OA-FBR-MODE).
- The **statement is not a tax invoice**. It files nothing, posts no entry,
  issues no number from the tax-invoice series, and never changes output tax.
  Paying it posts only *Dr bank / Cr 1110*.
- **Cash tax class:** on-account is taxed at `taxRateCash` (15%), not the card
  rate (open question OA-RATE). The charge is refused if the re-priced bill is
  not at that rate.
- A refund credits 1110 and the charge through the one refund engine; a
  statement is never corrected by a credit note (`STATEMENT_CREDIT_AT_TILL`).
- No loyalty points are awarded on an on-account bill.

### The tie-out

Receivables -> Clients -> **Tie-out** (per company) compares 1110 to the
sub-ledger:

`1110 in the GL = open invoices + open statements + charges booked but not
yet on a statement` (+ charges not booked yet, shown separately because their
shift is still open).

It returns the difference and lists unexplained 1110 lines (manual journals,
opening balances). The period close has a check for it; fix the difference or
explain it before closing. A flag `till_clearing_unexpected` points at a line to
decide on.

### Open questions (answers pending, defaults built)

G14 the tender's shape (whole bill, no PIN, no offline, no split), OA-RATE,
OA-CREDIT (the CEO approves), OA-BLOCK (block when overdue), OA-FBR-MODE,
OA-ST-WHT (one authority per statement). Change in code only on the owner's
or the accountant's answer.
