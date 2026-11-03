-- 20261103160100_marketing_board — Marketing board + intern tracker (owner, 2026-11-03).
--
-- A board card IS a ContentEvent (the Content Calendar's one store): new nullable columns for the board, stage,
-- priority, reference links, published-at, revision count and an optional link to ONE dish / promo / campaign.
-- Plain calendar entries keep every new column NULL / empty and work as before. New company tables: boards (one
-- per brand, plus platform boards such as beanzbakes), card resources, comments, files (MediaAsset links), and
-- the tracker (trackees, weekly check-ins, monthly reviews). Every one carries tenantId with RLS (below) and is in
-- the company-merge repoint list (modules/tenants/routes.ts). Boards are seeded at boot
-- (modules/marketingBoard/boards.ts ensureMarketingBoards), not here.
--
-- Runbook: if this migration fails on deploy, run
--   prisma migrate resolve --rolled-back 20261103160100_marketing_board
-- in the api image before redeploying any image (P3009 blocks every image).
SET lock_timeout = '10s';

-- CreateEnum
CREATE TYPE "MarketingStage" AS ENUM ('idea', 'brief_ready', 'in_progress', 'in_review', 'approved', 'published');

-- CreateEnum
CREATE TYPE "MarketingPriority" AS ENUM ('low', 'normal', 'high', 'urgent');

-- CreateEnum
CREATE TYPE "MarketingBoardKind" AS ENUM ('brand', 'platform');

-- CreateEnum
CREATE TYPE "MarketingRecommendation" AS ENUM ('keep', 'extend', 'end');



-- AlterTable
ALTER TABLE "content_events" ADD COLUMN     "boardId" TEXT,
ADD COLUMN     "campaignId" TEXT,
ADD COLUMN     "menuItemId" TEXT,
ADD COLUMN     "priority" "MarketingPriority",
ADD COLUMN     "promoCodeId" TEXT,
ADD COLUMN     "publishedAt" TIMESTAMP(3),
ADD COLUMN     "referenceLinks" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "revisionCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "stage" "MarketingStage";

-- CreateTable
CREATE TABLE "marketing_boards" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" "MarketingBoardKind" NOT NULL DEFAULT 'brand',
    "conceptId" TEXT,
    "sort" INTEGER NOT NULL DEFAULT 0,
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "marketing_boards_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "content_event_resources" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "content_event_resources_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "content_event_comments" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "content_event_comments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "content_event_media" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "mediaAssetId" TEXT NOT NULL,
    "addedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "content_event_media_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "marketing_trackees" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "roleLabel" TEXT NOT NULL,
    "startDate" DATE NOT NULL,
    "endDate" DATE,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "marketing_trackees_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "marketing_check_ins" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "trackeeId" TEXT NOT NULL,
    "weekStart" DATE NOT NULL,
    "note" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "marketing_check_ins_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "marketing_reviews" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "trackeeId" TEXT NOT NULL,
    "month" TEXT NOT NULL,
    "strengths" TEXT NOT NULL,
    "improvements" TEXT NOT NULL,
    "recommendation" "MarketingRecommendation" NOT NULL,
    "sharedAt" TIMESTAMP(3),
    "authorId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "marketing_reviews_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "marketing_boards_tenantId_sort_idx" ON "marketing_boards"("tenantId", "sort");

-- CreateIndex
CREATE UNIQUE INDEX "marketing_boards_tenantId_name_key" ON "marketing_boards"("tenantId", "name");

-- CreateIndex
CREATE INDEX "content_event_resources_tenantId_userId_idx" ON "content_event_resources"("tenantId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "content_event_resources_eventId_userId_key" ON "content_event_resources"("eventId", "userId");

-- CreateIndex
CREATE INDEX "content_event_comments_eventId_createdAt_idx" ON "content_event_comments"("eventId", "createdAt");

-- CreateIndex
CREATE INDEX "content_event_comments_tenantId_idx" ON "content_event_comments"("tenantId");

-- CreateIndex
CREATE INDEX "content_event_media_tenantId_idx" ON "content_event_media"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "content_event_media_eventId_mediaAssetId_key" ON "content_event_media"("eventId", "mediaAssetId");

-- CreateIndex
CREATE UNIQUE INDEX "marketing_trackees_tenantId_employeeId_key" ON "marketing_trackees"("tenantId", "employeeId");

-- CreateIndex
CREATE INDEX "marketing_check_ins_trackeeId_weekStart_idx" ON "marketing_check_ins"("trackeeId", "weekStart");

-- CreateIndex
CREATE INDEX "marketing_check_ins_tenantId_idx" ON "marketing_check_ins"("tenantId");

-- CreateIndex
CREATE INDEX "marketing_reviews_tenantId_idx" ON "marketing_reviews"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "marketing_reviews_trackeeId_month_key" ON "marketing_reviews"("trackeeId", "month");

-- CreateIndex
CREATE INDEX "content_events_boardId_stage_idx" ON "content_events"("boardId", "stage");

-- AddForeignKey
ALTER TABLE "content_events" ADD CONSTRAINT "content_events_boardId_fkey" FOREIGN KEY ("boardId") REFERENCES "marketing_boards"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "content_events" ADD CONSTRAINT "content_events_menuItemId_fkey" FOREIGN KEY ("menuItemId") REFERENCES "menu_items"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "content_events" ADD CONSTRAINT "content_events_promoCodeId_fkey" FOREIGN KEY ("promoCodeId") REFERENCES "promo_codes"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "content_events" ADD CONSTRAINT "content_events_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "campaigns"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "marketing_boards" ADD CONSTRAINT "marketing_boards_conceptId_fkey" FOREIGN KEY ("conceptId") REFERENCES "concepts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "content_event_resources" ADD CONSTRAINT "content_event_resources_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "content_events"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "content_event_resources" ADD CONSTRAINT "content_event_resources_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "content_event_comments" ADD CONSTRAINT "content_event_comments_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "content_events"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "content_event_comments" ADD CONSTRAINT "content_event_comments_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "content_event_media" ADD CONSTRAINT "content_event_media_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "content_events"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "content_event_media" ADD CONSTRAINT "content_event_media_mediaAssetId_fkey" FOREIGN KEY ("mediaAssetId") REFERENCES "media_assets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "marketing_trackees" ADD CONSTRAINT "marketing_trackees_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "hr_employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "marketing_check_ins" ADD CONSTRAINT "marketing_check_ins_trackeeId_fkey" FOREIGN KEY ("trackeeId") REFERENCES "marketing_trackees"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "marketing_reviews" ADD CONSTRAINT "marketing_reviews_trackeeId_fkey" FOREIGN KEY ("trackeeId") REFERENCES "marketing_trackees"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ─── SQL-only objects (one statement per ';', no trailing comments)
ALTER TABLE "content_events" ADD CONSTRAINT "content_events_board_stage_chk" CHECK (("boardId" IS NULL) = ("stage" IS NULL));
ALTER TABLE "content_events" ADD CONSTRAINT "content_events_one_link_chk" CHECK ((("menuItemId" IS NOT NULL)::int + ("promoCodeId" IS NOT NULL)::int + ("campaignId" IS NOT NULL)::int) <= 1);
ALTER TABLE "content_events" ADD CONSTRAINT "content_events_revisions_chk" CHECK ("revisionCount" >= 0);
ALTER TABLE "marketing_boards" ADD CONSTRAINT "marketing_boards_kind_chk" CHECK (("kind" = 'brand' AND "conceptId" IS NOT NULL) OR ("kind" = 'platform' AND "conceptId" IS NULL));
ALTER TABLE "marketing_reviews" ADD CONSTRAINT "marketing_reviews_month_chk" CHECK ("month" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$');

-- ─── Row-level security (the guarded wave-A/B pattern, as 20261026180000_social_connections).
DO $do$
DECLARE
  t text;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'app_is_service_mode')
     AND EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'app_tenant_ids') THEN
    FOREACH t IN ARRAY ARRAY['marketing_boards', 'content_event_resources', 'content_event_comments', 'content_event_media', 'marketing_trackees', 'marketing_check_ins', 'marketing_reviews']
    LOOP
      IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = current_schema() AND tablename = t) THEN
        EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
        EXECUTE format(
          'CREATE POLICY %I ON %I FOR ALL '
          'USING (app_is_service_mode() OR %I."tenantId" = ANY(app_tenant_ids())) '
          'WITH CHECK (app_is_service_mode() OR %I."tenantId" = ANY(app_tenant_ids()))',
          t || '_rls', t, t, t);
      END IF;
    END LOOP;
  END IF;
END
$do$;
