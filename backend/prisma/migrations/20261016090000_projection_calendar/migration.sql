-- 20261016090000_projection_calendar — owner (2026-10-16): projections count the
-- ACTUAL trading days of each calendar month — the month's days minus the days
-- the brand is closed (Mondays by default) — instead of a flat 26.
SET lock_timeout = '10s';
ALTER TABLE "projections" ADD COLUMN "startPeriod" TEXT;
ALTER TABLE "projection_brand_inputs" ADD COLUMN "closedWeekdays" INTEGER[] NOT NULL DEFAULT ARRAY[1]::INTEGER[];
