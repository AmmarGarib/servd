-- Race-proof booking: postgres exclusion constraint that physically prevents
-- two reservations from claiming the same table at overlapping times.
--
-- The exclusion constraint is enforced at the row-write moment, so it's
-- immune to time-of-check / time-of-use races between concurrent INSERTs.
-- Application code can still do a friendly pre-check for fast 409s, but the
-- DB is the source of truth for "this slot is mine."
--
-- We use `tsrange` (not `tstzrange`) because:
--   - prisma maps DateTime to `timestamp(3)` (without time zone) by default,
--     and our reservation columns match that.
--   - tsrange IS marked IMMUTABLE in postgres, which it must be to appear
--     in an index expression. tstzrange depends on the session timezone
--     and is therefore not IMMUTABLE.
--   - All app code stores UTC-equivalent timestamps consistently, so
--     comparing raw timestamps without TZ is correct.
--
-- Filter conditions:
--   - tableId IS NOT NULL: only enforce on reservations with an actual table
--     assignment. Waitlist / unseated bookings are exempt by design (host can
--     hand-place them).
--   - status IN ('booked','confirmed','seated'): cancelled/no_show/completed
--     reservations don't block their old slot.
--
-- Violation: pg error code 23P01 (exclusion_violation), surfaced by Prisma
-- as P2010. The reservation routes wrap writes with `withTableOverlapGuard`
-- which maps this to a friendly HTTP 409.

CREATE EXTENSION IF NOT EXISTS btree_gist;

ALTER TABLE "reservations"
  ADD CONSTRAINT "reservations_no_table_overlap"
  EXCLUDE USING gist (
    "tableId" WITH =,
    tsrange("startTime", "endTime", '[)') WITH &&
  )
  WHERE (
    "tableId" IS NOT NULL
    AND status IN ('booked', 'confirmed', 'seated')
  );
