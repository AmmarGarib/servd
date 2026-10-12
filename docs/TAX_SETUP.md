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
