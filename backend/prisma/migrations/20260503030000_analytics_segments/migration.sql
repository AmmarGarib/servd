-- Analytics event type enum
CREATE TYPE "AnalyticsEventType" AS ENUM (
  'page_view', 'concept_view', 'item_view', 'item_added', 'item_removed',
  'cart_viewed', 'checkout_started', 'checkout_step', 'checkout_abandoned',
  'order_placed', 'search', 'filter_applied', 'concept_switched',
  'promo_applied', 'promo_failed'
);

-- Analytics events table
CREATE TABLE "analytics_events" (
  "id"         TEXT        NOT NULL DEFAULT gen_random_uuid()::text,
  "sessionId"  TEXT        NOT NULL,
  "customerId" TEXT,
  "conceptId"  TEXT,
  "event"      "AnalyticsEventType" NOT NULL,
  "properties" JSONB,
  "url"        TEXT,
  "referrer"   TEXT,
  "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "analytics_events_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "analytics_events_customerId_createdAt_idx" ON "analytics_events"("customerId", "createdAt");
CREATE INDEX "analytics_events_conceptId_event_createdAt_idx" ON "analytics_events"("conceptId", "event", "createdAt");
CREATE INDEX "analytics_events_event_createdAt_idx" ON "analytics_events"("event", "createdAt");
CREATE INDEX "analytics_events_sessionId_idx" ON "analytics_events"("sessionId");

ALTER TABLE "analytics_events"
  ADD CONSTRAINT "analytics_events_customerId_fkey"
  FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "analytics_events"
  ADD CONSTRAINT "analytics_events_conceptId_fkey"
  FOREIGN KEY ("conceptId") REFERENCES "concepts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Customer segments
CREATE TABLE "customer_segments" (
  "id"             TEXT         NOT NULL,
  "slug"           TEXT         NOT NULL,
  "name"           TEXT         NOT NULL,
  "description"    TEXT,
  "color"          TEXT         NOT NULL DEFAULT '#6366f1',
  "emoji"          TEXT         NOT NULL DEFAULT '👥',
  "memberCount"    INTEGER      NOT NULL DEFAULT 0,
  "lastComputedAt" TIMESTAMP(3),
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "customer_segments_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "customer_segments_slug_key" ON "customer_segments"("slug");

-- Segment memberships
CREATE TABLE "customer_segment_memberships" (
  "customerId" TEXT         NOT NULL,
  "segmentId"  TEXT         NOT NULL,
  "joinedAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "customer_segment_memberships_pkey" PRIMARY KEY ("customerId", "segmentId")
);

CREATE INDEX "customer_segment_memberships_segmentId_idx" ON "customer_segment_memberships"("segmentId");

ALTER TABLE "customer_segment_memberships"
  ADD CONSTRAINT "customer_segment_memberships_customerId_fkey"
  FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "customer_segment_memberships"
  ADD CONSTRAINT "customer_segment_memberships_segmentId_fkey"
  FOREIGN KEY ("segmentId") REFERENCES "customer_segments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Seed the 15 behavioral segments
INSERT INTO "customer_segments" ("id", "slug", "name", "description", "color", "emoji", "updatedAt") VALUES
  (gen_random_uuid()::text, 'weekend-warrior',  'Weekend Warriors',    'Order mostly on Fri/Sat/Sun',                   '#f59e0b', '🍻', NOW()),
  (gen_random_uuid()::text, 'lunch-regular',    'Lunch Regulars',      'Order primarily between 11am–3pm',              '#10b981', '🥗', NOW()),
  (gen_random_uuid()::text, 'late-night',       'Late Night Crew',     'Order after 10pm',                              '#8b5cf6', '🌙', NOW()),
  (gen_random_uuid()::text, 'promo-hunter',     'Promo Hunters',       'Over half their orders use a discount',         '#ef4444', '🏷️', NOW()),
  (gen_random_uuid()::text, 'high-value',       'High Rollers',        'Top spenders in the last 90 days',              '#f97316', '💎', NOW()),
  (gen_random_uuid()::text, 'lapsed-30',        'Lapsed (30 days)',    'No order in 30 days — used to order regularly', '#6b7280', '😴', NOW()),
  (gen_random_uuid()::text, 'lapsed-60',        'Lapsed (60 days)',    'No order in 60+ days — at risk of churning',    '#374151', '❄️', NOW()),
  (gen_random_uuid()::text, 'new-this-month',   'New This Month',      'First order was within the last 30 days',       '#06b6d4', '✨', NOW()),
  (gen_random_uuid()::text, 'loyal-regular',    'Loyal Regulars',      'Orders at least once a week',                   '#22c55e', '⭐', NOW()),
  (gen_random_uuid()::text, 'multi-brand',      'Brand Explorers',     'Ordered from 3+ different concepts',            '#0ea5e9', '🗺️', NOW()),
  (gen_random_uuid()::text, 'brand-loyalist',   'Brand Loyalists',     '80%+ of orders at a single concept',            '#d946ef', '🏆', NOW()),
  (gen_random_uuid()::text, 'premium',          'Premium Spenders',    'High AOV with no promo use',                    '#eab308', '👑', NOW()),
  (gen_random_uuid()::text, 'cart-abandoner',   'Cart Abandoners',     'Reached checkout but did not complete',         '#dc2626', '🛒', NOW()),
  (gen_random_uuid()::text, 'group-orderer',    'Group Orderers',      'Has placed group orders for others',            '#2563eb', '👨‍👩‍👧‍👦', NOW()),
  (gen_random_uuid()::text, 'impulse-buyer',    'Impulse Buyers',      'Places orders within an hour of browsing',      '#ec4899', '⚡', NOW());
