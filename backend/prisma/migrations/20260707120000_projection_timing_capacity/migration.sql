-- Timing & capacity block + per-brand tax rate for projections (ops model sheet).
-- Daily covers become calculable from seats × utilization × (operating hours ÷
-- turn time); taxRatePct adds a Profit-After-Tax line per brand.
ALTER TABLE "projection_brand_inputs"
  ADD COLUMN IF NOT EXISTS "seats"              INTEGER          NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "tableTurnHours"     DOUBLE PRECISION NOT NULL DEFAULT 1.5,
  ADD COLUMN IF NOT EXISTS "seatUtilizationPct" DOUBLE PRECISION NOT NULL DEFAULT 70,
  ADD COLUMN IF NOT EXISTS "breakfastHours"     DOUBLE PRECISION NOT NULL DEFAULT 4,
  ADD COLUMN IF NOT EXISTS "lunchHours"         DOUBLE PRECISION NOT NULL DEFAULT 4,
  ADD COLUMN IF NOT EXISTS "dinnerHours"        DOUBLE PRECISION NOT NULL DEFAULT 10,
  ADD COLUMN IF NOT EXISTS "taxRatePct"         DOUBLE PRECISION NOT NULL DEFAULT 0;
