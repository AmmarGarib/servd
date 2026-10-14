-- Brand kit (2026-10-14): `brand:<brand>:kit` is now the brand kit (kind
-- 'kit'), never a page. Before the kit existed an owner could add a page
-- called `kit` (brand:<brand>:kit, /brand/<brand>/pages/kit); such a row
-- would be read as a kit and stranded (review-back-admin-6). Rename every
-- such row to `brand:<brand>:kit-page` (or `kit-page-<n>` if that is taken)
-- so it stays an ordinary owner page. Versions and stats hang off layoutId,
-- so nothing else moves. Idempotent: a renamed row no longer matches.
DO $$
DECLARE
  r RECORD;
  target TEXT;
  n INT;
BEGIN
  FOR r IN
    SELECT id, slug FROM site_layouts
    WHERE slug ~ '^brand:[^:]+:kit$' AND kind <> 'kit'
  LOOP
    target := r.slug || '-page';
    n := 1;
    WHILE EXISTS (SELECT 1 FROM site_layouts WHERE slug = target) LOOP
      n := n + 1;
      target := r.slug || '-page-' || n;
    END LOOP;
    UPDATE site_layouts SET slug = target WHERE id = r.id;
    RAISE NOTICE 'site_layouts: renamed % to %', r.slug, target;
  END LOOP;
END $$;
