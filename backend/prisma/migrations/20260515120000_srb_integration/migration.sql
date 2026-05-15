-- SRB (Sindh Revenue Board) electronic sales invoicing. Mirrors the FBR
-- PRAL columns: a POSID per Concept (assigned by SRB at registration),
-- and the SRB-issued invoice number on each Order after successful
-- submission. Nullable everywhere — concepts outside Sindh or not yet
-- registered just leave both null.

ALTER TABLE "concepts" ADD COLUMN "srbPosId" INTEGER;
ALTER TABLE "orders"   ADD COLUMN "srbInvoiceNumber" TEXT;
