-- Adds Rider.tenantId so dispatch queries can scope by tenant. Backfills from
-- each rider's first delivery's concept.tenantId; riders with no orders stay
-- NULL and must be assigned manually (the dispatch routes treat NULL as "no
-- tenant scope" and exclude them from any /board response).

ALTER TABLE "riders" ADD COLUMN IF NOT EXISTS "tenantId" TEXT;

-- Backfill: for each rider, pull the tenantId of any concept they've delivered
-- for. Picks the most-recent delivery to handle riders that moved between
-- tenants (rare).
UPDATE "riders" r
SET "tenantId" = sub."tenantId"
FROM (
  SELECT DISTINCT ON (o."riderId") o."riderId", c."tenantId"
  FROM "orders" o
  JOIN "concepts" c ON c.id = o."conceptId"
  WHERE o."riderId" IS NOT NULL AND c."tenantId" IS NOT NULL
  ORDER BY o."riderId", o."placedAt" DESC
) sub
WHERE r.id = sub."riderId" AND r."tenantId" IS NULL;

-- Foreign key + index. ON DELETE SET NULL keeps the rider row if the tenant
-- is hard-deleted (riders are people; we don't want them disappearing because
-- a JV unwound).
ALTER TABLE "riders"
  ADD CONSTRAINT "riders_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "tenants"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX IF NOT EXISTS "riders_tenantId_idx" ON "riders"("tenantId");
