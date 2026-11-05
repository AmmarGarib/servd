-- Bank reconciliation: clear an outstanding cheque / deposit by a manual entry (owner, 2026-11-05: "Make it settle by
-- manual entry instead of matching with bank statement"). A mark, never a posting: the date the bank cleared it, the
-- bank's reference and a note.
ALTER TABLE "bank_recon_book_marks" ADD COLUMN "clearedOn" DATE;
ALTER TABLE "bank_recon_book_marks" DROP CONSTRAINT "bank_recon_book_marks_status_chk";

-- ─── SQL-only objects
ALTER TABLE "bank_recon_book_marks" ADD CONSTRAINT "bank_recon_book_marks_status_chk"
  CHECK ("status" IN ('under_review', 'cleared_prior', 'cleared_manual') AND (("status" = 'cleared_manual') = ("clearedOn" IS NOT NULL)));
