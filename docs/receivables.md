# Receivables — sales invoices, tax a client withholds, and bad debts

Dated 2026-10-14. For finance (Hasnain) and the CEO. The page is
**Accounting -> Receivables**. It is for **ordinary sales invoices**: money a
customer owes GS Foods for a sale made on credit and invoiced by finance (a
catering job, a bulk order, an event).

This page is only about ordinary sales invoices raised by finance. Till clearing
stays on account 1110, exactly as before.

## The invoice

**Raise an invoice** (finance, management, owner, CEO): customer name (and email,
phone, NTN if you have them), the **brand** it is for (the brand's province
decides which tax authority gets the sales tax - Sindh brands pay SRB), issue
date, due date, a description, the **amount before tax**, the **sales tax**, and
the revenue account (default 4090). The invoice number is `AR-YYYY-NNNN` per
company. The tax preview shows which account the tax will go to.

It posts, in the **invoice's company**: *Dr 1110 Customer receivables (the
total) / Cr revenue (net) / Cr the authority's output-tax account.*

What the customer still owes is one figure everywhere (the status, the aging,
the over-payment check):

> total - paid - credited - withheld - written off

A negative figure means the customer is **in credit** (a credit note on money
already received); a **refund** pays it out.

## Money coming in

- **Receive a payment**: amount, date, method (bank, cash, cheque, card), the
  bank account if it went to a bank. Booked *Dr the bank/cash account / Cr
  1110*. A payment larger than what is owed is refused (`OVERPAYMENT`); money that
  arrives on a written-off part is recorded as a **recovery** instead (below).
  Pick the **bank account** when the company has more than one
  (`BANK_ACCOUNT_REQUIRED`); the account must belong to this company.
- **Bounced cheque / wrong entry**: **reverse** the payment. The entry is
  reversed and the invoice owes again.
- **Credit note**: for returned goods or a price correction, against the
  invoice. It reverses revenue and the tax the invoice credited. A credit note
  can only credit what was **not** written off as a bad debt: if it would go
  past that, servd refuses with `WRITTEN_OFF_FIRST` and says how much is left to
  credit; recover or reverse the write-off first (see "Bad debts" below).
- **Refund**: pays out a customer who is in credit. *Dr 1110 / Cr the account
  it left from.*
- **Void**: cancels an invoice that has no payment against it. If a bad-debt
  request is still waiting on it, that request is cancelled too. An invoice
  with anything written off cannot be voided (`CANNOT_VOID`).

## Tax the client keeps back

A client that is a **withholding agent** (a company, a government body) may pay
you less than the invoice and send the tax to the authority itself. There are
two kinds. Both are recorded with **Record withholding** on the invoice; both
count as paid on the invoice.

| Kind | What it is | Booked as |
|---|---|---|
| **Income tax withheld (s.153)** | The client kept back income tax against our income tax and paid it to FBR. Enter the amount, the date and the certificate number. | *Dr 1330 Income Tax (WHT) Receivable / Cr 1110.* It is credited against our tax later. |
| **Sales tax withheld by the client (H13)** | The client kept back part of the **sales tax** on the invoice and paid it to the authority itself, as a withholding agent. | *Dr **1335 Sales Tax Withheld by Customers** / Cr 1110.* |

- Sales tax can only be withheld **up to the tax on the invoice**, less what
  live credit notes already took back and less what was already withheld
  (`OVER_SALES_TAX_WITHHOLDING`). The invoice must carry output tax
  (`NO_OUTPUT_TAX` otherwise).
- 1335 is tied to the **authority** that the invoice's tax was credited to (FBR,
  SRB, PRA, KPRA or BRA).
- **It is netted in that authority's sales-tax return.** On the return, each
  authority shows "withheld by customers (1335)", what is still available to
  set off, and "net after withholding". When you record the payment to the
  authority you tick **"Withheld by customers set off"** for the amount you
  are setting off (it can never be more than what is available, and only
  against the same authority). See `docs/TAX_SETUP.md`.
- A withholding certificate that was entered wrongly or later withdrawn is
  **reversed** from the invoice like a payment. A withholding that has already
  been set off against a tax payment cannot be reversed until that payment is
  voided (`WITHHELD_ALREADY_SET_OFF`).

## Bad debts: write off, approve, recover

When a customer will never pay, finance asks the CEO to write off the debt. The
CEO approves **every** write-off (G12/H15). There is no provision account:
the write-off is direct, with reason and evidence (H15).

1. **Finance asks**: on the invoice choose **Write off**. Enter the **amount**
   (up to what is still owed, tax included), a **reason** (10-500 characters),
   and attach **evidence** (1 to 5 files, up to 3 MB each: a photo of a
   returned cheque, the client's letter, a closed-company notice).
   One request per invoice at a time (`WRITE_OFF_OPEN`). Requests are listed on the
   Receivables page and in the CEO's approvals inbox as "Bad-debt
   write-offs".
2. **The CEO decides.** *Approve* posts at once: **Dr 6160 Bad Debts Written
   Off / Cr 1110, the full amount including the sales tax**, tagged to the
   invoice's brand, dated today. *Reject* needs a note. Finance can cancel its
   own request while it waits. A request the CEO raises is approved at once.
   If the month is closed through today the write-off is refused
   (`PERIOD_LOCKED`) and nothing is saved.
3. **Recovery.** If the customer later pays part or all of what was written
   off, finance records the **recovery** on the write-off (amount, date, method,
   bank account, reference). It books *Dr 1110 / Cr 6160* (the debt comes back
   and the bad-debt cost is reversed) together with the normal *Dr bank / Cr
   1110* payment. The date cannot be earlier than the day the write-off was
   approved. You cannot recover more than what was written off (`OVER_RECOVERY`).
4. **Reversing a recovery** (a cheque that bounced): reverse the payment as
   usual - servd also puts the amount back on the written-off figure and
   reverses the recovery entry (`RECOVERY_MISMATCH` if the pieces do not line
   up).
5. **Tax.** The write-off books the whole amount, tax included, against 1110.
   servd does not itself claim back the output tax on a bad debt - that is a
   tax-return decision for the accountant.

## Credit notes after a write-off

A write-off already takes the whole amount, tax included, out of 1110. A credit
note on the same money would lower revenue and output tax a second time and push
1110 negative. So the credit-note limit is **total less what is written off**
(net of recoveries), not just the total: a credit note that goes past it is
refused with `WRITTEN_OFF_FIRST`. Recover or reverse the write-off first if the
customer is really owed a credit.

## Who can do what

| Action | Who |
|---|---|
| Raise an invoice, receive, refund, credit note, record withholding, reverse, void | Finance, management, owner, CEO |
| Ask for a write-off, record a recovery | Finance, management, owner, CEO |
| Approve or reject a write-off | **CEO only** (never skipped, whoever asks) |
| Cancel a waiting request | The person who asked, or any of the roles above |

Every read and write is limited to the company you work in. An invoice of
another company is simply "not found".
