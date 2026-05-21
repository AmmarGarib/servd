-- Workforce: budgeted positions, departments, shift bands.
-- See Position model docstring in schema.prisma for design notes.
-- Idempotent (DO $ … EXCEPTION) so partially-applied runs can re-run.

DO $$ BEGIN
  CREATE TYPE "PositionStatus" AS ENUM ('open', 'filled', 'frozen', 'archived');
EXCEPTION WHEN duplicate_object THEN null; END $$;

CREATE TABLE IF NOT EXISTS "departments" (
  "id"           TEXT NOT NULL,
  "tenantId"     TEXT,
  "name"         TEXT NOT NULL,
  "emoji"        TEXT,
  "isHeadOffice" BOOLEAN NOT NULL DEFAULT false,
  "order"        INTEGER NOT NULL DEFAULT 0,
  "archivedAt"   TIMESTAMP(3),
  "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "departments_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "departments_tenantId_name_key" ON "departments"("tenantId", "name");
CREATE INDEX IF NOT EXISTS "departments_tenantId_archivedAt_idx" ON "departments"("tenantId", "archivedAt");

DO $$ BEGIN
  ALTER TABLE "departments"
    ADD CONSTRAINT "departments_tenantId_fkey"
      FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;

CREATE TABLE IF NOT EXISTS "shift_bands" (
  "id"         TEXT NOT NULL,
  "tenantId"   TEXT,
  "name"       TEXT NOT NULL,
  "startTime"  TEXT NOT NULL,
  "endTime"    TEXT NOT NULL,
  "order"      INTEGER NOT NULL DEFAULT 0,
  "archivedAt" TIMESTAMP(3),
  "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "shift_bands_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "shift_bands_tenantId_name_key" ON "shift_bands"("tenantId", "name");

DO $$ BEGIN
  ALTER TABLE "shift_bands"
    ADD CONSTRAINT "shift_bands_tenantId_fkey"
      FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;

CREATE TABLE IF NOT EXISTS "positions" (
  "id"                   TEXT NOT NULL,
  "tenantId"             TEXT NOT NULL,
  "conceptId"            TEXT,
  "departmentId"         TEXT,
  "shiftBandId"          TEXT,
  "title"                TEXT NOT NULL,
  "monthlySalaryCents"   INTEGER NOT NULL,
  "tenantCostShareCents" INTEGER NOT NULL,
  "costShareNote"        TEXT,
  "headcount"            INTEGER NOT NULL DEFAULT 1,
  "filledByUserId"       TEXT,
  "status"               "PositionStatus" NOT NULL DEFAULT 'open',
  "notes"                TEXT,
  "createdAt"            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"            TIMESTAMP(3) NOT NULL,
  CONSTRAINT "positions_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "positions_tenantId_status_idx" ON "positions"("tenantId", "status");
CREATE INDEX IF NOT EXISTS "positions_conceptId_idx"       ON "positions"("conceptId");
CREATE INDEX IF NOT EXISTS "positions_departmentId_idx"    ON "positions"("departmentId");

DO $$ BEGIN
  ALTER TABLE "positions"
    ADD CONSTRAINT "positions_tenantId_fkey"
      FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  ALTER TABLE "positions"
    ADD CONSTRAINT "positions_conceptId_fkey"
      FOREIGN KEY ("conceptId") REFERENCES "concepts"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  ALTER TABLE "positions"
    ADD CONSTRAINT "positions_departmentId_fkey"
      FOREIGN KEY ("departmentId") REFERENCES "departments"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  ALTER TABLE "positions"
    ADD CONSTRAINT "positions_shiftBandId_fkey"
      FOREIGN KEY ("shiftBandId") REFERENCES "shift_bands"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  ALTER TABLE "positions"
    ADD CONSTRAINT "positions_filledByUserId_fkey"
      FOREIGN KEY ("filledByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;
