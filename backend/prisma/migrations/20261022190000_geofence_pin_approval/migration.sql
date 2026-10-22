-- Geo-fenced attendance (owner, 2026-10-22): the time clock measures from the pin and radius the CEO APPROVED.
ALTER TABLE "locations" ADD COLUMN "fenceLatitude" DOUBLE PRECISION;
ALTER TABLE "locations" ADD COLUMN "fenceLongitude" DOUBLE PRECISION;
ALTER TABLE "locations" ADD COLUMN "fenceRadiusMetres" INTEGER;
ALTER TABLE "locations" ADD COLUMN "fencePinApprovedAt" TIMESTAMP(3);
ALTER TABLE "locations" ADD COLUMN "fencePinApprovedById" TEXT;
ALTER TABLE "locations" ADD COLUMN "fencePinRejected" JSONB;
ALTER TABLE "locations" ADD CONSTRAINT "locations_fence_radius_chk" CHECK ("fenceRadiusMetres" IS NULL OR "fenceRadiusMetres" BETWEEN 10 AND 5000);
ALTER TABLE "locations" ADD CONSTRAINT "locations_fence_pin_chk" CHECK (("fenceLatitude" IS NULL) = ("fenceLongitude" IS NULL));

-- Carry-over: in a company whose geofence is ALREADY switched on, today's pins stay in force (approved as they are,
-- approver unknown) so nobody's punch changes on deploy. Everywhere else every pin waits for the CEO.
UPDATE "locations" l
SET "fenceLatitude" = l."latitude", "fenceLongitude" = l."longitude", "fenceRadiusMetres" = l."geofenceRadiusMetres",
    "fencePinApprovedAt" = NOW()
WHERE l."latitude" IS NOT NULL AND l."longitude" IS NOT NULL AND l."tenantId" IS NOT NULL
  AND EXISTS (SELECT 1 FROM "operations_configs" o WHERE o."tenantId" = l."tenantId" AND o."geofenceEnforced" = true);
