-- Procurement was leaking across tenants — every operator saw every other
-- operator's suppliers and POs. Anchor the Supplier table to a tenant; every
-- downstream entity (PurchaseOrder, SupplierBill, SupplierPayment,
-- ItemPriceHistory, SupplierConversation) scopes via the supplier relation,
-- so we only need the column on the root.
--
-- Nullable on purpose — legacy rows show up as "⚠ No company" in the Monitor
-- UI so the CEO can transfer them via the supplier edit drawer.

ALTER TABLE "suppliers" ADD COLUMN IF NOT EXISTS "tenantId" TEXT;

CREATE INDEX IF NOT EXISTS "suppliers_tenantId_idx" ON "suppliers"("tenantId");

ALTER TABLE "suppliers"
  ADD CONSTRAINT "suppliers_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "tenants"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
