-- Supplier bills carry the income-tax withheld at source (s.153), so every
-- "still due" figure (payments, status, AP aging, supplier statement) can be
-- net of it — as ledger AP 2010 already is. Additive; no rows removed.

-- AlterTable
ALTER TABLE "supplier_bills" ADD COLUMN     "whtCents" INTEGER NOT NULL DEFAULT 0;

-- Backfill from the ledger: the WHT that postSupplierBill actually booked is
-- the 2040 (WHT payable) credit on the bill's own entry, reference
-- 'supplier.bill:<billId>', in the bill's supplier's company. Bills with no
-- such entry (never posted, e.g. a supplier with no company) stay at 0.
UPDATE "supplier_bills" b
SET "whtCents" = w.wht
FROM (
  SELECT substring(je."reference" FROM 15) AS bill_id, je."tenantId" AS tenant_id,
         SUM(CASE WHEN jl."type" = 'credit' THEN jl."amountCents" ELSE -jl."amountCents" END) AS wht
  FROM "journal_entries" je
  JOIN "journal_lines" jl ON jl."journalEntryId" = je."id"
  JOIN "accounts" a ON a."id" = jl."accountId"
  WHERE je."reference" LIKE 'supplier.bill:%'
    AND a."code" = '2040'
  GROUP BY 1, 2
) w, "suppliers" s
WHERE b."id" = w.bill_id
  AND s."id" = b."supplierId"
  AND s."tenantId" = w.tenant_id
  AND w.wht > 0;

-- A bill paid net of withholding is paid: its AP in the ledger is already
-- zero, but the old gross rule left it 'partially_paid' for ever.
UPDATE "supplier_bills"
SET "status" = 'paid'
WHERE "status" IN ('open', 'partially_paid')
  AND "whtCents" > 0
  AND "paidCents" > 0
  AND "paidCents" >= "totalCents" - "whtCents";
