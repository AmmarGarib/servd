-- Sub-categories and sales sessions (owner, 2026-10-22). Additive only.
ALTER TABLE "categories" ADD COLUMN "parentId" TEXT;
ALTER TABLE "categories" ADD CONSTRAINT "categories_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "categories"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "categories_parentId_idx" ON "categories"("parentId");
ALTER TABLE "categories" ADD CONSTRAINT "categories_parent_not_self_chk" CHECK ("parentId" IS NULL OR "parentId" <> "id");

CREATE TABLE "menu_sessions" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "conceptId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "startTime" TEXT NOT NULL,
    "endTime" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "menu_sessions_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "menu_sessions_time_chk" CHECK ("startTime" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' AND "endTime" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' AND "startTime" <> "endTime")
);
CREATE INDEX "menu_sessions_tenantId_idx" ON "menu_sessions"("tenantId");
CREATE INDEX "menu_sessions_conceptId_idx" ON "menu_sessions"("conceptId");
-- One live name per brand.
CREATE UNIQUE INDEX "menu_sessions_concept_name_active" ON "menu_sessions"("conceptId", lower("name")) WHERE "isActive";
ALTER TABLE "menu_sessions" ADD CONSTRAINT "menu_sessions_conceptId_fkey" FOREIGN KEY ("conceptId") REFERENCES "concepts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ─── Row-level security (the guarded wave-A/B pattern, as 20261021100000_shift_corrections)
DO $do$
DECLARE
  t text;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'app_is_service_mode')
     AND EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'app_tenant_ids') THEN
    FOREACH t IN ARRAY ARRAY['menu_sessions']
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
