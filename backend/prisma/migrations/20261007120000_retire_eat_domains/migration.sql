-- Retire the old eat* brand domains (owner, 2026-10-07: "eatstax can go";
-- eatsimmer.com / eatflipd.com don't resolve). The brands live on
-- stackd.pk / simmer.pk / flipd.pk. Soft-deleted like any removed domain, so
-- CORS and host routing stop trusting them; rows stay for history.
UPDATE "domains"
SET "deletedAt" = now(), "updatedAt" = now()
WHERE lower("hostname") IN ('eatstax.com', 'www.eatstax.com', 'eatsimmer.com', 'www.eatsimmer.com', 'eatflipd.com', 'www.eatflipd.com')
  AND "deletedAt" IS NULL;
