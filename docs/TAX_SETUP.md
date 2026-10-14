# Fiscal POS connector — FBR + SRB filing runbook

Pakistan's e-invoicing regime has two layers for restaurants:

| Authority | What it covers | Who must comply |
| --- | --- | --- |
| **FBR** (Federal Board of Revenue) via PRAL | Federal sales tax | Tier-1 businesses nationwide, under SRO 1307(I)/2022 |
| **SRB** (Sindh Revenue Board) | Provincial sales tax on services | Restaurants located in Sindh |

**servd does not file with FBR or SRB itself.** The direct FBR PRAL and SRB
clients, their workers and the `FBR_*` / `SRB_*` environment variables are
gone (owner decision, 2026-10-10). An **external fiscal POS** — a vendor's
system that is registered with the authorities — is the only filer. servd is
the order-taking software: it sends each full & final sale to that POS through
the **POS connector**, gets the fiscal invoice number and QR back, and prints
them on the bill.

The vendor contract (what the fiscal POS must implement) is
[`docs/pos-connector-api.md`](./pos-connector-api.md) — "servd connector API v1".
The code is in `backend/src/connectors/`.

---

## 1. What gets filed — and what never does

| Bill | Sent to the fiscal POS? |
| --- | --- |
| **Pre-bill** — the guest check printed for an OPEN order before payment (`PRE-BILL — NOT A TAX INVOICE`, number `PB-<n>`) | **Never.** No fiscal document is created. Every pre-bill print is kept permanently in Finance → **Voided pre bills**. |
| **Full & final (FnF) bill** — the bill of a fully paid, completed order (`FULL & FINAL BILL`) | **Yes, exactly once.** The sale document is created inside order completion, so every way an order completes (till, waiter, online, rider, comp) files once. |
| Refund after the FnF bill | Yes — a fiscal refund (credit note) document. |
| Cancel / void before the FnF bill | Nothing goes to the POS. Voids and whole-order cancels need a **manager** (a manager's own login or a same-company manager PIN). |

**No real sale is ever skipped by a person.** There is no Skip button, no
date-range skip and no "skip held" at go-live. The only skips are automatic:
an order already filed directly before the cutover, a zero-value bill when the
company has chosen not to file those, a POS that cannot take zero-value bills,
or a refund with no sale to refund. "Record manual filing" (typing in a fiscal
number that was filed out of band) stays, with who and when.

---

## 2. Per-company switch: "Fiscal reporting required"

Each company decides once, for the whole company, whether its sales must be
filed. It is **on by default**.

- **On** (every trading company): every FnF sale creates a fiscal document.
  Until the company is live with a fiscal POS, those documents are **held** —
  visible, counted in `/health`, never sent — and are filed when the CEO
  releases them after go-live.
- **Off** (a test company, or a non-commercial kitchen such as the owner's
  home kitchen): no fiscal documents, no held backlog, no alerts, and receipts
  print "Not a tax invoice". The card machine still works.

Only the CEO (role `admin`) can change it, with a reason; every change is in
the audit trail (old → new). It never applies per sale, brand, order or date
range. Switching it back on applies to sales completed from then on.

### Switching it off — and back on

Where: Dev → API → POS connector → **Fiscal setup** → "Fiscal reporting" →
Change (CEO only, reason required).

- **What happens to sales already held.** Nothing is deleted or skipped. Sales
  held before the switch stay `held`, listed in Submissions, and the Status and
  Fiscal setup tabs show a note saying how many there are. While reporting is
  off they **cannot be released**: Release all held answers
  `409 REPORTING_OFF` (the button is greyed out with the reason). Documents
  that were already pending or failed keep filing while the fiscal POS stays
  live — switch the fiscal POS off as well if nothing more should be sent.
- **`/health`.** Held sales of a company with reporting off are not counted as
  a backlog: no `fiscalConnector` warning for them. Failed, rejected and
  file-by-hand documents of a company whose fiscal POS is still live are
  still reported until they are dealt with (Retry, or Record manual filing).
- **Switching back on.** Sales completed from then on are filed again. Sales
  completed while it was off have **no fiscal document** and are never filed
  by servd — if any of them must be filed, do it on the authority portal.
  The sales held from before the switch count as a backlog again (Status
  tab, `/health`) and release as usual: the fiscal POS must be live (else
  `409 NOT_LIVE` — go live first), then **Release all held**. Or record a
  manual filing for each one already filed outside servd.

---

## 3. What the vendor gives you

1. The fiscal POS vendor's name, base URL (https only) and an **API key** for
   each company.
2. Confirmation that they implement servd connector API v1 (idempotency keys,
   document lookup, refunds / credit notes, zero-value invoices), and a test
   environment.
3. The **POS registration ids** the authorities issued: one per brand, or one
   per outlet where the outlet registered separately. Sindh brands usually
   have both an FBR and an SRB id.

Register the business with FBR (https://e.fbr.gov.pk) and SRB
(https://e.srb.gos.pk) as the vendor instructs; the registration and the
credentials with the authorities belong to the vendor's system, not to servd.

---

## 4. Set it up (admin → Dev → API → POS connector)

Who: the CEO and IT (`CONNECTOR_ADMINS`). Management can look, not change.

0. **Once per server:** `SERVD_SECRET_KEY` must be set in the API's
   environment (`openssl rand -base64 32`, kept outside the repo). Without it
   no API key can be saved (`503 SECRET_KEY_MISSING`) and `/health` warns.
   The first time a server with the key reads the WhatsApp gateway settings
   (a send, the settings page, `/health`), it encrypts a key that was saved
   in plain text before this release (`enc:v1:…`). **Rolling the API back to
   an image older than the POS connector release breaks WhatsApp** (customer
   signup, staff code sign-in, password reset, 2FA): the old image sends the
   ciphertext as the gateway key. After such a rollback, re-enter the
   WhatsApp key in the old screen (Configuration → WhatsApp, `/configuration/whatsapp`) straight away.
   The SMTP password (Configuration → Email) is treated the same way from the
   ops-round-5 release: encrypted on save and on first read once the key is
   set (without the key it is still saved, in plain text, and `/health`
   `smtpPassAtRest` warns). Rolling back below that release sends the
   ciphertext as the SMTP password — re-enter it in Configuration → Email.
   Never roll back once a company is live (§4 step 5) in any case.
1. **Fiscal setup** tab: pick the driver, enter the base URL and the API key.
   Generate a webhook secret and give it, with the webhook URL shown, to the
   vendor (the secret is shown once).
2. Click **Test connection**, then **Dry-run sale** (a synthetic PKR 100 sale
   marked as a test; nothing is stored).
3. **POS IDs** tab: enter each brand's FBR and SRB POS id, plus any outlet
   overrides. This page is the only editor of the brand POS ids (the brand
   editor no longer has them). Every brand keeps its **province**: Sindh tax
   routing in the ledger (account 2032) still reads the SRB POS id.
4. Settings worth checking: sync timeout at the till (default 3 s — after that
   the sale prints "Fiscal invoice: pending" and files in the background),
   file zero-value bills (default yes), maximum age before a document is
   marked failed (default 72 h).
5. **Go live** (CEO only, type `GO LIVE`). It refuses with a list until: a real
   driver is picked, a test passed in the last 10 minutes, every brand that
   traded in the last 30 days has a POS id, and the old direct queues were
   drained. Sales completed from this moment are filed.
6. **Release all held** (CEO only; optionally one brand at a time, once that
   brand's POS id is in). Every sale completed before go-live is filed late.
   There is no date range and no skip.

The built-in `test` driver files `TEST-…` numbers and receipts say
`TEST — NOT A FISCAL INVOICE`; `/health` warns while a company is live on it.

While live, the driver and base URL cannot be changed
(`409 SWITCH_OFF_FIRST`): to move vendor, the CEO switches off, IT changes and
tests, the CEO goes live again. The API key can be rotated while live.

---

## 5. Day to day

- **Submissions** tab: every fiscal document with its status — `filed`,
  `pending` (includes held and waiting refunds), `failed` / `rejected`,
  `manual required`. Actions: Retry, Retry all failed, Record manual filing.
- Retries are automatic with backoff; a sale is never blocked at the till.
  Pending documents are re-driven every 30 seconds even when Redis is down.
- Problems raise an exception flag (Finance → Exceptions) and a WhatsApp
  notice to the CEO and IT: `fiscal_failed`, `fiscal_rejected`, `fiscal_auth`
  (the POS refused the key — paste the current key in Dev → API → POS
  connector), `fiscal_manual_refund` (a refund to file by hand).
- Reprints always re-read the order, so a sale filed after the first print
  shows its number and QR on the next print.

---

## 6. Troubleshooting

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| Every sale is `held` | The company is not live yet, or the brand has no POS id | Finish §4, go live, then Release all held |
| `NOT_READY` on Go live | The list says what is missing | Fix each item; run Test connection again (it counts for 10 minutes) |
| `503 SECRET_KEY_MISSING` when saving a key | `SERVD_SECRET_KEY` is not set on the API | Set it on the box and restart the API |
| `/health` `fiscalConnector: warn` | Held, failed, rejected, manual-required documents, an AUTH error in the last hour, or a company live on the test driver | Open Submissions; the detail line names the cause |
| `/health` `connectorSecretKey: warn` | Encrypted secrets exist but the key is missing or wrong | Restore the original `SERVD_SECRET_KEY`; otherwise re-enter the keys |
| Signup / staff sign-in codes stop after rolling the API back | The pre-connector image sends the encrypted WhatsApp key as-is | Re-enter the WhatsApp key in Configuration → WhatsApp (`/configuration/whatsapp`) on the old image (§4 step 0) |
| IT gets 403 on Dev → API pages | The CEO's saved Module Access row for `it` lacks `api_pos` / `api_whatsapp` (or a per-user deny) | CEO ticks the module in Module Access; new modules are added to saved rows once at deploy, an untick after that is kept |
| `409 SWITCH_OFF_FIRST` | Changing driver or base URL while live | CEO switches off, IT edits and tests, CEO goes live |
| A company should never file | It is a test or non-commercial company | CEO turns off "Fiscal reporting required" for that company (§2) |
| `409 REPORTING_OFF` on Release all held | "Fiscal reporting required" is off for the company; its held sales are kept | Switch it back on (§2), go live if needed, then release |
| `409 NOT_LIVE` on Release all held | The fiscal POS is not live | Go live first (§4 step 5), then release |
| A document says "Figures do not add up — not sent" | Its lines + tax + service + tip + delivery do not equal the bill, so it was held back (also in the Inbox) | A sale: check the order's stored figures and Retry (the sale is rebuilt from the order). Still wrong → file it on the authority portal and Record manual filing. A refund is never rebuilt — Retry only re-checks the same stored figures, so file it by hand and Record manual filing. If it says an earlier send's result is unknown, the fiscal POS may already have it and servd cannot ask this fiscal POS automatically (Retry will not settle it): ask the vendor outside servd; if they have it, record their fiscal number with Record manual filing; only if they confirm they never got it, file it on the portal and record that |

---

# Finance tax notes — what the books do with each tax (2026-10-14)

Sections 1-6 above are about **filing**, which the fiscal POS does. The sections
below are about the **books** and the **sales-tax return** that Hasnain
prepares in **Accounting -> Sales tax return**. servd never sends a return to
FBR, SRB, PRA, KPRA or BRA; it prepares the figures and records what was paid.
References like (H9) are Hasnain's numbered answers.

## 7. Delivery fee carries sales tax, added on top (H9)

- The zone's delivery fee is entered **before GST** (Configuration -> Delivery
  zones, field "Fee (before GST)"). At checkout GST is **added on top**.
- The rate is the order's **tender rate**, the same as the food: **15% cash**
  (including cash on delivery), **8% card, Raast, online and wallet** - the
  brand's own rates (`taxRateCash`, `taxRateCard`). It is the standard rate, so
  a zero-rated basket still pays GST on the delivery. The owner's answer:
  brand rate by tender.
- The fee and its GST are stored separately on the order. The customer sees
  them on checkout, the order tracker, the admin order page, the receipt (the
  printed GST row says how much of it is on delivery) and the tax invoice (a
  "Delivery charge" line).
- **Service charge and tip are never taken on the fee or its GST.**
- **In the books**: the fee is credited to **4110 Delivery Fee Income**, tagged
  to the brand (a sale, so it stays in the labour % base but is not "food
  sales"); the fee's GST is inside the output tax credited to the authority.
  A refund takes back its share of the fee. **A cancelled ticket unwinds the
  4110 credit** as well.
- **On the return** delivery charges are their **own supply row** (and a
  per-brand column), at the order's rate.
- **If the customer changes tender at the till** (cash instead of card) the
  order is re-priced: the fee's GST changes with the rate. A dish void never
  removes the fee's GST.
- **To the fiscal POS** the fee is its own invoice line "Delivery charge"
  (`DELIVERY-CHARGE`), with the GST on it. See `docs/pos-connector-api.md`.
- **Old delivery orders** (before 2026-10-14) keep their untaxed fee; they are
  not changed.

## 8. A kept no-show deposit is other income, no sales tax (H10)

When a guest with a booking deposit does not show up and the deposit is kept,
Hasnain's answer is that it is **compensation, not a supply**: **other income,
no sales tax**. It is booked to **4210 "No-show Deposits Kept (Other Income)"**
(shown below operating profit, never in sales KPIs) and **is not on the
sales-tax return**; the sales-tax return shows it in a separate box "Other
income, not taxable (H10)" for information.

Status on 2026-10-14: built. The new account 4210 is in every company's chart,
and a kept deposit now posts **Dr 1030 card receivable / Cr 4210** (tagged with
the brand) with **no tax line and no fiscal document**
(`reservation.deposit_capture:<reservationId>`). **Entries for deposits kept
before this change carry tax in the output-tax account**; the return still
lists those as "deposit kept (pre-H10)" rows, and finance corrects them with a
journal before filing, so the return does not declare tax on compensation.
Check on the first real one that the credit goes to 4210 with no tax line.

## 9. Gift-card breakage (H11)

The value left on a **sold** gift card when it **expires** (or when the CEO
chooses **Keep the money** on a sold card) is **breakage**: *Dr 2080 Gift Card
Liability / Cr **4200 Gift Card Breakage (Other Income)***, no sales tax. The
nightly sweep (00:10) expires cards and books the breakage in the card's
company. A **promotional** card's unused value goes to 6060 Marketing & Promo
instead. Breakage is taken **once**; value a refund later puts back on an
expired card waits on the card for a manager to settle. If the sale of the
card was never booked, the breakage is **held** with a flag until it can be
booked. Only the CEO can forfeit a sold card.

## 10. Card payouts: Keenu pays net, the fee is a cost (H12)

Keenu pays a day's card money into the bank **net** of its merchant discount
(MDR) and the **tax on that fee**. Book the net with the statement line and the
whole fee (MDR and the tax on it) as a **cost on 6080** - the tax on the fee is
not claimed back (H12): *Dr bank (net) / Dr 6080 (fee) / Cr 1030 card clearing
(the days' gross).*

In **Reconciliation -> Card payouts**:

- **Settings** (finance or the CEO, per company): the **payout bank**; whether
  the card machine ID (MID) is one for the company, per brand or per terminal;
  the **MDR %**, the **tax on the fee %**, how many days the bank lags, how
  many days one payout may cover (max 5), the tolerance, the largest fee
  accepted, and the first day to match from.
- When a statement is imported, servd tries to fit each credit on the payout
  bank to a run of **unsettled card days**. It matches **only if exactly one
  fit exists** - otherwise the line stays unmatched and the screen **suggests**
  the days; finance confirms, and the settlement posts. Never a guess.
- **Undo** (approvers): reverses the entry, frees the days and un-matches the
  line.
- A refused automatic payout raises one `card_payout_unmatched` flag per line.
  Period close **blocks** while card days are unsettled (`card_unsettled`); the
  CEO can close over it with a written reason.

## 11. Input tax by charging authority, set off only against that authority (H8)

Sales tax **charged to us** (on supplier bills, OpEx and CapEx) is recorded
as **input tax on the authority that charged it**:

| Authority | Output (we owe) | Input (we can claim) |
|---|---|---|
| FBR | 2030 | 1320 |
| PRA (Punjab) | 2031 | 1321 |
| SRB (Sindh) | 2032 | 1322 |
| KPRA | 2033 | 1323 |
| BRA | 2034 | 1324 |

Each bill, OpEx or CapEx line names the **tax authority**; a supplier can carry
a default. On the return each authority is computed on its own: **input is set
off only against the same authority's output**; a surplus carries forward in
that authority only. A restaurant's own tax is owed to the **province** its
kitchen is in (Karachi brands: SRB; a brand with no province stays on FBR and
the return flags it).

**Exception (Hasnain, 2026-10-14):** federal sales tax charged on **eligible raw
materials** - food ingredients such as meat, chicken, beverages and vegetables
- **may be set off against SRB / PRA output "as per SRB eligibility"**. This
applies to **food and drink stock** only (not packaging, services or
equipment). Status: built (2026-10-14). The eligible amount is read from the
ledger: a supplier bill's FBR input (1320) times the share of the bill that is
the company's own **food or drink** stock (`salesTaxReturn.ts
CROSS_SETOFF_ELIGIBLE_CLASSES`); OpEx, CapEx and petty-cash input never count.
It is **one pool per company**, and FBR output still owed in 2030 is paid from
1320 first. The return shows a column **"Federal input on raw materials (H8)"**
(claimable against each provincial authority, and the net after it), and
**Record payment** for SRB / PRA / KPRA / BRA has a field **"Federal input on
raw materials set off"** with **Use all**. The payment posts Cr 1320 for that
part. It is refused above what is claimable (422 `CROSS_SETOFF_TOO_LARGE`) and
on FBR, withholding or statutory payments (422 `NO_CROSS_SET_OFF`). What is
already used is read from the books, not from the payment list: any entry that
credits 1320 against an SRB / PRA / KPRA / BRA output account counts, including
a journal posted by hand that was never linked. Voiding a payment posted here
reverses it and makes the amount claimable again; unlinking a hand-posted entry
does not (its Cr 1320 is still on the books) — reverse that entry instead.

## 12. Income tax withheld from suppliers (s.153 / s.155) - rates and register

- **Rates** (Accounting -> Sales tax return -> **Withholding rates**; edited by
  the CEO or finance, per company). Four sections, each with a filer and a
  non-filer rate. The **placeholders** below came from the CA and **Hasnain
  must confirm them before anyone switches withholding on**:

  | Section | For | Filer | Non-filer |
  |---|---|---|---|
  | s.153(1)(a) | goods | 5% | 10% |
  | s.153(1)(b) | services | 9% | 18% |
  | s.153(1)(c) | contracts | 7% | 14% |
  | s.155 | rent | 15% | 30% |

  A rate cannot exceed 50%. The old single "withholding %" on Configuration ->
  Operations is gone: the rates are the one source, and the operations page
  keeps only the on/off switch.
- **Per supplier**: filer status (filer, non-filer, exempt, unknown), the
  exemption certificate number and the date it runs to, the usual section and
  the usual tax authority (Procurement -> supplier). A supplier with a
  certificate valid on the payment date is withheld **0**. An *unknown* or
  *exempt-without-a-date* supplier gets the filer rate and an amber "**check
  ATL status**" - look the supplier up on the FBR active-taxpayer list and fix
  the record.
- **Where it applies**: supplier bills (base = subtotal), OpEx payments (base =
  invoice less the input tax), CapEx payments (base = gross less the input-tax
  share; **deposits are never withheld**). The tax withheld is credited to
  **2040 Income Tax Withholding Payable** and paid with a "withholding" tax
  payment. OpEx and CapEx can carry a **one-off override amount with a reason
  (10+ characters)**.
- **Register** (Accounting -> Sales tax return -> **Withholding register**, CSV
  download): one row per deduction - date, document, vendor, NTN, filer status,
  section, rate, base, tax. Totals by section. **Caution from the CA:** the
  register's bill withholding is fixed at the **bill date**, while s.153 deducts
  at **payment**; check the month before issuing certificates.

## 13. Sales tax a customer withholds from us (H13)

Some corporate customers keep back part of our sales tax and pay it to the
authority themselves. The invoice page records it as **1335 Sales Tax
Withheld by Customers**; it is **netted in that authority's return** - on the
return page each authority shows "Withheld by customers (1335)", what is still
available, and the net. When you record a payment to an authority, enter
**"Withheld by customers set off"** (use all/part). It can never exceed what is
available for that authority at the payment date (`NO_WITHHELD_SET_OFF`,
`WITHHELD_SET_OFF_TOO_LARGE`). See `docs/receivables.md`.

## 14. Statutory payments: salary tax, EOBI, social security (H7)

Payroll deductions and employer contributions now sit in **three separate
payables** instead of one:

- **2042 Salary Income Tax Payable (s.149)** - paid to FBR;
- **2043 EOBI Payable** - employee 1% plus employer 5%, paid on the EOBI challan;
- **2044 Social Security Payable (SESSI / PESSI)** - employer contribution to
  the provincial scheme.

**Accounting -> Statutory payments** shows, per month and scheme, what was
**accrued** (from payroll), what was **paid** (challans recorded on the tax
payments register), and what is **still owed**. Payments are recorded the same
way as sales-tax payments (pick the scheme as the authority); month-end close
warns while a scheme has an unpaid balance.

**One-time reclass.** Months booked before this release put EOBI/SESSI on
2090 and salary tax on 2040. The CEO or finance runs **Reclass** once per
company (a preview first): it moves EOBI to 2043, SESSI to 2044 and salary tax
to 2042, never more than HR booked or than the old accounts still hold. It is
one-way: a final settlement cancelled after the reclass leaves 2043 overstated
and is fixed with a manual journal (the preview and a close warning point it
out).
