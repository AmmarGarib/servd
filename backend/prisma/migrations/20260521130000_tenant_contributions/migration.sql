-- TenantContribution: inter-tenant monthly transfers for JV / shared-service
-- arrangements. See model docstring in schema.prisma.
-- Idempotent so partial runs can re-execute.

DO $$ BEGIN
  CREATE TYPE "ContributionCategory" AS ENUM ('head_office', 'commissary', 'shared_services', 'other');
EXCEPTION WHEN duplicate_object THEN null; END $$;

CREATE TABLE IF NOT EXISTS "tenant_contributions" (
  "id"                  TEXT NOT NULL,
  "sourceTenantId"      TEXT NOT NULL,
  "destinationTenantId" TEXT NOT NULL,
  "category"            "ContributionCategory" NOT NULL DEFAULT 'head_office',
  "monthlyCents"        INTEGER NOT NULL,
  "label"               TEXT NOT NULL,
  "description"         TEXT,
  "internalSplit"       JSONB,
  "isActive"            BOOLEAN NOT NULL DEFAULT true,
  "startedAt"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "endedAt"             TIMESTAMP(3),
  "createdAt"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"           TIMESTAMP(3) NOT NULL,
  CONSTRAINT "tenant_contributions_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "tenant_contributions_destinationTenantId_isActive_idx"
  ON "tenant_contributions"("destinationTenantId", "isActive");
CREATE INDEX IF NOT EXISTS "tenant_contributions_sourceTenantId_isActive_idx"
  ON "tenant_contributions"("sourceTenantId", "isActive");

DO $$ BEGIN
  ALTER TABLE "tenant_contributions"
    ADD CONSTRAINT "tenant_contributions_sourceTenantId_fkey"
      FOREIGN KEY ("sourceTenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  ALTER TABLE "tenant_contributions"
    ADD CONSTRAINT "tenant_contributions_destinationTenantId_fkey"
      FOREIGN KEY ("destinationTenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;
