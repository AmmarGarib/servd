-- Rider live location, check splitting, tip pools, group orders.

-- Rider columns
ALTER TABLE "riders" ADD COLUMN "lastLat"        DOUBLE PRECISION;
ALTER TABLE "riders" ADD COLUMN "lastLng"        DOUBLE PRECISION;
ALTER TABLE "riders" ADD COLUMN "lastHeading"    DOUBLE PRECISION;
ALTER TABLE "riders" ADD COLUMN "lastAccuracy"   DOUBLE PRECISION;
ALTER TABLE "riders" ADD COLUMN "lastReportedAt" TIMESTAMP(3);

CREATE TABLE "rider_locations" (
  "id"         TEXT          NOT NULL,
  "riderId"    TEXT          NOT NULL,
  "orderId"    TEXT,
  "lat"        DOUBLE PRECISION NOT NULL,
  "lng"        DOUBLE PRECISION NOT NULL,
  "heading"    DOUBLE PRECISION,
  "accuracy"   DOUBLE PRECISION,
  "speedMps"   DOUBLE PRECISION,
  "recordedAt" TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "rider_locations_pkey"   PRIMARY KEY ("id"),
  CONSTRAINT "rider_locations_riderFk" FOREIGN KEY ("riderId") REFERENCES "riders"("id") ON DELETE CASCADE
);
CREATE INDEX "rider_locations_rider_recordedAt_idx" ON "rider_locations" ("riderId", "recordedAt" DESC);
CREATE INDEX "rider_locations_order_recordedAt_idx" ON "rider_locations" ("orderId", "recordedAt" DESC);

-- Check splitting
ALTER TABLE "payments" ADD COLUMN "splitGroup" INTEGER;
ALTER TABLE "payments" ADD COLUMN "splitLabel" TEXT;

-- Tip pools
CREATE TYPE "TipPoolStatus" AS ENUM ('draft', 'posted', 'paid');

CREATE TABLE "tip_pools" (
  "id"             TEXT             NOT NULL,
  "conceptId"      TEXT,
  "name"           TEXT             NOT NULL,
  "periodStart"    TIMESTAMP(3)     NOT NULL,
  "periodEnd"      TIMESTAMP(3)     NOT NULL,
  "totalTipsCents" INTEGER          NOT NULL DEFAULT 0,
  "status"         "TipPoolStatus"  NOT NULL DEFAULT 'draft',
  "postedAt"       TIMESTAMP(3),
  "paidAt"         TIMESTAMP(3),
  "createdById"    TEXT,
  "createdAt"      TIMESTAMP(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"      TIMESTAMP(3)     NOT NULL,
  CONSTRAINT "tip_pools_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "tip_pools_periodStart_idx" ON "tip_pools" ("periodStart" DESC);

CREATE TABLE "tip_pool_members" (
  "id"          TEXT             NOT NULL,
  "poolId"      TEXT             NOT NULL,
  "userId"      TEXT             NOT NULL,
  "userName"    TEXT             NOT NULL,
  "hoursWorked" DOUBLE PRECISION NOT NULL,
  "roleWeight"  DOUBLE PRECISION NOT NULL DEFAULT 1.0,
  "shareUnits"  DOUBLE PRECISION NOT NULL,
  "shareCents"  INTEGER          NOT NULL DEFAULT 0,
  "notes"       TEXT,
  CONSTRAINT "tip_pool_members_pkey"   PRIMARY KEY ("id"),
  CONSTRAINT "tip_pool_members_poolFk" FOREIGN KEY ("poolId") REFERENCES "tip_pools"("id") ON DELETE CASCADE,
  CONSTRAINT "tip_pool_members_userFk" FOREIGN KEY ("userId") REFERENCES "users"("id")    ON DELETE NO ACTION
);
CREATE UNIQUE INDEX "tip_pool_members_pool_user_key" ON "tip_pool_members" ("poolId", "userId");
CREATE INDEX "tip_pool_members_userId_idx"           ON "tip_pool_members" ("userId");

-- Group orders
CREATE TYPE "GroupOrderStatus" AS ENUM ('open', 'locked', 'submitted', 'cancelled');

CREATE TABLE "group_orders" (
  "id"                  TEXT               NOT NULL,
  "conceptId"           TEXT               NOT NULL,
  "initiatorCustomerId" TEXT,
  "initiatorName"       TEXT               NOT NULL,
  "shareCode"           TEXT               NOT NULL,
  "status"              "GroupOrderStatus" NOT NULL DEFAULT 'open',
  "closingAt"           TIMESTAMP(3),
  "orderId"             TEXT,
  "createdAt"           TIMESTAMP(3)       NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"           TIMESTAMP(3)       NOT NULL,
  CONSTRAINT "group_orders_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "group_orders_shareCode_key" ON "group_orders" ("shareCode");

CREATE TABLE "group_order_members" (
  "id"           TEXT          NOT NULL,
  "groupOrderId" TEXT          NOT NULL,
  "customerId"   TEXT,
  "displayName"  TEXT          NOT NULL,
  "joinedAt"     TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "group_order_members_pkey"     PRIMARY KEY ("id"),
  CONSTRAINT "group_order_members_groupFk"  FOREIGN KEY ("groupOrderId") REFERENCES "group_orders"("id") ON DELETE CASCADE
);
CREATE UNIQUE INDEX "group_order_members_groupOrder_displayName_key"
  ON "group_order_members" ("groupOrderId", "displayName");

CREATE TABLE "group_order_items" (
  "id"             TEXT          NOT NULL,
  "groupOrderId"   TEXT          NOT NULL,
  "memberId"       TEXT          NOT NULL,
  "menuItemId"     TEXT          NOT NULL,
  "name"           TEXT          NOT NULL,
  "quantity"       INTEGER       NOT NULL DEFAULT 1,
  "unitPriceCents" INTEGER       NOT NULL,
  "notes"          TEXT,
  "createdAt"      TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "group_order_items_pkey"      PRIMARY KEY ("id"),
  CONSTRAINT "group_order_items_groupFk"   FOREIGN KEY ("groupOrderId") REFERENCES "group_orders"("id")        ON DELETE CASCADE,
  CONSTRAINT "group_order_items_memberFk"  FOREIGN KEY ("memberId")     REFERENCES "group_order_members"("id") ON DELETE CASCADE
);
CREATE INDEX "group_order_items_group_idx" ON "group_order_items" ("groupOrderId");
