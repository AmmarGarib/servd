-- The PO → GRN workflow (owner, 2026-11-05) — REPLACES the PO approval chain of 2026-11-03
-- (draft → buyer_check → finance_check → pending_approval → approved). procurement/poWorkflow.ts is the contract.
--
--   draft → pending_approval (the CEO) → approved (the buyer: buyerUserId — named by the CEO, else the company's one
--   active 'procurement' login, else the PO's raiser) → completed (the buyer bought it, attached the supplier's
--   invoice) → received | partial (the requester confirmed what arrived: a GRN on goods_receipts, Dr 12x0 / Cr 2015)
--   → GRN: finance_review (finance) → ceo_review (the CEO) → approved (the supplier bill: Dr 2015 / Cr 2010).
--   A return at any GRN step → buyer_fix (the buyer corrects the invoice) → finance_review.
--
-- purchase_orders.grnWorkflow marks a PO approved under this flow: it is received ONLY through the requester's
-- confirmation and billed ONLY at the CEO's GRN approval. POs approved before keep the old receiving path.
-- The old chain's stamps (buyerCheckedById, financeCheckedById) stay as history.

ALTER TABLE "purchase_orders"
  ADD COLUMN "grnWorkflow" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "buyerUserId" TEXT,
  ADD COLUMN "buyerAssignedAt" TIMESTAMP(3),
  ADD COLUMN "invoiceNumber" TEXT,
  ADD COLUMN "invoiceDate" DATE,
  ADD COLUMN "completedById" TEXT,
  ADD COLUMN "completedAt" TIMESTAMP(3),
  ADD COLUMN "receiptReturnNote" TEXT,
  ADD COLUMN "receiptReturnedById" TEXT,
  ADD COLUMN "receiptReturnedAt" TIMESTAMP(3);

CREATE INDEX "purchase_orders_buyerUserId_status_idx" ON "purchase_orders"("buyerUserId", "status");

ALTER TABLE "goods_receipts"
  ADD COLUMN "grnNumber" TEXT,
  ADD COLUMN "grnStatus" TEXT,
  ADD COLUMN "invoiceNumber" TEXT,
  ADD COLUMN "invoiceDate" DATE,
  ADD COLUMN "financeCheckedById" TEXT,
  ADD COLUMN "financeCheckedAt" TIMESTAMP(3),
  ADD COLUMN "approvedById" TEXT,
  ADD COLUMN "approvedAt" TIMESTAMP(3),
  ADD COLUMN "returnNote" TEXT,
  ADD COLUMN "returnedById" TEXT,
  ADD COLUMN "returnedAt" TIMESTAMP(3),
  ADD COLUMN "returnCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "supplierBillId" TEXT;

CREATE UNIQUE INDEX "goods_receipts_tenantId_grnNumber_key" ON "goods_receipts"("tenantId", "grnNumber");
CREATE INDEX "goods_receipts_tenantId_grnStatus_idx" ON "goods_receipts"("tenantId", "grnStatus");

-- The retired buyer / finance steps: a PO waiting at either goes straight to the CEO (its stamps are kept).
INSERT INTO "po_activity_log" ("id", "purchaseOrderId", "userId", "action", "details", "createdAt")
SELECT gen_random_uuid()::text, po."id", NULL, 'moved_to_ceo',
       jsonb_build_object('from', po."status", 'reason', 'PO workflow of 2026-11-05: the buyer and finance checks are retired'),
       now()
FROM "purchase_orders" po WHERE po."status" IN ('buyer_check', 'finance_check');

UPDATE "purchase_orders" SET "status" = 'pending_approval', "updatedAt" = now()
WHERE "status" IN ('buyer_check', 'finance_check');
