CREATE TABLE "site_layouts" (
  "id"          TEXT          NOT NULL,
  "slug"        TEXT          NOT NULL,
  "title"       TEXT,
  "blocks"      JSONB         NOT NULL,
  "updatedById" TEXT,
  "publishedAt" TIMESTAMP(3),
  "createdAt"   TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"   TIMESTAMP(3)  NOT NULL,
  CONSTRAINT "site_layouts_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "site_layouts_slug_key" ON "site_layouts" ("slug");
