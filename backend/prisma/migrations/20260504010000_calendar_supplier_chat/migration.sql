-- Supplier: add category + assigned staff
ALTER TABLE "suppliers" ADD COLUMN "category" TEXT;
ALTER TABLE "suppliers" ADD COLUMN "assignedStaffId" TEXT;
ALTER TABLE "suppliers" ADD CONSTRAINT "suppliers_assignedStaffId_fkey"
  FOREIGN KEY ("assignedStaffId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Content Calendar
CREATE TYPE "ContentEventType" AS ENUM (
  'social_post','menu_change','seasonal_ingredient','deal','shoot','event_promo','reminder','task'
);
CREATE TYPE "ContentEventStatus" AS ENUM ('draft','scheduled','live','done','cancelled');
CREATE TYPE "SocialPlatform" AS ENUM ('instagram','facebook','tiktok');
CREATE TYPE "SocialPostStatus" AS ENUM ('draft','scheduled','published','failed');

CREATE TABLE "content_events" (
  "id"          TEXT NOT NULL,
  "title"       TEXT NOT NULL,
  "description" TEXT,
  "type"        "ContentEventType" NOT NULL,
  "startDate"   TIMESTAMP(3) NOT NULL,
  "endDate"     TIMESTAMP(3),
  "allDay"      BOOLEAN NOT NULL DEFAULT true,
  "status"      "ContentEventStatus" NOT NULL DEFAULT 'draft',
  "conceptId"   TEXT,
  "assigneeId"  TEXT,
  "department"  TEXT,
  "color"       TEXT,
  "metadata"    JSONB,
  "createdById" TEXT NOT NULL,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "content_events_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "content_events_startDate_idx" ON "content_events"("startDate");
CREATE INDEX "content_events_conceptId_startDate_idx" ON "content_events"("conceptId","startDate");
ALTER TABLE "content_events" ADD CONSTRAINT "content_events_conceptId_fkey"
  FOREIGN KEY ("conceptId") REFERENCES "concepts"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "content_events" ADD CONSTRAINT "content_events_assigneeId_fkey"
  FOREIGN KEY ("assigneeId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "content_events" ADD CONSTRAINT "content_events_createdById_fkey"
  FOREIGN KEY ("createdById") REFERENCES "users"("id") ON UPDATE CASCADE;

CREATE TABLE "social_posts" (
  "id"             TEXT NOT NULL,
  "eventId"        TEXT NOT NULL,
  "platform"       "SocialPlatform" NOT NULL,
  "caption"        TEXT NOT NULL,
  "mediaUrls"      TEXT[] NOT NULL DEFAULT '{}',
  "scheduledFor"   TIMESTAMP(3) NOT NULL,
  "publishedAt"    TIMESTAMP(3),
  "status"         "SocialPostStatus" NOT NULL DEFAULT 'draft',
  "platformPostId" TEXT,
  "error"          TEXT,
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "social_posts_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "social_posts_eventId_key" ON "social_posts"("eventId");
CREATE INDEX "social_posts_scheduledFor_status_idx" ON "social_posts"("scheduledFor","status");
ALTER TABLE "social_posts" ADD CONSTRAINT "social_posts_eventId_fkey"
  FOREIGN KEY ("eventId") REFERENCES "content_events"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Supplier chat
CREATE TABLE "supplier_conversations" (
  "id"         TEXT NOT NULL,
  "supplierId" TEXT NOT NULL,
  "staffId"    TEXT NOT NULL,
  "subject"    TEXT,
  "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "supplier_conversations_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "supplier_conversations_supplierId_idx" ON "supplier_conversations"("supplierId");
CREATE INDEX "supplier_conversations_staffId_idx" ON "supplier_conversations"("staffId");
ALTER TABLE "supplier_conversations" ADD CONSTRAINT "supplier_conversations_supplierId_fkey"
  FOREIGN KEY ("supplierId") REFERENCES "suppliers"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "supplier_conversations" ADD CONSTRAINT "supplier_conversations_staffId_fkey"
  FOREIGN KEY ("staffId") REFERENCES "users"("id") ON UPDATE CASCADE;

CREATE TABLE "supplier_messages" (
  "id"             TEXT NOT NULL,
  "conversationId" TEXT NOT NULL,
  "fromStaff"      BOOLEAN NOT NULL,
  "senderId"       TEXT,
  "body"           TEXT NOT NULL,
  "mediaUrl"       TEXT,
  "seenAt"         TIMESTAMP(3),
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "supplier_messages_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "supplier_messages_conversationId_createdAt_idx"
  ON "supplier_messages"("conversationId","createdAt");
ALTER TABLE "supplier_messages" ADD CONSTRAINT "supplier_messages_conversationId_fkey"
  FOREIGN KEY ("conversationId") REFERENCES "supplier_conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "supplier_portal_tokens" (
  "id"         TEXT NOT NULL,
  "supplierId" TEXT NOT NULL,
  "token"      TEXT NOT NULL,
  "label"      TEXT,
  "expiresAt"  TIMESTAMP(3),
  "lastUsedAt" TIMESTAMP(3),
  "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "supplier_portal_tokens_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "supplier_portal_tokens_token_key" ON "supplier_portal_tokens"("token");
CREATE INDEX "supplier_portal_tokens_token_idx" ON "supplier_portal_tokens"("token");
ALTER TABLE "supplier_portal_tokens" ADD CONSTRAINT "supplier_portal_tokens_supplierId_fkey"
  FOREIGN KEY ("supplierId") REFERENCES "suppliers"("id") ON DELETE CASCADE ON UPDATE CASCADE;
