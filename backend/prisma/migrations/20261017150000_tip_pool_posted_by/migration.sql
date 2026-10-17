-- Tip pools record who posted (approved) them (owner, 2026-10-17: "finance can
-- pay tip pools with CEO's approval"). Finance may pay only a pool the CEO
-- posted. Nullable, no backfill: pools posted before this migration stay NULL,
-- so finance is refused on them and the approvers pay as before. No foreign
-- key, like "createdById".
ALTER TABLE "tip_pools" ADD COLUMN "postedById" TEXT;
