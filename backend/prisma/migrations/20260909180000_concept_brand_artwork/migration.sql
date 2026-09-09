-- Brand microsite artwork, operator-editable.
--
-- The stackd brand page rendered its wordmark and its character from PNGs
-- bundled into the storefront build, so replacing a low-resolution export
-- meant a code change, an image rebuild and a redeploy. These two columns move
-- that to the admin.
--
-- Both are nullable with no default on purpose: NULL means "use the bundled
-- fallback", so every existing brand renders exactly as it does today and this
-- migration changes no behaviour on its own.
ALTER TABLE "concepts" ADD COLUMN "wordmarkUrl" TEXT;
ALTER TABLE "concepts" ADD COLUMN "mascotUrl"   TEXT;
