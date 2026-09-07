-- Location.tenantId — physical locations are company master data.
--
-- Before this column existed, GET /locations returned every company's
-- locations to every operator, and the boot-time seed linked EVERY brand
-- (across every company) to the default "Main Location". Net effect: GS
-- Foods' Locations page listed GSX Viva's brands on GS Foods' kitchens.
-- This adds the owning company, backfills it from the linked brands, drops
-- the cross-company brand links, and indexes the column for the scoped
-- reads in modules/locations/routes.ts.

ALTER TABLE "locations" ADD COLUMN IF NOT EXISTS "tenantId" TEXT;

-- Backfill from linked brands: the primary link wins, then the oldest link.
UPDATE "locations" l
SET "tenantId" = sub."tenantId"
FROM (
  SELECT DISTINCT ON (cl."locationId") cl."locationId", c."tenantId"
  FROM "concept_locations" cl
  JOIN "concepts" c ON c.id = cl."conceptId"
  WHERE c."tenantId" IS NOT NULL
  ORDER BY cl."locationId", cl."isPrimary" DESC, cl."createdAt" ASC
) sub
WHERE l.id = sub."locationId" AND l."tenantId" IS NULL;

-- Locations with no brand link at all: attach to the oldest active company,
-- mirroring the boot-time orphan rule for concepts/users, so nothing floats
-- outside every company view.
UPDATE "locations" l
SET "tenantId" = (
  SELECT t.id FROM "tenants" t
  WHERE t."isActive" = true AND t."deletedAt" IS NULL
  ORDER BY t."createdAt" ASC
  LIMIT 1
)
WHERE l."tenantId" IS NULL;

-- Drop cross-company brand links. A location owned by company A must not
-- list company B's brand. Orders and shifts reference the location row
-- directly (locationId), so history is untouched.
DELETE FROM "concept_locations" cl
USING "locations" l, "concepts" c
WHERE cl."locationId" = l.id
  AND cl."conceptId" = c.id
  AND l."tenantId" IS NOT NULL
  AND c."tenantId" IS NOT NULL
  AND c."tenantId" <> l."tenantId";

ALTER TABLE "locations"
  ADD CONSTRAINT "locations_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "tenants"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX IF NOT EXISTS "locations_tenantId_idx" ON "locations"("tenantId");
