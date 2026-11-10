-- The buyers list per company (owner, 2026-11-10: "Give option to add buyers and then select buyer when PO is being
-- raised"). procurement/buyers.ts.
SET lock_timeout = '10s';

CREATE TABLE "po_buyers" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "addedById" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "po_buyers_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "po_buyers_tenantId_userId_key" ON "po_buyers"("tenantId", "userId");
CREATE INDEX "po_buyers_tenantId_active_idx" ON "po_buyers"("tenantId", "active");
ALTER TABLE "po_buyers" ADD CONSTRAINT "po_buyers_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

DO $do$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'app_is_service_mode')
     AND EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'app_tenant_ids')
     AND NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = current_schema() AND tablename = 'po_buyers') THEN
    ALTER TABLE "po_buyers" ENABLE ROW LEVEL SECURITY;
    CREATE POLICY "po_buyers_rls" ON "po_buyers" FOR ALL
      USING (app_is_service_mode() OR "po_buyers"."tenantId" = ANY(app_tenant_ids()))
      WITH CHECK (app_is_service_mode() OR "po_buyers"."tenantId" = ANY(app_tenant_ids()));
  END IF;
END
$do$;
