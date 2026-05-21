-- Per-project JV metadata. Mirrors Tenant.isJointVenture + jvPartners so a
-- single CapEx project can be flagged as a partner-funded build even when
-- its tenant isn't a JV overall.

ALTER TABLE "capex_projects"
  ADD COLUMN IF NOT EXISTS "isJointVenture" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "jvPartners"     JSONB;
