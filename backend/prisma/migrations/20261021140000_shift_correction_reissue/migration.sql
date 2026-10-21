-- 20261021140000_shift_correction_reissue — Void & re-issue (owner,
-- 2026-10-21: "make re-issue land on the original day"). A shift correction
-- item of kind 'void_reissue' carries the reference of the right tender
-- (card slip / approval reference, or the Raast bank reference); "food made"
-- and "money returned" never apply to it (modules/shiftCorrections).
--
-- No existing row can break the CHECKs: before this release every
-- 'void_reissue' item was refused (422) and none was stored.
--
-- Runbook: if this migration fails on deploy, run
--   prisma migrate resolve --rolled-back 20261021140000_shift_correction_reissue
-- in the api image before redeploying any image (P3009 blocks every image).
-- Rollback: an older image ignores the column; it refuses new re-issues (422).
SET lock_timeout = '10s';

ALTER TABLE "shift_correction_items" ADD COLUMN "tenderRef" TEXT;

-- ─── SQL-only objects (one statement per ';', no trailing comments)
ALTER TABLE "shift_correction_items" ADD CONSTRAINT "shift_correction_items_tender_ref_chk" CHECK ("kind" <> 'void_reissue' OR "newTender" = 'cash' OR char_length(btrim(COALESCE("tenderRef", ''))) > 0);
ALTER TABLE "shift_correction_items" ADD CONSTRAINT "shift_correction_items_reissue_food_chk" CHECK ("kind" <> 'void_reissue' OR ("foodMade" = false AND "moneyReturned" = false));
