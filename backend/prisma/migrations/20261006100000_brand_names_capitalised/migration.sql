-- Brand names use normal capitalization (owner, 2026-10-06): Simmer, Stackd,
-- Flipd. The stax -> stackd rename had stored the name lowercase, which the
-- admin and tablet show as-is. Slugs are untouched.
UPDATE "concepts"
SET "name" = CASE lower(btrim("name"))
               WHEN 'simmer' THEN 'Simmer'
               WHEN 'stackd' THEN 'Stackd'
               WHEN 'flipd'  THEN 'Flipd'
             END
WHERE lower(btrim("name")) IN ('simmer', 'stackd', 'flipd')
  AND "name" <> CASE lower(btrim("name"))
                  WHEN 'simmer' THEN 'Simmer'
                  WHEN 'stackd' THEN 'Stackd'
                  WHEN 'flipd'  THEN 'Flipd'
                END;
