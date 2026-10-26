-- B8 (owner, 2026-10-26): a per-company catalogue of guest tags (VIP, allergy, birthday …) with a screen to
-- create / rename / switch off, and a typed tag on the guest card. Company data (tenantId, RLS, merge repoint).

CREATE TABLE "guest_tag_types" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "nameKey" TEXT NOT NULL,
    "color" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "guest_tag_types_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "guest_tag_types_tenantId_nameKey_key" ON "guest_tag_types"("tenantId", "nameKey");
CREATE INDEX "guest_tag_types_tenantId_idx" ON "guest_tag_types"("tenantId");

ALTER TABLE "guest_tags" ADD COLUMN "tenantId" TEXT;
ALTER TABLE "guest_tags" ADD COLUMN "tagTypeId" TEXT;
CREATE INDEX "guest_tags_tenantId_idx" ON "guest_tags"("tenantId");
CREATE INDEX "guest_tags_tagTypeId_idx" ON "guest_tags"("tagTypeId");
ALTER TABLE "guest_tags" ADD CONSTRAINT "guest_tags_tagTypeId_fkey" FOREIGN KEY ("tagTypeId") REFERENCES "guest_tag_types"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ─── Row-level security (the guarded wave-A/B pattern)
DO $do$
DECLARE
  t text;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'app_is_service_mode')
     AND EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'app_tenant_ids') THEN
    FOREACH t IN ARRAY ARRAY['guest_tag_types']
    LOOP
      IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = current_schema() AND tablename = t) THEN
        EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
        EXECUTE format(
          'CREATE POLICY %I ON %I FOR ALL '
          'USING (app_is_service_mode() OR %I."tenantId" = ANY(app_tenant_ids())) '
          'WITH CHECK (app_is_service_mode() OR %I."tenantId" = ANY(app_tenant_ids()))',
          t || '_rls', t, t, t);
      END IF;
    END LOOP;
  END IF;
END
$do$;
