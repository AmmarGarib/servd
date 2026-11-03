-- 20261103160000_marketing_intern_role — the "Marketing intern / designer" login and the two board card types
-- (owner, 2026-11-03). Enum values only, in their own migration: a value added by ALTER TYPE … ADD VALUE cannot be
-- used in the transaction that adds it, and 20261103160100_marketing_board follows.
--
-- Runbook: if this migration fails on deploy, run
--   prisma migrate resolve --rolled-back 20261103160000_marketing_intern_role
-- in the api image before redeploying any image (P3009 blocks every image).
-- Rollback: never roll the API image back below this release once a marketing_intern login or a campaign /
-- design_request card exists (an older Prisma client throws on the new enum values).
ALTER TYPE "UserRole" ADD VALUE IF NOT EXISTS 'marketing_intern';
ALTER TYPE "ContentEventType" ADD VALUE IF NOT EXISTS 'campaign';
ALTER TYPE "ContentEventType" ADD VALUE IF NOT EXISTS 'design_request';
