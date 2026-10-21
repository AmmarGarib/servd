-- 20261021160000_ic_asset_transfer — a fixed asset one servd company gives
-- another at book value (owner, 2026-10-21: "Book value, no gain or loss").
-- The due-from / due-to pair moves through the existing inter-company engine
-- as a system transfer of source 'asset_transfer' (fixedAssets/events.ts);
-- the CHECK on intercompany_transfers.source learns the new value.
--
-- No existing row can break it: the list only grows.
--
-- Runbook: if this migration fails on deploy, run
--   prisma migrate resolve --rolled-back 20261021160000_ic_asset_transfer
-- in the api image before redeploying any image (P3009 blocks every image).
-- Rollback: once an 'asset_transfer' row exists an older image still reads it
-- (source is TEXT); do not roll the database CHECK back while one exists.
SET lock_timeout = '10s';

ALTER TABLE "intercompany_transfers" DROP CONSTRAINT IF EXISTS "ic_source_chk";

-- ─── SQL-only objects (one statement per ';', no trailing comments)
ALTER TABLE "intercompany_transfers" ADD CONSTRAINT "ic_source_chk" CHECK ("source" IN ('manual', 'fleet', 'cod', 'ho_recharge', 'asset_transfer'));
