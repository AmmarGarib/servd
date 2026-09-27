-- A receipt line remembers the PO line it was matched to.
ALTER TABLE "goods_receipt_lines" ADD COLUMN     "poLineId" TEXT;
CREATE INDEX "goods_receipt_lines_poLineId_idx" ON "goods_receipt_lines"("poLineId");
ALTER TABLE "goods_receipt_lines" ADD CONSTRAINT "goods_receipt_lines_poLineId_fkey" FOREIGN KEY ("poLineId") REFERENCES "purchase_order_lines"("id") ON DELETE SET NULL ON UPDATE CASCADE;
