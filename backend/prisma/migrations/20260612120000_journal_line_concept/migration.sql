-- Per-brand attribution on journal lines.
--
-- Lines posted from an order or POS shift (revenue, COGS, discounts, payments)
-- carry the order's conceptId so per-brand cost can be MEASURED rather than
-- estimated by revenue share. NULL = genuinely shared / overhead / manual
-- entries, which the per-brand P&L allocates across brands.
ALTER TABLE "journal_lines" ADD COLUMN "conceptId" TEXT;

CREATE INDEX "journal_lines_conceptId_idx" ON "journal_lines"("conceptId");
