-- Cross-module customer rollups. Denormalized so the host stand sees the
-- customer's full risk/value picture in one render. Updated by:
--   - order completion (lastVisitAt)
--   - reservation:seated (lastVisitAt)
--   - reservation:no_show (noShowCount, lastNoShowAt)
--   - complaint:create (complaintCount, lastComplaintAt)
--   - review:create (reviewCount, lastReviewedAt, avgReviewRating)
--
-- All defaulted/nullable so existing rows keep working unchanged.

ALTER TABLE "customers"
  ADD COLUMN "noShowCount"       INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "complaintCount"    INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "reviewCount"       INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "avgReviewRating"   DOUBLE PRECISION,
  ADD COLUMN "lastVisitAt"       TIMESTAMP(3),
  ADD COLUMN "lastComplaintAt"   TIMESTAMP(3),
  ADD COLUMN "lastReviewedAt"    TIMESTAMP(3),
  ADD COLUMN "lastNoShowAt"      TIMESTAMP(3),
  ADD COLUMN "staffNotes"        TEXT;

-- Backfill from existing data so live UIs aren't lying on day one.
UPDATE "customers" c
   SET "noShowCount"     = (SELECT COUNT(*) FROM "reservations" r WHERE r."customerId" = c.id AND r.status = 'no_show'),
       "lastNoShowAt"    = (SELECT MAX(r."updatedAt") FROM "reservations" r WHERE r."customerId" = c.id AND r.status = 'no_show'),
       "complaintCount"  = (SELECT COUNT(*) FROM "order_complaints" oc WHERE oc."customerId" = c.id),
       "lastComplaintAt" = (SELECT MAX(oc."createdAt") FROM "order_complaints" oc WHERE oc."customerId" = c.id),
       "reviewCount"     = (SELECT COUNT(*) FROM "order_reviews" orw WHERE orw."customerId" = c.id),
       "avgReviewRating" = (SELECT AVG(orw."rating")::float FROM "order_reviews" orw WHERE orw."customerId" = c.id),
       "lastReviewedAt"  = (SELECT MAX(orw."createdAt") FROM "order_reviews" orw WHERE orw."customerId" = c.id),
       "lastVisitAt"     = GREATEST(
                              c."lastOrderAt",
                              (SELECT MAX(r."seatedAt") FROM "reservations" r WHERE r."customerId" = c.id AND r."seatedAt" IS NOT NULL)
                           );
