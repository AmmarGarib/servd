# Cash requests and petty cash — for everyone who asks for cash, the box custodian (Jamil sb) and finance

Dated 2026-10-14. Two pages in servd handle small cash:

- **Finance -> Cash requests** - how anyone asks for cash to buy something,
  gets it, and shows what it was spent on.
- **Finance -> Petty cash** - the cash boxes themselves: who holds them,
  what went in and out, counts, and how they tie to the books.

GS Foods holds **no cash of its own** (H1). The cash comes from the
**Garibsons cashier**, who hands it to the box custodian. servd records only
the cash-in; what it owes Garibsons is account 2210 "Due to Garibsons".

## Part 1 - Cash requests

### The flow in one line

**Anyone raises -> the HOD signs -> the director (CEO) approves -> the cashier
(Jamil sb) pays and marks it paid -> the person who took the cash uploads the
receipts.**

```
draft -> HOD signed -> approved -> paid -> receipts in -> settled
   \          \           \
 rejected / cancelled (at any step before paid)
```

### 1. Raising a request (anyone)

Finance -> Cash requests -> **New request**. Fill in:

- **Amount** and **what it is for** (say it in plain words).
- **Category** - what kind of expense it is: cleaning and supplies, repairs,
  electricity, water, gas, marketing, transport, licences, office and
  stationery, courier, staff welfare, phone top-ups. The category decides which
  expense account the money is charged to **the moment it is paid** (H3).
  Food, drinks and packaging are **not** categories here: food bought for
  cash comes in on the receipts as a stock line (section 4).
- **Who takes the cash** (the **holder**) - the person who will buy the thing
  and bring the receipts. It defaults to you.
- **Brand or department** if it belongs to one.
- Finance and management can also pick the **cash box** and name an exact
  expense account.

You can raise only in the company you are working in. Raising, signing,
approving and printing a request **never move any cash**.

### 2. HOD signs

The **head of department** is the holder's direct reporting manager (the same
reporting line HR uses). Finance and management can sign for anyone. **The
holder can never sign their own request.** The HOD opens **Cash requests ->
Waiting for my signature**, checks it and signs (or rejects).

### 3. The director approves

Only the **CEO** approves, and **never the same login that signed as HOD**
(`SAME_SIGNER`). Approvals also appear in the CEO's approvals inbox as "Cash
requests". The confirmation says: *the cashier may now pay it; it is booked to
its category when paid.*

### 4. The cashier pays (Jamil sb)

When a request is **approved**, the cash custodian of the box (or finance)
opens it and presses **Pay**. There is **no photo and no signed paper** at this
step any more. Pay does everything in one go:

- takes the cash out of the **box** (the request's box, or the custodian's
  only open box in that company);
- books it **as an expense in its category** - *Dr the category's expense
  account / Cr 1011 Petty Cash* (H3: "expense at payment; receipts kept for
  the file");
- starts the clock: **receipts are due within 30 days** (a company setting:
  Configuration -> Operations -> "Receipts due within (days)").

If the box does not hold the amount, the whole thing is refused
(`INSUFFICIENT_FLOAT`) and nothing happens. If the month is closed, `PERIOD_LOCKED`.
A request can be paid **once**. There is no 1355 "advance" any more for new
requests.

### 5. The holder uploads the receipts

The holder (or finance) opens the request and uploads the **receipts**: photos
(JPEG, PNG, WebP) or PDF, up to 3 MB each, up to 20 per request. **Receipts are
evidence kept for the file; uploading one books nothing by itself.**

Then the holder (or finance) **settles** with the receipts, line by line, to say
what the money really was spent on:

| Receipt shows... | What servd does |
|---|---|
| The **same category** as the request | Nothing - it is already booked there. |
| **Another expense category** | Moves that amount from the paid category to the right one (Dr the right account / Cr the paid account). |
| **Food, drinks or packaging bought** (a **stock item** line: item, quantity, unit, amount) | Brings it into stock through receiving (a settled "Cash purchases" receipt, FIFO lot) and moves the cost to the stock account (Dr 1210 / 1220 / 1230). Stock keepers only. |
| **Equipment** (an **equipment** line tied to a CapEx line) | Books it through CapEx (Dr 1340 advance for that line) so it can be capitalised. See `docs/fixed-assets.md`. |

The sum of the receipts cannot be more than what is still open on the request
(`RECEIPTS_OVER_REQUEST`). **Finance can re-assign an expense line to another
account later** (the old entry is reversed and re-posted); a stock or
equipment line cannot be re-assigned.

### 6. Change goes back to the box

If the holder spent less, they hand the **change** back to the cashier and
the cashier records **Return change** on the request (amount, box). The cash
goes back into the box and the books move it from the paid category back out:
*Dr 1011 / Cr the paid category*. A request is **settled** when receipts plus
change cover the amount.

### 7. If receipts are late

Every morning at 09:10 servd looks for requests that are **paid, past their due
date, with no receipt uploaded**. Each one is flagged **once** in Finance ->
Exceptions as "Cash request receipts overdue" with the open amount. **No money
moves** - the expense is already booked. A holder who uploaded receipts but
never finished settling is not flagged (the flag is only for "no receipt at
all"). Finance chases the holder. The request simply stays open: servd no longer
converts an unexplained amount into a staff advance by itself.

### 8. What changed for you (from the old signed-voucher flow)

- Nobody prints and signs a paper before the cash is paid; the cashier presses
  **Pay**. (A printable copy of the request still exists.)
- The cash is **expensed when it is paid**, not when receipts arrive.
- Receipts are uploaded **by the person who took the cash**, not the cashier.
- Old vouchers paid by the photo flow and still open stay as they were: they
  settle against the old advance account 1355, and one with **no named holder**
  shows as **needs review** until finance names the holder.
- A legacy free-text category cannot be paid until finance picks a proper one.

## Part 2 - Petty cash boxes

### Boxes

A **box** belongs to one company and has one **custodian** (the person who
holds the cash). Finance, management and the CEO open boxes. Every rupee in a
box sits on account **1011 Petty Cash**. The safe (account 1010) is separate.

When a box is opened, finance says **where the opening cash came from**: the
Garibsons cashier (default), the safe, a bank account, or a till drawer.

### Putting cash in (top-ups) - always say where it came from

| Source | Booked as | Who |
|---|---|---|
| **Garibsons cashier** (the usual) | Dr 1011 / Cr **2210 Due to Garibsons** | finance, or the custodian |
| **The safe** | Dr 1011 / Cr 1010 | finance, or the custodian |
| **A bank account** (named) | Dr 1011 / Cr that bank's account | finance, or the custodian |
| **A till drawer** (a shift's cash, the drawer must hold it) | Dr 1011 / Cr 1015; the drawer shows a pay-out; the shift close does not book it again | finance only |
| **Change on a cash request** | Dr 1011 / Cr the paid category | the cashier, on the request |

A top-up with no source is refused (`TOPUP_SOURCE_REQUIRED`).

### Taking cash out

- **Spend.** A custodian or finance records a spend: what it was for
  (category lines, or a **supplier bill paid in cash**), the brand, and the
  receipt photo(s). A spend of **PKR 500 or more needs a receipt photo**
  (company setting `PHOTO_REQUIRED`). A spend can have several lines: expense
  lines, a **stock item** line (food bought, goes through receiving) or an
  **equipment** line (through CapEx). Booked Dr each line's account / Cr 1011.
  Paying a supplier's bill in cash books Dr 1010 / Cr 1011 and the bill's
  payment on top. Nothing else takes money out of a box: this is the one exit.
- **Return** (finance): hand cash back **to the safe, a bank, or Garibsons**
  with a reason. Booked Dr 1010 / the bank / 2210, Cr 1011.
- **Transfer** between two boxes of the same company: no entry (both are 1011).

### Counting a box

**Count** the box when the custodian changes or whenever finance wants. Type
what is physically in the box; servd compares with what the box should hold.
A shortage is booked **Dr 8010 (cash short/over) / Cr 1011**, a surplus the
other way, and a zero difference books nothing. Counts and spends are always
relative to what the box holds now - servd never "sets" a float to a number.

### The tie-out

The Petty cash page shows a **tie-out**: the sum of all open boxes' floats
against the ledger balance of 1011, per company. If they differ it says by how
much, and the server health check (added at deploy) warns.

### History - one time, the CEO

Before this release the boxes had moved cash with nothing in the books. The CEO
runs **Reconciliation -> Backfill unposted -> Petty cash history** once per
company:

1. **Dry run first.** For each company the CEO says where the money already in
   the boxes came from: **the safe (1010)** (the default - servd treats the
   history as coming from the safe, H2) or **the Garibsons cashier (2210)**.
2. The page shows the resulting 1010 balance and **warns in red if it would go
   negative** (GS Foods holds no cash, so "from the safe" can overshoot - pick
   Garibsons for that company).
3. Rows that cannot be placed show as **needs a category** (pick one, or an
   account code) or **needs review** (safe, Garibsons or a bank).
4. Changing a pick means running the dry run again. Then **Post**.

Entries are dated by owner decision 6: a closed month posts into the open
month with a note naming the original date. Legacy cash vouchers are booked as
advances (1355) and settle against it.

## Quick answers

- *I need cash to buy cleaning supplies.* Raise a request, category Cleaning
  and supplies. After it is paid, buy, then upload the receipts.
- *I bought food with a cash request.* Add a **stock item** line when you
  settle, with the item, quantity and amount.
- *I spent less than I was given.* Give the change to the cashier; they press
  **Return change**.
- *The Pay button says "not enough in the box".* Finance tops the box up first
  (section Part 2).
- *I am the HOD and the request is mine.* You cannot sign it; your manager
  signs, or finance does.
