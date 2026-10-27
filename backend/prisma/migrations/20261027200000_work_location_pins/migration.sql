-- Work locations as map pins (owner, 2026-10-27: "make work locations a system in which i can add multiple pin
-- locations"). An employee's work location is EITHER a company Location (as before) OR a custom map pin of that
-- employee only. A pin is measured only once the CEO approves it (approval type work_pin), mirroring Location.fence*.
-- No new table: hr_work_locations keeps its tenantId, RLS policy and company-merge repoint.
ALTER TABLE "hr_work_locations" ALTER COLUMN "locationId" DROP NOT NULL;
ALTER TABLE "hr_work_locations" ADD COLUMN "label" TEXT;
ALTER TABLE "hr_work_locations" ADD COLUMN "latitude" DOUBLE PRECISION;
ALTER TABLE "hr_work_locations" ADD COLUMN "longitude" DOUBLE PRECISION;
ALTER TABLE "hr_work_locations" ADD COLUMN "fenceLatitude" DOUBLE PRECISION;
ALTER TABLE "hr_work_locations" ADD COLUMN "fenceLongitude" DOUBLE PRECISION;
ALTER TABLE "hr_work_locations" ADD COLUMN "fenceRadiusMetres" INTEGER;
ALTER TABLE "hr_work_locations" ADD COLUMN "fencePinApprovedAt" TIMESTAMP(3);
ALTER TABLE "hr_work_locations" ADD COLUMN "fencePinApprovedById" TEXT;
ALTER TABLE "hr_work_locations" ADD COLUMN "fencePinRejected" JSONB;
ALTER TABLE "hr_work_locations" ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

ALTER TABLE "clock_logs" ADD COLUMN "workPinId" TEXT;
ALTER TABLE "clock_logs" ADD COLUMN "pinLabel" TEXT;

-- ─── SQL-only objects
ALTER TABLE "hr_work_locations" ADD CONSTRAINT "hr_work_locations_kind_chk" CHECK (("locationId" IS NOT NULL AND "latitude" IS NULL AND "longitude" IS NULL AND "fenceLatitude" IS NULL AND "fenceLongitude" IS NULL) OR ("locationId" IS NULL AND "latitude" IS NOT NULL AND "longitude" IS NOT NULL AND "label" IS NOT NULL AND length(btrim("label")) > 0));
ALTER TABLE "hr_work_locations" ADD CONSTRAINT "hr_work_locations_fence_pin_chk" CHECK (("fenceLatitude" IS NULL) = ("fenceLongitude" IS NULL));
ALTER TABLE "hr_work_locations" ADD CONSTRAINT "hr_work_locations_radius_chk" CHECK (("radiusMetres" IS NULL OR "radiusMetres" BETWEEN 10 AND 5000) AND ("fenceRadiusMetres" IS NULL OR "fenceRadiusMetres" BETWEEN 10 AND 5000));
-- ─── end SQL-only objects
