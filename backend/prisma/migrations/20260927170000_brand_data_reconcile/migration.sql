-- Brand / customer-config reconcile — DATA ONLY (no schema change).
-- Owner decisions 18 (address + pin per kitchen = Location; phone + WhatsApp
-- per brand) and 19 (delivery beyond the last zone is refused; radius-only
-- brands get one zone at their current fee). Idempotent: every step only
-- fills what is missing.

-- 1. One delivery zone per brand that only has a radius (decision 19).
--    "Only a radius" = no ACTIVE zone covers the brand (none of its own, none
--    of its company's "All brands" zones). Until now such a brand delivered
--    anywhere inside Concept.deliveryRadiusKm at fee 0 with no minimum
--    (computeDeliveryFee returned 0 when no zone matched), so the zone keeps
--    exactly that: 0 → radius km, fee 0, no minimum. Concept has no delivery
--    fee column; the fee the customer paid was 0.
INSERT INTO "delivery_zones"
  ("id", "tenantId", "conceptId", "name", "radiusKmMin", "radiusKmMax",
   "feeCents", "minOrderCents", "isActive", "sortOrder", "createdAt", "updatedAt")
SELECT replace(gen_random_uuid()::text, '-', ''), c."tenantId", c.id, 'Delivery area',
       0, c."deliveryRadiusKm", 0, 0, true, 0, now(), now()
FROM "concepts" c
WHERE c."deletedAt" IS NULL
  AND c."tenantId" IS NOT NULL
  AND c."deliveryRadiusKm" > 0
  AND NOT EXISTS (
    SELECT 1 FROM "delivery_zones" z
    WHERE z."isActive" = true AND z."tenantId" = c."tenantId"
      AND (z."conceptId" = c.id OR z."conceptId" IS NULL)
  );

-- 2a. Location is canonical for the address and pin (decision 18). Fill a
--     kitchen's EMPTY address / pin from the brand it serves (primary link
--     first, then the oldest) — never overwrite what the kitchen has.
UPDATE "locations" l
SET "address"   = COALESCE(NULLIF(btrim(l."address"), ''), src."address"),
    "latitude"  = CASE WHEN l."latitude" IS NULL OR l."longitude" IS NULL THEN src."latitude"  ELSE l."latitude"  END,
    "longitude" = CASE WHEN l."latitude" IS NULL OR l."longitude" IS NULL THEN src."longitude" ELSE l."longitude" END,
    "updatedAt" = now()
FROM (
  SELECT DISTINCT ON (cl."locationId") cl."locationId", c."address", c."latitude", c."longitude"
  FROM "concept_locations" cl
  JOIN "concepts" c ON c.id = cl."conceptId"
  WHERE c."deletedAt" IS NULL
    AND (NULLIF(btrim(c."address"), '') IS NOT NULL OR (c."latitude" IS NOT NULL AND c."longitude" IS NOT NULL))
  ORDER BY cl."locationId", cl."isPrimary" DESC, cl."createdAt" ASC
) src
WHERE l.id = src."locationId"
  AND l."deletedAt" IS NULL
  AND (NULLIF(btrim(l."address"), '') IS NULL OR l."latitude" IS NULL OR l."longitude" IS NULL);

-- 2b. A brand with an address or pin but NO live kitchen gets one, so every
--     address on the storefront comes from a Location from now on.
WITH orphan AS (
  SELECT c.id, c.slug, c.name, c."tenantId", NULLIF(btrim(c."address"), '') AS address,
         c."latitude", c."longitude",
         c.slug || '-kitchen-' || substr(md5(c.id), 1, 6) AS loc_slug
  FROM "concepts" c
  WHERE c."deletedAt" IS NULL
    AND c."tenantId" IS NOT NULL
    AND (NULLIF(btrim(c."address"), '') IS NOT NULL OR (c."latitude" IS NOT NULL AND c."longitude" IS NOT NULL))
    AND NOT EXISTS (
      SELECT 1 FROM "concept_locations" cl
      JOIN "locations" l ON l.id = cl."locationId"
      WHERE cl."conceptId" = c.id AND l."deletedAt" IS NULL
    )
), ins AS (
  INSERT INTO "locations" ("id", "slug", "name", "address", "latitude", "longitude", "isActive", "tenantId", "createdAt", "updatedAt")
  SELECT gen_random_uuid()::text, o.loc_slug, o.name || ' kitchen', o.address, o."latitude", o."longitude", true, o."tenantId", now(), now()
  FROM orphan o
  ON CONFLICT ("slug") DO NOTHING
  RETURNING id, slug
)
INSERT INTO "concept_locations" ("conceptId", "locationId", "isPrimary", "createdAt")
SELECT o.id, ins.id, true, now()
FROM orphan o JOIN ins ON ins.slug = o.loc_slug
ON CONFLICT DO NOTHING;

-- 3. Custom domains: the Domain table is the one list. Seed the 9 hosts the
--    retired storefront BRAND_DOMAIN_MAP served, active (they are live today).
--    An existing row for the host is re-activated and pointed at the brand.
INSERT INTO "domains"
  ("id", "tenantId", "conceptId", "hostname", "purpose", "status", "verificationToken",
   "verifiedAt", "sslIssuedAt", "notes", "createdAt", "updatedAt")
SELECT 'dom' || substr(md5(v.host), 1, 22), c."tenantId", c.id, v.host, 'brand_microsite', 'active',
       'servd_' || substr(md5(v.host || clock_timestamp()::text), 1, 16),
       now(), now(), 'Seeded from the retired storefront BRAND_DOMAIN_MAP', now(), now()
FROM (VALUES
  ('flipd.pk', 'flipd'), ('www.flipd.pk', 'flipd'),
  ('stackd.pk', 'stackd'), ('www.stackd.pk', 'stackd'),
  ('simmer.pk', 'simmer'), ('www.simmer.pk', 'simmer'),
  ('eatstax.com', 'stackd'), ('eatsimmer.com', 'simmer'), ('eatflipd.com', 'flipd')
) AS v(host, slug)
JOIN "concepts" c ON c.slug = v.slug AND c."deletedAt" IS NULL
ON CONFLICT ("hostname") DO UPDATE
  SET "status" = 'active', "conceptId" = EXCLUDED."conceptId", "tenantId" = EXCLUDED."tenantId",
      "purpose" = 'brand_microsite', "deletedAt" = NULL, "updatedAt" = now()
  WHERE "domains"."status" <> 'active' OR "domains"."deletedAt" IS NOT NULL
     OR "domains"."conceptId" IS DISTINCT FROM EXCLUDED."conceptId";

-- 4a. WhatsApp lives on the brand (Concept.whatsapp). Copy a brand footer's
--     social.whatsapp into it where the brand has none (digits only — the
--     footer field often held a wa.me URL).
UPDATE "concepts" c
SET "whatsapp" = regexp_replace(f.wa, '\D', '', 'g'), "updatedAt" = now()
FROM (
  SELECT substring(s.slug FROM '^brand:(.*):footer$') AS brand_slug,
         (SELECT b -> 'social' ->> 'whatsapp'
            FROM jsonb_array_elements(s.blocks) b
           WHERE b ->> 'type' = 'brandFooter' LIMIT 1) AS wa
  FROM "site_layouts" s
  WHERE s.slug LIKE 'brand:%:footer' AND jsonb_typeof(s.blocks) = 'array'
) f
WHERE c.slug = f.brand_slug
  AND c."deletedAt" IS NULL
  AND NULLIF(btrim(c."whatsapp"), '') IS NULL
  AND regexp_replace(COALESCE(f.wa, ''), '\D', '', 'g') <> '';

-- 4b. Brand voice lives on the brand (Concept.brandVoice). Copy the company-
--     level OperationsConfig.brandVoiceNotes to each of its brands that has none.
UPDATE "concepts" c
SET "brandVoice" = left(btrim(oc."brandVoiceNotes"), 500), "updatedAt" = now()
FROM "operations_configs" oc
WHERE oc."tenantId" = c."tenantId" AND oc."scope" = 'global' AND oc."scopeId" IS NULL
  AND NULLIF(btrim(oc."brandVoiceNotes"), '') IS NOT NULL
  AND NULLIF(btrim(c."brandVoice"), '') IS NULL
  AND c."deletedAt" IS NULL;

-- 4c. Social links live in the brand footer. Give a brand with NO footer row
--     its company's OperationsConfig handles (existing footers are left alone:
--     they are what the storefront already shows).
INSERT INTO "site_layouts" ("id", "slug", "title", "blocks", "createdAt", "updatedAt")
SELECT gen_random_uuid()::text, 'brand:' || c.slug || ':footer', 'Footer · ' || c.slug,
       jsonb_build_array(jsonb_build_object(
         'id', 'footer', 'type', 'brandFooter',
         'social', jsonb_strip_nulls(jsonb_build_object(
           'instagram', CASE WHEN NULLIF(btrim(oc."socialInstagramHandle"), '') IS NOT NULL
                             THEN 'https://instagram.com/' || ltrim(btrim(oc."socialInstagramHandle"), '@') END,
           'tiktok',    CASE WHEN NULLIF(btrim(oc."socialTiktokHandle"), '') IS NOT NULL
                             THEN 'https://tiktok.com/@' || ltrim(btrim(oc."socialTiktokHandle"), '@') END,
           'facebook',  NULLIF(btrim(oc."socialFacebookUrl"), '')
         ))
       )),
       now(), now()
FROM "concepts" c
JOIN "operations_configs" oc
  ON oc."tenantId" = c."tenantId" AND oc."scope" = 'global' AND oc."scopeId" IS NULL
WHERE c."deletedAt" IS NULL
  AND COALESCE(NULLIF(btrim(oc."socialInstagramHandle"), ''), NULLIF(btrim(oc."socialTiktokHandle"), ''), NULLIF(btrim(oc."socialFacebookUrl"), '')) IS NOT NULL
ON CONFLICT ("slug") DO NOTHING;
