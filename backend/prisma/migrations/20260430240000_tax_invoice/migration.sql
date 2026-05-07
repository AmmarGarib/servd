-- FBR-compliant tax invoice fields on Concept
ALTER TABLE "concepts" ADD COLUMN "strn"             TEXT;
ALTER TABLE "concepts" ADD COLUMN "ntn"              TEXT;
ALTER TABLE "concepts" ADD COLUMN "province"         TEXT;
ALTER TABLE "concepts" ADD COLUMN "invoiceLegalName" TEXT;
ALTER TABLE "concepts" ADD COLUMN "invoiceAddress"   TEXT;
ALTER TABLE "concepts" ADD COLUMN "invoicePrefix"    TEXT;

CREATE TYPE "InvoiceType" AS ENUM ('invoice', 'credit_note');

CREATE TABLE "tax_invoices" (
  "id"                 TEXT          NOT NULL,
  "invoiceNumber"      TEXT          NOT NULL,
  "type"               "InvoiceType" NOT NULL DEFAULT 'invoice',
  "orderId"            TEXT          NOT NULL,
  "conceptId"          TEXT          NOT NULL,
  "issuedAt"           TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "sellerLegalName"    TEXT          NOT NULL,
  "sellerStrn"         TEXT,
  "sellerNtn"          TEXT,
  "sellerAddress"      TEXT,
  "buyerName"          TEXT,
  "buyerStrn"          TEXT,
  "buyerNtn"           TEXT,
  "buyerAddress"       TEXT,
  "subtotalCents"      INTEGER       NOT NULL,
  "discountCents"      INTEGER       NOT NULL DEFAULT 0,
  "taxableValueCents"  INTEGER       NOT NULL,
  "fbrTaxCents"        INTEGER       NOT NULL DEFAULT 0,
  "provincialTaxCents" INTEGER       NOT NULL DEFAULT 0,
  "serviceChargeCents" INTEGER       NOT NULL DEFAULT 0,
  "tipCents"           INTEGER       NOT NULL DEFAULT 0,
  "totalCents"         INTEGER       NOT NULL,
  "originalInvoiceId"  TEXT,
  "pdfUrl"             TEXT,
  CONSTRAINT "tax_invoices_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "tax_invoices_orderFk"          FOREIGN KEY ("orderId")           REFERENCES "orders"("id")        ON DELETE NO ACTION,
  CONSTRAINT "tax_invoices_originalFk"       FOREIGN KEY ("originalInvoiceId") REFERENCES "tax_invoices"("id")  ON DELETE NO ACTION
);
CREATE UNIQUE INDEX "tax_invoices_invoiceNumber_key" ON "tax_invoices" ("invoiceNumber");
CREATE INDEX "tax_invoices_concept_issuedAt_idx"      ON "tax_invoices" ("conceptId", "issuedAt" DESC);
CREATE INDEX "tax_invoices_orderId_idx"               ON "tax_invoices" ("orderId");

CREATE TABLE "tax_invoice_lines" (
  "id"             TEXT             NOT NULL,
  "invoiceId"      TEXT             NOT NULL,
  "description"    TEXT             NOT NULL,
  "quantity"       DOUBLE PRECISION NOT NULL,
  "unitPriceCents" INTEGER          NOT NULL,
  "lineTotalCents" INTEGER          NOT NULL,
  CONSTRAINT "tax_invoice_lines_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "tax_invoice_lines_invoiceFk"
    FOREIGN KEY ("invoiceId") REFERENCES "tax_invoices"("id") ON DELETE CASCADE
);
CREATE INDEX "tax_invoice_lines_invoiceId_idx" ON "tax_invoice_lines" ("invoiceId");

CREATE TABLE "invoice_counters" (
  "conceptId" TEXT    NOT NULL,
  "year"      INTEGER NOT NULL,
  "nextValue" INTEGER NOT NULL,
  CONSTRAINT "invoice_counters_pkey" PRIMARY KEY ("conceptId")
);
