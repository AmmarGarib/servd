-- Kitchen flow, part C (owner, 2026-10-26, K5): "Par = one count shown in PORTIONS." Daily par per outlet, per prep
-- (sub-recipe), per weekday. Company data (tenantId = the outlet's company), row-level security as the wave-A/B tables,
-- in the company-merge repoint list. Recipe portions per batch / label are added by 20261026120100.

CREATE TABLE "par_targets" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "recipeId" TEXT NOT NULL,
    "weekday" INTEGER NOT NULL,
    "portions" DOUBLE PRECISION NOT NULL,
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "par_targets_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "par_targets_tenantId_locationId_recipeId_weekday_key" ON "par_targets"("tenantId", "locationId", "recipeId", "weekday");
CREATE INDEX "par_targets_tenantId_idx" ON "par_targets"("tenantId");
CREATE INDEX "par_targets_locationId_idx" ON "par_targets"("locationId");
ALTER TABLE "par_targets" ADD CONSTRAINT "par_targets_recipeId_fkey" FOREIGN KEY ("recipeId") REFERENCES "recipes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ─── SQL-only objects (tests/setup.ts applies this section; no ';' inside a statement)
ALTER TABLE "par_targets" ADD CONSTRAINT "par_targets_chk" CHECK ("weekday" BETWEEN 0 AND 6 AND "portions" >= 0);
ALTER TABLE "recipes" ADD CONSTRAINT "recipes_portion_chk" CHECK ("portionsPerBatch" IS NULL OR "portionsPerBatch" >= 1);

-- ─── Row-level security (the guarded wave-A/B pattern)
DO $do$
DECLARE
  t text;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'app_is_service_mode')
     AND EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'app_tenant_ids') THEN
    FOREACH t IN ARRAY ARRAY['par_targets']
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
