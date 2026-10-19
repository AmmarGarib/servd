-- Outlets (owner, 2026-10-19): "Simmer and Stackd are outlets of GS Foods" and "Viva needs to be changed to
-- Padel Fix, as we have changed locations". Data only, idempotent, and the company comes from the BRAND
-- (concepts.tenantId), never a company name.
--  1. Simmer, Stackd: a brand that already has a live linked outlet is left alone (made active if it was off).
--     Otherwise an unlinked live outlet of the brand's company named like the brand is linked; otherwise one
--     outlet named after the brand is created in the brand's company and linked as primary.
--  2. The outlet "Viva Padel Club" is renamed "Padel Fix" (slug, address and links unchanged: old links keep
--     working; the address is edited on the Locations page).
DO $$
DECLARE
  b RECORD;
  lid TEXT;
BEGIN
  FOR b IN
    SELECT c.id, c.name, c."tenantId" FROM concepts c
    WHERE c.slug IN ('simmer', 'stackd') AND c."deletedAt" IS NULL AND c."tenantId" IS NOT NULL
  LOOP
    SELECT l.id INTO lid FROM concept_locations cl JOIN locations l ON l.id = cl."locationId"
      WHERE cl."conceptId" = b.id AND l."deletedAt" IS NULL ORDER BY cl."isPrimary" DESC, cl."createdAt" LIMIT 1;
    IF lid IS NOT NULL THEN
      UPDATE locations SET "isActive" = true, "updatedAt" = now() WHERE id = lid AND "isActive" = false;
      CONTINUE;
    END IF;
    SELECT l.id INTO lid FROM locations l
      WHERE l."tenantId" = b."tenantId" AND l."deletedAt" IS NULL AND l.name ILIKE '%' || b.name || '%'
        AND NOT EXISTS (SELECT 1 FROM concept_locations x WHERE x."locationId" = l.id)
      ORDER BY l."createdAt" LIMIT 1;
    IF lid IS NULL THEN
      lid := gen_random_uuid()::text;
      INSERT INTO locations (id, slug, name, city, "isActive", "tenantId", "createdAt", "updatedAt")
      VALUES (lid, b.name || '-outlet-' || substr(md5(b.id), 1, 6), b.name, 'Karachi', true, b."tenantId", now(), now());
      UPDATE locations SET slug = lower(slug) WHERE id = lid;
    ELSE
      UPDATE locations SET "isActive" = true, "updatedAt" = now() WHERE id = lid;
    END IF;
    INSERT INTO concept_locations ("conceptId", "locationId", "isPrimary", "createdAt")
    VALUES (b.id, lid, true, now()) ON CONFLICT DO NOTHING;
  END LOOP;

  UPDATE locations SET name = 'Padel Fix', "updatedAt" = now()
  WHERE name = 'Viva Padel Club' AND "deletedAt" IS NULL;
END $$;
