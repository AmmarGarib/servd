-- Sales tax on the buyer's supplier invoice (owner, 2026-11-05: "Add the sales tax field on the buyer's invoice").
-- Entered at "Mark completed" (or the GRN's correction), carried onto the GRN and billed at the CEO's GRN approval.
ALTER TABLE "purchase_orders" ADD COLUMN "invoiceTaxCents" BIGINT, ADD COLUMN "invoiceTaxAuthority" TEXT;
ALTER TABLE "goods_receipts"  ADD COLUMN "invoiceTaxCents" BIGINT, ADD COLUMN "invoiceTaxAuthority" TEXT;
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_invoice_tax_chk"
  CHECK (("invoiceTaxCents" IS NULL OR "invoiceTaxCents" >= 0) AND ("invoiceTaxAuthority" IS NULL OR "invoiceTaxAuthority" IN ('fbr', 'srb')));
ALTER TABLE "goods_receipts" ADD CONSTRAINT "goods_receipts_invoice_tax_chk"
  CHECK (("invoiceTaxCents" IS NULL OR "invoiceTaxCents" >= 0) AND ("invoiceTaxAuthority" IS NULL OR "invoiceTaxAuthority" IN ('fbr', 'srb')));
