-- Co-owner role + PIN self-service.
--
-- `owner` sees everything the CEO sees and can approve STAFF submissions, but
-- escalates its own submissions to `admin` and cannot edit roles/permissions.
--
-- ALTER TYPE ... ADD VALUE cannot be used in the same transaction that then
-- references the new value; it is safe on its own here (Postgres 12+).
ALTER TYPE "UserRole" ADD VALUE IF NOT EXISTS 'owner';

-- "Forgot PIN" escalation marker. Null = no outstanding request.
ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "pinResetRequestedAt" TIMESTAMP(3);
