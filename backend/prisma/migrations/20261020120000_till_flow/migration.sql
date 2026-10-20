-- Till flow (owner, 2026-10-20; backend/src/modules/pos/TILL_FLOW.md).
--
-- 1. Order.settlementChannel — how a till bill was closed: 'keenu' (pushed to the
--    Keenu fiscal POS, which settles it and files it; revenue → the brand's main
--    sales account) or 'servd' (closed in servd; revenue → the brand's servd
--    sub-account; its fiscal document waits for a manual SRB / FBR portal filing).
--    NULL for every existing order (legacy / non-till) — they keep today's rules.
--    settlementMeta holds a Keenu push's state.
-- 2. Order.waiterEmployeeId (an HR employee of the order's company), partySize
--    (pax) and guestRegistrationNo (as typed at the till).
-- 3. Concept.servdRevenueAccountCode — the brand's second sales account
--    "Sales — <brand> (servd)", assigned per company by the boot step
--    accounting/brandRevenueAccount.ts (accounts are created through the chart
--    helpers, never in SQL). NULL until then (servd-channel sales fall back to
--    the main account).
-- 4. MenuItem.itemCode — the code / SKU the till searches by, unique per brand.
-- 5. Customer.altPhone — a second (landline) number from the till's guest form.
--
-- Rollback: an older image ignores every column. Servd-channel sales posted to a
-- brand's servd sub-account stay there (still 40xx brand sales); their refunds on
-- an older image would debit the main account — do not roll back below this
-- release once servd-channel sales exist without reclassing by hand. Servd-channel
-- fiscal documents ('manual_required' / 'servd_channel') are never auto-sent by an
-- older image either (it never promotes manual_required).

CREATE TYPE "SettlementChannel" AS ENUM ('keenu', 'servd');

ALTER TABLE "orders" ADD COLUMN "settlementChannel" "SettlementChannel";
ALTER TABLE "orders" ADD COLUMN "settlementMeta" JSONB;
ALTER TABLE "orders" ADD COLUMN "waiterEmployeeId" TEXT;
ALTER TABLE "orders" ADD COLUMN "partySize" INTEGER;
ALTER TABLE "orders" ADD COLUMN "guestRegistrationNo" TEXT;
ALTER TABLE "orders" ADD CONSTRAINT "orders_waiterEmployeeId_fkey"
  FOREIGN KEY ("waiterEmployeeId") REFERENCES "hr_employees"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "orders_waiterEmployeeId_idx" ON "orders"("waiterEmployeeId");
CREATE INDEX "orders_settlementChannel_idx" ON "orders"("settlementChannel");
ALTER TABLE "orders" ADD CONSTRAINT "orders_party_size_chk" CHECK ("partySize" IS NULL OR "partySize" BETWEEN 1 AND 500);

ALTER TABLE "concepts" ADD COLUMN "servdRevenueAccountCode" TEXT;

ALTER TABLE "menu_items" ADD COLUMN "itemCode" TEXT;
CREATE UNIQUE INDEX "menu_items_conceptId_itemCode_key" ON "menu_items"("conceptId", "itemCode");

ALTER TABLE "customers" ADD COLUMN "altPhone" TEXT;
