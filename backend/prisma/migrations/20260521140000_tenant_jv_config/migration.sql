-- Tenant JV metadata: lets a tenant flag itself as a joint venture and
-- carry the partner-split percentages. The UI uses this to render
-- "Viva 60% / GS 40%" chips next to every cost line in the tenant.

ALTER TABLE "tenants"
  ADD COLUMN IF NOT EXISTS "isJointVenture" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "jvPartners"     JSONB;
