-- HR-R7: tip pools belong to a company, and staff without a login can be
-- pool members.
--
-- 1. tip_pools."tenantId" (NOT NULL). A pool's company used to be derived
--    from its brand, with fallbacks to the OPERATOR's active company when the
--    brand was missing — so a pool's payout could post to, and its flags
--    reach, whichever company the approver happened to be in. The pool now
--    carries its own company, and that alone decides its ledger postings,
--    exception flags and who may see or edit it.
--
--    Backfill, in this order, for each pool still without one:
--      a. its brand's company (concepts."tenantId");
--      b. else its creator's company (users."tenantId" of "createdById");
--      c. else the ONE company every member's login belongs to (only when all
--         members have a company and they all agree);
--      d. else the oldest active company — with a NOTICE per pool, so the
--         deploy log names every pool that was placed by this last resort.
--
-- 2. tip_pool_members: a member is a login (userId) OR an HR employee with no
--    login — kiosk / time-clock staff (employeeId, FK hr_employees). Exactly
--    one is set (CHECK). Uniqueness per pool is two partial unique indexes
--    (Prisma cannot express a partial unique; schema.prisma declares the same
--    column pairs under the same names — see the comment on TipPoolMember).
--
-- 3. Exception flags filed under a stand-in kind: the tip-pool outlier flag
--    and the CapEx over-budget flag were written as 'high_value_void'. They
--    get their own kinds ('tip_pool_outlier', 'capex_over_budget'); old rows
--    are re-kinded by their exact titles and entity types.
--
-- Safe to re-run: DDL is IF [NOT] EXISTS / guarded, and the backfill only
-- touches rows whose tenantId is still NULL.

-- ─── 1. tip_pools.tenantId ──────────────────────────────────────────────────

ALTER TABLE "tip_pools" ADD COLUMN IF NOT EXISTS "tenantId" TEXT;

-- a. the brand's company
UPDATE "tip_pools" p
   SET "tenantId" = c."tenantId"
  FROM "concepts" c
 WHERE p."tenantId" IS NULL
   AND c.id = p."conceptId"
   AND c."tenantId" IS NOT NULL;

-- b. the creator's company
UPDATE "tip_pools" p
   SET "tenantId" = u."tenantId"
  FROM "users" u
 WHERE p."tenantId" IS NULL
   AND u.id = p."createdById"
   AND u."tenantId" IS NOT NULL;

-- c. the single company all members' logins belong to
UPDATE "tip_pools" p
   SET "tenantId" = x.tenant_id
  FROM (
    SELECT m."poolId" AS pool_id, MIN(u."tenantId") AS tenant_id
      FROM "tip_pool_members" m
      JOIN "users" u ON u.id = m."userId"
     GROUP BY m."poolId"
    HAVING COUNT(*) = COUNT(u."tenantId")          -- every member has a company
       AND COUNT(DISTINCT u."tenantId") = 1          -- and it is the same one
  ) x
 WHERE p."tenantId" IS NULL
   AND p.id = x.pool_id;

-- d. the oldest active company, named per pool in the deploy log
DO $$
DECLARE
  fallback TEXT;
  r RECORD;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "tip_pools" WHERE "tenantId" IS NULL) THEN
    RETURN;
  END IF;
  SELECT t.id INTO fallback
    FROM "tenants" t
   WHERE t."deletedAt" IS NULL
   ORDER BY t."isActive" DESC, t."createdAt" ASC, t.id
   LIMIT 1;
  IF fallback IS NULL THEN
    RAISE EXCEPTION 'tip_pool_company: tip pools exist but there is no company to assign them to';
  END IF;
  FOR r IN SELECT id, name, status, "periodStart", "periodEnd", "totalTipsCents" FROM "tip_pools" WHERE "tenantId" IS NULL ORDER BY "createdAt" LOOP
    RAISE NOTICE 'tip_pool_company: pool % ("%", %, % to %, % paisa) has no brand, creator or member company - assigned to the oldest active company %',
      r.id, r.name, r.status, r."periodStart", r."periodEnd", r."totalTipsCents", fallback;
    UPDATE "tip_pools" SET "tenantId" = fallback WHERE id = r.id;
  END LOOP;
END $$;

ALTER TABLE "tip_pools" ALTER COLUMN "tenantId" SET NOT NULL;

CREATE INDEX IF NOT EXISTS "tip_pools_tenantId_periodStart_idx" ON "tip_pools"("tenantId", "periodStart");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tip_pools_tenantId_fkey') THEN
    ALTER TABLE "tip_pools" ADD CONSTRAINT "tip_pools_tenantId_fkey"
      FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;

-- Row-level security: the pool's own company, not its brand's (and no more
-- "conceptId IS NULL = visible to everyone").
DROP POLICY IF EXISTS "tip_pools_rls" ON "tip_pools";
CREATE POLICY "tip_pools_rls" ON "tip_pools"
  FOR ALL
  USING (
    app_is_service_mode()
    OR "tip_pools"."tenantId" = ANY(app_tenant_ids())
  )
  WITH CHECK (
    app_is_service_mode()
    OR "tip_pools"."tenantId" = ANY(app_tenant_ids())
  );

-- ─── 2. tip_pool_members: login OR employee ─────────────────────────────────

ALTER TABLE "tip_pool_members" ALTER COLUMN "userId" DROP NOT NULL;
ALTER TABLE "tip_pool_members" ADD COLUMN IF NOT EXISTS "employeeId" TEXT;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tip_pool_members_employeeId_fkey') THEN
    ALTER TABLE "tip_pool_members" ADD CONSTRAINT "tip_pool_members_employeeId_fkey"
      FOREIGN KEY ("employeeId") REFERENCES "hr_employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tip_pool_members_one_person') THEN
    ALTER TABLE "tip_pool_members" ADD CONSTRAINT "tip_pool_members_one_person"
      CHECK (("userId" IS NULL) <> ("employeeId" IS NULL));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "tip_pool_members_employeeId_idx" ON "tip_pool_members"("employeeId");
-- The plain pool index Prisma knows about (it does not see partial indexes).
CREATE INDEX IF NOT EXISTS "tip_pool_members_poolId_idx" ON "tip_pool_members"("poolId");

-- One row per person per pool, whichever way the person is identified.
DROP INDEX IF EXISTS "tip_pool_members_poolId_userId_key";
CREATE UNIQUE INDEX "tip_pool_members_poolId_userId_key"
  ON "tip_pool_members"("poolId", "userId") WHERE "userId" IS NOT NULL;
DROP INDEX IF EXISTS "tip_pool_members_poolId_employeeId_key";
CREATE UNIQUE INDEX "tip_pool_members_poolId_employeeId_key"
  ON "tip_pool_members"("poolId", "employeeId") WHERE "employeeId" IS NOT NULL;

-- ─── 3. Re-kind the stand-in exception flags ────────────────────────────────
-- Titles as written by tipPools/routes.ts ("Tip pool: <name> taking <n>%")
-- and financePlanning/routes.ts ("CapEx project over budget: <project>").

UPDATE "exception_flags"
   SET "kind" = 'tip_pool_outlier'
 WHERE "kind" = 'high_value_void'
   AND "entityType" = 'TipPool'
   AND "title" LIKE 'Tip pool: % taking %';

UPDATE "exception_flags"
   SET "kind" = 'capex_over_budget'
 WHERE "kind" = 'high_value_void'
   AND "entityType" = 'CapexProject'
   AND "title" LIKE 'CapEx project over budget: %';
