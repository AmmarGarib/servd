-- The servd supplier list (owner, 2026-11-14: "we need to make suppliers belong to servd. just like the ingredient
-- master list"). supplier_masters = WHO the supplier is (platform data, no tenantId); each company's suppliers row is
-- that company's ACCOUNT with them (bills, payments, opening balance stay where they are — nothing in the books moves).
CREATE TABLE "supplier_masters" (
  "id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "normalizedName" TEXT NOT NULL,
  "category" TEXT,
  "phone" TEXT,
  "email" TEXT,
  "whatsappPhone" TEXT,
  "address" TEXT,
  "taxId" TEXT,
  "filerStatus" TEXT NOT NULL DEFAULT 'unknown',
  "whtExemptCertNo" TEXT,
  "whtExemptUntil" TIMESTAMP(3),
  "defaultTaxAuthority" TEXT,
  "defaultWhtSection" TEXT,
  "mergedIntoId" TEXT,
  "createdByUserId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "supplier_masters_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "supplier_masters_normalizedName_idx" ON "supplier_masters"("normalizedName");

ALTER TABLE "suppliers" ADD COLUMN "masterSupplierId" TEXT;
ALTER TABLE "suppliers" ADD CONSTRAINT "suppliers_masterSupplierId_fkey" FOREIGN KEY ("masterSupplierId") REFERENCES "supplier_masters"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "suppliers_masterSupplierId_idx" ON "suppliers"("masterSupplierId");

-- Backfill. Every ordinary supplier with a company (system suppliers and company-less rows stay unlinked), grouped by
-- its name as servd compares it (trimmed, inner spaces collapsed, lower case). Within a group each company's FIRST
-- account (live before deleted, then oldest) joins the shared master; a second account of the same name in the same
-- company gets its own master "<name> (duplicate n)" so one company never has two accounts on one master.
CREATE TABLE "_supplier_master_backfill" AS
SELECT s.id AS supplier_id,
       lower(btrim(regexp_replace(s.name, '\s+', ' ', 'g'))) AS norm,
       row_number() OVER (PARTITION BY s."tenantId", lower(btrim(regexp_replace(s.name, '\s+', ' ', 'g')))
                          ORDER BY (s."deletedAt" IS NOT NULL), s."createdAt", s.id) AS dup,
       gen_random_uuid()::text AS own_master
  FROM suppliers s
 WHERE s."tenantId" IS NOT NULL AND s."systemKind" IS NULL AND btrim(regexp_replace(s.name, '\s+', ' ', 'g')) <> '';

-- One master per name (dup = 1 rows): details from the group's first live, oldest account.
INSERT INTO supplier_masters (id, name, "normalizedName", category, phone, email, "whatsappPhone", address, "taxId",
                              "filerStatus", "whtExemptCertNo", "whtExemptUntil", "defaultTaxAuthority", "defaultWhtSection", "updatedAt")
SELECT DISTINCT ON (b.norm) b.own_master, btrim(regexp_replace(s.name, '\s+', ' ', 'g')), b.norm, s.category, s.phone, s.email,
       s."whatsappPhone", s.address, s."taxId", s."filerStatus", s."whtExemptCertNo", s."whtExemptUntil", s."defaultTaxAuthority", s."defaultWhtSection", CURRENT_TIMESTAMP
  FROM "_supplier_master_backfill" b JOIN suppliers s ON s.id = b.supplier_id
 WHERE b.dup = 1
 ORDER BY b.norm, (s."deletedAt" IS NOT NULL), s."createdAt", s.id;

UPDATE suppliers s SET "masterSupplierId" = m.id
  FROM "_supplier_master_backfill" b JOIN supplier_masters m ON m."normalizedName" = b.norm
 WHERE b.supplier_id = s.id AND b.dup = 1;

-- Same-name second accounts inside one company: their own master.
INSERT INTO supplier_masters (id, name, "normalizedName", category, phone, email, "whatsappPhone", address, "taxId",
                              "filerStatus", "whtExemptCertNo", "whtExemptUntil", "defaultTaxAuthority", "defaultWhtSection", "updatedAt")
SELECT b.own_master, btrim(regexp_replace(s.name, '\s+', ' ', 'g')) || ' (duplicate ' || (b.dup - 1) || ')',
       b.norm || ' (duplicate ' || (b.dup - 1) || ')', s.category, s.phone, s.email, s."whatsappPhone", s.address, s."taxId",
       s."filerStatus", s."whtExemptCertNo", s."whtExemptUntil", s."defaultTaxAuthority", s."defaultWhtSection", CURRENT_TIMESTAMP
  FROM "_supplier_master_backfill" b JOIN suppliers s ON s.id = b.supplier_id
 WHERE b.dup > 1 AND s."deletedAt" IS NULL;
UPDATE suppliers s SET "masterSupplierId" = b.own_master
  FROM "_supplier_master_backfill" b WHERE b.supplier_id = s.id AND b.dup > 1 AND s."deletedAt" IS NULL;

DROP TABLE "_supplier_master_backfill";

-- ─── SQL-only objects
-- One LIVE account per servd supplier per company.
CREATE UNIQUE INDEX "suppliers_tenant_master_live_key" ON "suppliers"("tenantId", "masterSupplierId")
  WHERE "deletedAt" IS NULL AND "masterSupplierId" IS NOT NULL AND "tenantId" IS NOT NULL;
