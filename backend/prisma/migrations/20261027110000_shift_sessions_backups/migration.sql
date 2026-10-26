-- Owner B1 (2026-10-26): a staff sign-in lasts one shift; two-step sign-in is retired.
--   users.sessionsEndedAt — set when the login's till drawer closes; sessions issued before it end.
--   Existing two-step enrolments are cleared (owner: "remove two-step sign-in; nobody has it on today").
--   The columns stay (no column drop).
ALTER TABLE "users" ADD COLUMN "sessionsEndedAt" TIMESTAMP(3);
UPDATE "users" SET "twoFactorPhone" = NULL, "twoFactorEnabledAt" = NULL
  WHERE "twoFactorPhone" IS NOT NULL OR "twoFactorEnabledAt" IS NOT NULL;

-- Owner S13 (2026-10-26): the weekly encrypted database backup file, CEO only.
-- Platform table, deliberately no tenantId (a backup is the whole database) and so no RLS.
CREATE TABLE "database_backups" (
    "id" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'running',
    "trigger" TEXT NOT NULL,
    "fileName" TEXT,
    "sizeBytes" DOUBLE PRECISION,
    "keyId" TEXT,
    "error" TEXT,
    "createdById" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    CONSTRAINT "database_backups_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "database_backups_startedAt_idx" ON "database_backups"("startedAt");
