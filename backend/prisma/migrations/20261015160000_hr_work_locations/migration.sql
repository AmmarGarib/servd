-- Attendance by work location (owner, 2026-10-15): an employee may have several work locations (Locations of their
-- own company); the time clock measures a punch against the nearest of them and FLAGS a punch outside the radius
-- (never refuses it). Additive only.
SET lock_timeout = '10s';

ALTER TABLE "locations" ADD COLUMN "geofenceRadiusMetres" INTEGER;

ALTER TABLE "clock_logs"
  ADD COLUMN "tenantId" TEXT,
  ADD COLUMN "locationId" TEXT,
  ADD COLUMN "outOfArea" BOOLEAN;
CREATE INDEX "clock_logs_tenantId_recordedAt_idx" ON "clock_logs"("tenantId", "recordedAt");

CREATE TABLE "hr_work_locations" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "employeeId" TEXT NOT NULL,
  "locationId" TEXT NOT NULL,
  "radiusMetres" INTEGER,
  "isPrimary" BOOLEAN NOT NULL DEFAULT false,
  "createdById" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "hr_work_locations_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "hr_work_locations_employeeId_locationId_key" ON "hr_work_locations"("employeeId", "locationId");
CREATE INDEX "hr_work_locations_tenantId_idx" ON "hr_work_locations"("tenantId");
CREATE INDEX "hr_work_locations_locationId_idx" ON "hr_work_locations"("locationId");
ALTER TABLE "hr_work_locations" ADD CONSTRAINT "hr_work_locations_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "hr_work_locations" ADD CONSTRAINT "hr_work_locations_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "hr_employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "hr_work_locations" ADD CONSTRAINT "hr_work_locations_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "locations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
-- A radius is a positive number of metres.
ALTER TABLE "hr_work_locations" ADD CONSTRAINT "hr_work_locations_radius_chk" CHECK ("radiusMetres" IS NULL OR "radiusMetres" BETWEEN 10 AND 5000);
ALTER TABLE "locations" ADD CONSTRAINT "locations_geofence_radius_chk" CHECK ("geofenceRadiusMetres" IS NULL OR "geofenceRadiusMetres" BETWEEN 10 AND 5000);

-- Existing employees keep working as before: their HR branch (hr_employees.locationId) becomes their first work
-- location, when it is a location of their own company.
INSERT INTO "hr_work_locations" ("id", "tenantId", "employeeId", "locationId", "isPrimary")
SELECT 'hwl_' || e."id", e."tenantId", e."id", e."locationId", true
FROM "hr_employees" e
JOIN "locations" l ON l."id" = e."locationId" AND l."tenantId" = e."tenantId"
WHERE e."locationId" IS NOT NULL
ON CONFLICT DO NOTHING;
