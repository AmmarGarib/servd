# FBR + SRB tax-invoicing setup — operator runbook

Pakistan's e-invoicing regime has two layers for restaurants:

| Authority | What it covers | Who must comply |
| --- | --- | --- |
| **FBR** (Federal Board of Revenue) via PRAL | Federal sales tax on goods | Tier-1 businesses nationwide, under SRO 1307(I)/2022 |
| **SRB** (Sindh Revenue Board) | Provincial sales tax on services | Restaurants located in Sindh |

A restaurant in Karachi reports to **both**. A restaurant in Lahore (Punjab) reports only to FBR (Punjab has its own PRA, not yet integrated here). A restaurant in Islamabad reports only to FBR.

This guide covers the registration and credentials side. The code side is already shipped — both adapters are at `backend/src/adapters/fbr/` and `backend/src/adapters/srb/`, and both workers run when their respective env vars are set.

---

## 0. The lie you've probably been told

POS vendors will tell you that you need to buy their "FBR-approved" or "SRB-approved" POS to be compliant. **This is false.** Neither FBR nor SRB certifies POS hardware or software. They publish an API, and any system that submits invoices to that API in real-time and gets back valid invoice numbers is compliant. Servd does this. You don't need a second POS.

What POS vendors sell you is (a) the integration work — already done in this codebase, and (b) their PRAL account that you share with their other clients. You own neither.

If you register your business with FBR and SRB directly and use servd, you (a) save the recurring monthly fees per outlet, (b) own your relationship with the tax authorities, and (c) keep all your order, kitchen, inventory, and reporting in one system.

---

## 1. FBR PRAL registration

### What you'll need

- Your business's **NTN** (National Tax Number).
- Your business's **STRN** (Sales Tax Registration Number) — if you don't have one, register at https://e.fbr.gov.pk first.
- A bank account in the business name.
- Your restaurant's physical address and GPS coordinates.

### Steps

1. Go to https://e.fbr.gov.pk and log in with your business NTN.
2. Navigate to **Registration → POS Registration**.
3. For each branch/concept, submit:
   - Business name and STRN
   - Branch address
   - Number of POS terminals (1 is fine to start — each POS = one POSID)
4. FBR assigns a **POSID per POS terminal**. Note these down — one POSID per Concept in servd.
5. Set a PRAL portal password. Note your **PRAL username** (usually your NTN) and **password**.
6. Drop both into `backend/.env`:
   ```
   FBR_USERNAME="<your-NTN>"
   FBR_PASSWORD="<your-PRAL-password>"
   FBR_ENV="sandbox"     # leave on sandbox for initial testing
   ```
7. Restart the backend.
8. Open the admin app → **Configuration → Concepts** (or wherever you manage brands) → for each concept, fill the **FBR POSID** field with the matching POSID. (If the field isn't surfaced in the UI yet, set it directly on the database: `UPDATE concepts SET "fbrPosId" = <id> WHERE id = '...'`.)

### Testing

In sandbox mode, FBR will accept your submissions without showing up on real returns. Place a test order through `/pos`. After ~5 seconds, check the order — it should have an `fbrInvoiceNumber` value. Also visible at `/settings/integrations` → FBR card → "Invoices submitted" counter.

When you're ready to go live, switch `FBR_ENV="production"` in `.env` and restart.

---

## 2. SRB registration (Sindh only)

If your restaurant is in Punjab/Islamabad/KPK/Balochistan, skip this section — SRB doesn't apply to you. Leave `SRB_*` env vars unset and the SRB card on `/settings/integrations` will stay grey-not-configured forever, which is correct.

### What you'll need

- Same NTN + STRN as above.
- SRB sales-tax registration (a separate filing from FBR's, even though much of the info is identical).

### Steps

1. Go to https://e.srb.gos.pk → register your business if not already.
2. Navigate to **Restaurant Registration** → **Electronic POS Integration**.
3. Submit each restaurant location. SRB issues a **POSID** per registered restaurant.
4. Set portal username + password.
5. Drop into `backend/.env`:
   ```
   SRB_USERNAME="<your-SRB-username>"
   SRB_PASSWORD="<your-SRB-password>"
   SRB_ENV="sandbox"
   ```
6. Restart the backend.
7. Set each Sindh-located concept's `srbPosId` (same approach as FBR's `fbrPosId`).

### Testing

Place a test order. The order should pick up both `fbrInvoiceNumber` (federal) and `srbInvoiceNumber` (provincial). Both submissions are independent — if one fails, the other still goes through, and the failed one retries on its own backoff (6 attempts, exponential).

---

## 3. Per-concept POSID assignment

Both authorities issue a POSID per *physical location*, not per business. If you run Stax on Bukhari Commercial and Stax on Clifton, you get two FBR POSIDs and (if Sindh) two SRB POSIDs.

In servd, that maps to: each `Concept` row holds its own `fbrPosId` and `srbPosId`. The workers look these up per order and silently skip if a concept has no POSID for that authority. So:

- Concept with `fbrPosId = 12345, srbPosId = null` → submits to FBR only. Useful for concepts outside Sindh.
- Concept with both set → submits to both.
- Concept with both null → no electronic invoicing. Receipts print without FBR/SRB invoice numbers or QR codes.

---

## 4. Receipts and the FBR QR code

Once an order has an `fbrInvoiceNumber`, the receipt printer template should render the FBR QR code (built from the invoice number) at the bottom of the receipt. This is a compliance requirement — customers need to be able to scan and verify the invoice on FBR's public portal.

The receipt template is in `backend/src/modules/receipts/`. If your receipts aren't showing the QR code, the template needs an update — flag this in chat and we'll fix it.

---

## 5. Going live

Once you've tested in sandbox and the counters at `/settings/integrations` show invoices flowing:

1. Coordinate a low-traffic time (Sunday morning is good).
2. In `backend/.env`, switch `FBR_ENV="production"` and/or `SRB_ENV="production"`.
3. Restart the backend.
4. Place a small real order and verify the invoice number is returned.
5. Check the FBR portal: https://e.fbr.gov.pk → POS Reports → your submissions should be there within minutes.

From this point on, every completed order auto-submits. If a submission fails permanently after 6 retries, you'll see a `[FBR] COMPLIANCE:` or `[SRB] COMPLIANCE:` line in the backend logs — set up a CloudWatch / Sentry / Slack alert on that string for production.

---

## 6. Troubleshooting

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| `FBR credentials not configured` error in logs | Env vars not loaded | Restart backend after editing `.env` |
| Order has no `fbrInvoiceNumber` after 30s | Concept's `fbrPosId` is null | Set the POSID on the concept |
| `PRAL auth failed: 401` | Wrong username/password | Double-check from PRAL portal; passwords are case-sensitive |
| `PRAL rejected invoice: …` | Schema mismatch (very rare) | Paste the full error back to chat — usually a field name change on PRAL's side |
| `[FBR] COMPLIANCE:` in logs daily | Permanent submission failures | Check PRAL portal status, verify NTN/POSID match, check tax rate on the concept |
| SRB card stays "Not configured" forever | You're outside Sindh, or SRB env vars unset | Both are fine — SRB only applies to Sindh restaurants |

If you hit something not listed, paste the exact error from the backend terminal (where `npm run dev` is running) and we'll route it from there.
