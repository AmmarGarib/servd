-- Add cooking/assembly instructions to menu items
ALTER TABLE "menu_items" ADD COLUMN "instructions" TEXT;
ALTER TABLE "menu_items" ADD COLUMN "instructions_urdu" TEXT;

-- Media asset library
CREATE TABLE "media_assets" (
  "id"           TEXT NOT NULL,
  "key"          TEXT NOT NULL,
  "url"          TEXT NOT NULL,
  "filename"     TEXT NOT NULL,
  "contentType"  TEXT NOT NULL,
  "category"     TEXT NOT NULL DEFAULT 'general',
  "uploadedById" TEXT,
  "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "media_assets_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "media_assets_category_createdAt_idx" ON "media_assets"("category", "createdAt");
