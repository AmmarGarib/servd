-- Recipe lifecycle status: iteration → pending_approval → production.
--
-- A recipe is now either under testing (`iteration`), awaiting CEO/owner
-- sign-off (`pending_approval`), or live (`production`). New recipes default to
-- `iteration`; every recipe that already exists is live, so it's backfilled to
-- `production`. Promotion audit columns record who submitted / approved a recipe
-- and any rejection note.

CREATE TYPE "RecipeStatus" AS ENUM ('iteration', 'pending_approval', 'production');

-- Add the column with a temporary default so the existing rows get a value,
-- backfill them to production (they're already live), then set the real
-- go-forward default of `iteration` for new recipes.
ALTER TABLE "recipes" ADD COLUMN "status" "RecipeStatus" NOT NULL DEFAULT 'production';
UPDATE "recipes" SET "status" = 'production';
ALTER TABLE "recipes" ALTER COLUMN "status" SET DEFAULT 'iteration';

-- Promotion audit (nullable; plain staff-user IDs, no FK — mirrors createdBy).
ALTER TABLE "recipes" ADD COLUMN "submittedById"   TEXT;
ALTER TABLE "recipes" ADD COLUMN "submittedAt"     TIMESTAMP(3);
ALTER TABLE "recipes" ADD COLUMN "approvedById"    TEXT;
ALTER TABLE "recipes" ADD COLUMN "approvedAt"      TIMESTAMP(3);
ALTER TABLE "recipes" ADD COLUMN "rejectionReason" TEXT;

-- Inbox query (pending_approval) hits this often enough to index.
CREATE INDEX "recipes_status_idx" ON "recipes"("status");
