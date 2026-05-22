-- Per-brand 12-month P&L projections. Replaces the legacy ProForma flow.
-- Inputs are stored here; staff/opex/capex come from their live tables at
-- read time so projections always reflect current org state.

CREATE TABLE IF NOT EXISTS "projections" (
    "id"        TEXT NOT NULL,
    "tenantId"  TEXT,
    "name"      TEXT NOT NULL DEFAULT 'Default scenario',
    "isActive"  BOOLEAN NOT NULL DEFAULT true,
    "rampCurve" DOUBLE PRECISION[] DEFAULT ARRAY[0.30, 0.45, 0.60, 0.75, 0.90, 1.00, 1.00, 1.00, 1.00, 1.00, 1.00, 1.00]::DOUBLE PRECISION[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "projections_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "projection_brand_inputs" (
    "id"                  TEXT NOT NULL,
    "projectionId"        TEXT NOT NULL,
    "conceptId"           TEXT NOT NULL,
    "launchMonth"         INTEGER NOT NULL DEFAULT 1,
    "checkAverageCents"   INTEGER NOT NULL DEFAULT 0,
    "tradingDaysPerMonth" INTEGER NOT NULL DEFAULT 26,
    "foodCostPct"         DOUBLE PRECISION NOT NULL DEFAULT 32,
    "packagingCostPct"    DOUBLE PRECISION NOT NULL DEFAULT 8,
    "dailyCoversAtSS"     INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "projection_brand_inputs_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "projection_brand_inputs_projectionId_conceptId_key"
    ON "projection_brand_inputs"("projectionId", "conceptId");

CREATE INDEX IF NOT EXISTS "projection_brand_inputs_projectionId_idx"
    ON "projection_brand_inputs"("projectionId");

ALTER TABLE "projection_brand_inputs"
    ADD CONSTRAINT "projection_brand_inputs_projectionId_fkey"
    FOREIGN KEY ("projectionId") REFERENCES "projections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "projection_brand_inputs"
    ADD CONSTRAINT "projection_brand_inputs_conceptId_fkey"
    FOREIGN KEY ("conceptId") REFERENCES "concepts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
