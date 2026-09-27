-- Storefront content module (owner decision 41): drafts, CEO approval,
-- versions, scheduled publishing, A/B counters, and a typed content library.

ALTER TABLE "site_layouts"
  ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'page',
  ADD COLUMN "tenantId" TEXT,
  ADD COLUMN "settings" JSONB,
  ADD COLUMN "draftBlocks" JSONB,
  ADD COLUMN "draftSettings" JSONB,
  ADD COLUMN "draftStatus" TEXT NOT NULL DEFAULT 'none',
  ADD COLUMN "draftUpdatedById" TEXT,
  ADD COLUMN "draftUpdatedAt" TIMESTAMP(3),
  ADD COLUMN "submittedById" TEXT,
  ADD COLUMN "submittedAt" TIMESTAMP(3),
  ADD COLUMN "reviewNote" TEXT,
  ADD COLUMN "reviewedById" TEXT,
  ADD COLUMN "reviewedAt" TIMESTAMP(3),
  ADD COLUMN "publishAt" TIMESTAMP(3),
  ADD COLUMN "liveVersion" INTEGER NOT NULL DEFAULT 0;

-- Existing rows: kind from the slug, company from the brand.
UPDATE "site_layouts" SET "kind" = 'hero' WHERE "slug" = 'servd:hero';
UPDATE "site_layouts" SET "kind" = 'footer' WHERE "slug" LIKE 'brand:%:footer';
UPDATE "site_layouts" sl SET "tenantId" = c."tenantId"
  FROM "concepts" c
  WHERE sl."slug" LIKE 'brand:%'
    AND c."slug" = split_part(substr(sl."slug", 7), ':', 1);

CREATE TABLE "site_layout_versions" (
  "id" TEXT NOT NULL,
  "layoutId" TEXT NOT NULL,
  "version" INTEGER NOT NULL,
  "blocks" JSONB NOT NULL,
  "settings" JSONB,
  "publishedById" TEXT,
  "approvedById" TEXT,
  "note" TEXT,
  "publishedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "site_layout_versions_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "site_layout_versions_layoutId_version_key" ON "site_layout_versions"("layoutId", "version");
ALTER TABLE "site_layout_versions" ADD CONSTRAINT "site_layout_versions_layoutId_fkey"
  FOREIGN KEY ("layoutId") REFERENCES "site_layouts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "site_layout_stats" (
  "id" TEXT NOT NULL,
  "layoutId" TEXT NOT NULL,
  "version" INTEGER NOT NULL,
  "variant" TEXT NOT NULL,
  "views" INTEGER NOT NULL DEFAULT 0,
  "conversions" INTEGER NOT NULL DEFAULT 0,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "site_layout_stats_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "site_layout_stats_layoutId_version_variant_key" ON "site_layout_stats"("layoutId", "version", "variant");
ALTER TABLE "site_layout_stats" ADD CONSTRAINT "site_layout_stats_layoutId_fkey"
  FOREIGN KEY ("layoutId") REFERENCES "site_layouts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- What is live today becomes version 1, so rollback has a floor.
UPDATE "site_layouts" SET "liveVersion" = 1;
INSERT INTO "site_layout_versions" ("id", "layoutId", "version", "blocks", "publishedById", "note", "publishedAt")
  SELECT gen_random_uuid()::text, "id", 1, "blocks", "updatedById", 'Live before the content module', COALESCE("publishedAt", "updatedAt")
  FROM "site_layouts";

CREATE INDEX "site_layouts_tenantId_kind_idx" ON "site_layouts"("tenantId", "kind");
CREATE INDEX "site_layouts_draftStatus_publishAt_idx" ON "site_layouts"("draftStatus", "publishAt");

-- Content library.
ALTER TABLE "media_assets"
  ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'image',
  ADD COLUMN "name" TEXT,
  ADD COLUMN "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "conceptId" TEXT,
  ADD COLUMN "text" TEXT,
  ADD COLUMN "fontFamily" TEXT;
UPDATE "media_assets" SET "kind" = 'video' WHERE "contentType" LIKE 'video/%';
UPDATE "media_assets" SET "name" = "filename" WHERE "name" IS NULL;
CREATE INDEX "media_assets_tenantId_kind_idx" ON "media_assets"("tenantId", "kind");
