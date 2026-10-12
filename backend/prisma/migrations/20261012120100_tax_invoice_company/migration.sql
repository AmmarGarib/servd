-- Tax invoices are per company.
--
-- tax_invoices."invoiceNumber" was globally unique while numbers are made from
-- a brand's prefix (concepts."invoicePrefix", else its slug). Two companies
-- whose brands use the same prefix both issued "<PFX>-2026-00001": the second
-- insert was a 500 — which also told company B that company A uses that
-- prefix. Numbers are now unique per company (tenantId, invoiceNumber), and
-- invoices/service.ts numbers them per (company, prefix, year, invoice /
-- credit note).
--
-- Backfill: the brand's company; a credit note carries its original
-- invoice's company. A row whose brand has no company (none expected) goes
-- to the oldest active company, with a NOTICE naming it.
--
-- invoice_counters (keyed by brand) is no longer read; it is left in place.
--
-- Safe to re-run: guarded DDL; the backfill only touches NULL rows.

ALTER TABLE "tax_invoices" ADD COLUMN IF NOT EXISTS "tenantId" TEXT;

UPDATE "tax_invoices" ti
   SET "tenantId" = c."tenantId"
  FROM "concepts" c
 WHERE ti."tenantId" IS NULL
   AND c.id = ti."conceptId"
   AND c."tenantId" IS NOT NULL;

-- A credit note belongs to the company of the invoice it corrects.
UPDATE "tax_invoices" cn
   SET "tenantId" = o."tenantId"
  FROM "tax_invoices" o
 WHERE cn."originalInvoiceId" = o.id
   AND o."tenantId" IS NOT NULL
   AND cn."tenantId" IS DISTINCT FROM o."tenantId";

DO $$
DECLARE
  fallback TEXT;
  r RECORD;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "tax_invoices" WHERE "tenantId" IS NULL) THEN
    RETURN;
  END IF;
  SELECT t.id INTO fallback
    FROM "tenants" t
   WHERE t."deletedAt" IS NULL
   ORDER BY t."isActive" DESC, t."createdAt" ASC, t.id
   LIMIT 1;
  IF fallback IS NULL THEN
    RAISE EXCEPTION 'tax_invoice_company: tax invoices exist but there is no company to assign them to';
  END IF;
  FOR r IN SELECT id, "invoiceNumber", "conceptId" FROM "tax_invoices" WHERE "tenantId" IS NULL ORDER BY "issuedAt" LOOP
    RAISE NOTICE 'tax_invoice_company: invoice % (%) - brand % has no company - assigned to the oldest active company %',
      r.id, r."invoiceNumber", r."conceptId", fallback;
    UPDATE "tax_invoices" SET "tenantId" = fallback WHERE id = r.id;
  END LOOP;
END $$;

ALTER TABLE "tax_invoices" ALTER COLUMN "tenantId" SET NOT NULL;

DROP INDEX IF EXISTS "tax_invoices_invoiceNumber_key";
CREATE UNIQUE INDEX IF NOT EXISTS "tax_invoices_tenantId_invoiceNumber_key" ON "tax_invoices"("tenantId", "invoiceNumber");
CREATE INDEX IF NOT EXISTS "tax_invoices_tenantId_issuedAt_idx" ON "tax_invoices"("tenantId", "issuedAt" DESC);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tax_invoices_tenantId_fkey') THEN
    ALTER TABLE "tax_invoices" ADD CONSTRAINT "tax_invoices_tenantId_fkey"
      FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;

-- ─── tax_invoice_series: O(1) numbering (review D-RV-3) ──────────────────────
--
-- One row per series — a company's numbers that start with `head`
-- ("<prefix>-<YYYY>-" or "<prefix>-<YYYY>-CN-") — holding the last number
-- issued. invoices/service.ts allocates with INSERT … ON CONFLICT DO UPDATE …
-- RETURNING inside the issuing transaction, instead of a MAX() over every
-- invoice the company ever issued (which ran under the series lock on every
-- completed order and slowed down as history grew).
--
-- Seeded once from today's numbers: for each company and head, the highest
-- sequence already issued. Only numbers of the shapes servd issues count
-- (…-YYYY-<digits> and …-YYYY-CN-<digits>), read by their SHAPE, not their
-- type: the per-brand counter this replaced numbered credit notes in the
-- invoice shape ("STX-2026-00042" as a credit note), and such a number is
-- taken in the invoice series all the same. Safe to re-run: the seed only
-- ever raises a series' last value.

CREATE TABLE IF NOT EXISTS "tax_invoice_series" (
  "tenantId"  TEXT         NOT NULL,
  "head"      TEXT         NOT NULL,
  "lastValue" INTEGER      NOT NULL,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "tax_invoice_series_pkey" PRIMARY KEY ("tenantId", "head")
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tax_invoice_series_tenantId_fkey') THEN
    ALTER TABLE "tax_invoice_series" ADD CONSTRAINT "tax_invoice_series_tenantId_fkey"
      FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;

INSERT INTO "tax_invoice_series" ("tenantId", "head", "lastValue", "updatedAt")
SELECT s."tenantId", s.head, MAX(s.seq), CURRENT_TIMESTAMP
  FROM (
    SELECT ti."tenantId",
           m[1] AS head,
           CAST(m[2] AS INTEGER) AS seq
      FROM "tax_invoices" ti,
           LATERAL COALESCE(
             regexp_match(ti."invoiceNumber", '^(.*-[0-9]{4}-CN-)([0-9]{1,9})$'),
             regexp_match(ti."invoiceNumber", '^(.*-[0-9]{4}-)([0-9]{1,9})$')
           ) AS m
     WHERE m IS NOT NULL
  ) s
 GROUP BY s."tenantId", s.head
ON CONFLICT ("tenantId", "head") DO UPDATE
   SET "lastValue" = GREATEST("tax_invoice_series"."lastValue", EXCLUDED."lastValue"),
       "updatedAt" = CURRENT_TIMESTAMP;
