-- Expand UserRole to mirror the 13-role AppRole list in
-- frontend/admin/src/lib/appRoles.ts. Sidebar "Workforce" hub needs distinct
-- buckets for FOH / BOH / procurement / finance / HR / etc — the old 6-value
-- enum collapsed too many real-world roles together.
--
-- ALTER TYPE ADD VALUE in Postgres ≥12 may run inside a transaction as long
-- as the new value isn't *used* in the same transaction. Prisma's wrapper
-- satisfies that. Each statement is independent — IF NOT EXISTS makes the
-- migration idempotent if a partial run ever needs to be re-applied.

ALTER TYPE "UserRole" ADD VALUE IF NOT EXISTS 'management';
ALTER TYPE "UserRole" ADD VALUE IF NOT EXISTS 'foh_management';
ALTER TYPE "UserRole" ADD VALUE IF NOT EXISTS 'boh_management';
ALTER TYPE "UserRole" ADD VALUE IF NOT EXISTS 'foh';
ALTER TYPE "UserRole" ADD VALUE IF NOT EXISTS 'boh';
ALTER TYPE "UserRole" ADD VALUE IF NOT EXISTS 'procurement';
ALTER TYPE "UserRole" ADD VALUE IF NOT EXISTS 'finance';
ALTER TYPE "UserRole" ADD VALUE IF NOT EXISTS 'hr';
