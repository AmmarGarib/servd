-- Add rejected to OrderStatus enum
ALTER TYPE "OrderStatus" ADD VALUE IF NOT EXISTS 'rejected';

-- Customer: wallet + blacklist
ALTER TABLE "customers"
  ADD COLUMN IF NOT EXISTS "walletBalance"   INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "isBlacklisted"   BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "blacklistReason" TEXT;

-- Order: promo + wallet + pre-order
ALTER TABLE "orders"
  ADD COLUMN IF NOT EXISTS "promoCodeId"        TEXT,
  ADD COLUMN IF NOT EXISTS "promoDiscountCents"  INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "walletAmountCents"   INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "scheduledFor"        TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "isPreOrder"          BOOLEAN NOT NULL DEFAULT false;

-- WalletTransaction
CREATE TABLE IF NOT EXISTS "wallet_transactions" (
  "id"           TEXT NOT NULL,
  "customerId"   TEXT NOT NULL,
  "type"         TEXT NOT NULL,
  "amountCents"  INTEGER NOT NULL,
  "balanceAfter" INTEGER NOT NULL,
  "description"  TEXT,
  "orderId"      TEXT,
  "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "wallet_transactions_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "wallet_transactions_customerId_createdAt_idx"
  ON "wallet_transactions"("customerId", "createdAt");
ALTER TABLE "wallet_transactions"
  ADD CONSTRAINT "wallet_transactions_customerId_fkey"
  FOREIGN KEY ("customerId") REFERENCES "customers"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- PromoCode
CREATE TABLE IF NOT EXISTS "promo_codes" (
  "id"               TEXT NOT NULL,
  "conceptId"        TEXT,
  "code"             TEXT NOT NULL,
  "description"      TEXT,
  "discountType"     TEXT NOT NULL DEFAULT 'percentage',
  "discountValue"    DOUBLE PRECISION NOT NULL,
  "minOrderCents"    INTEGER,
  "maxDiscountCents" INTEGER,
  "maxUsageCount"    INTEGER,
  "perCustomerLimit" INTEGER NOT NULL DEFAULT 1,
  "usedCount"        INTEGER NOT NULL DEFAULT 0,
  "channel"          TEXT NOT NULL DEFAULT 'both',
  "startAt"          TIMESTAMP(3) NOT NULL,
  "endAt"            TIMESTAMP(3) NOT NULL,
  "isActive"         BOOLEAN NOT NULL DEFAULT true,
  "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "promo_codes_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "promo_codes_code_key" ON "promo_codes"("code");

-- PromoCodeUsage
CREATE TABLE IF NOT EXISTS "promo_code_usages" (
  "id"            TEXT NOT NULL,
  "promoCodeId"   TEXT NOT NULL,
  "customerId"    TEXT,
  "orderId"       TEXT NOT NULL,
  "discountCents" INTEGER NOT NULL,
  "usedAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "promo_code_usages_pkey" PRIMARY KEY ("id")
);
ALTER TABLE "promo_code_usages"
  ADD CONSTRAINT "promo_code_usages_promoCodeId_fkey"
  FOREIGN KEY ("promoCodeId") REFERENCES "promo_codes"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "promo_code_usages"
  ADD CONSTRAINT "promo_code_usages_orderId_fkey"
  FOREIGN KEY ("orderId") REFERENCES "orders"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- FK: orders.promoCodeId → promo_codes.id
ALTER TABLE "orders"
  ADD CONSTRAINT "orders_promoCodeId_fkey"
  FOREIGN KEY ("promoCodeId") REFERENCES "promo_codes"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- SectionDiscount
CREATE TABLE IF NOT EXISTS "section_discounts" (
  "id"              TEXT NOT NULL,
  "conceptId"       TEXT,
  "categoryId"      TEXT,
  "discountPercent" DOUBLE PRECISION NOT NULL,
  "deliveryTypes"   TEXT[],
  "orderTypes"      TEXT[],
  "startDate"       TIMESTAMP(3) NOT NULL,
  "endDate"         TIMESTAMP(3) NOT NULL,
  "startTime"       TEXT NOT NULL,
  "endTime"         TEXT NOT NULL,
  "isActive"        BOOLEAN NOT NULL DEFAULT true,
  "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "section_discounts_pkey" PRIMARY KEY ("id")
);

-- AbandonedCart
CREATE TABLE IF NOT EXISTS "abandoned_carts" (
  "id"             TEXT NOT NULL,
  "cartId"         TEXT NOT NULL,
  "conceptId"      TEXT NOT NULL,
  "customerId"     TEXT,
  "customerPhone"  TEXT,
  "customerEmail"  TEXT,
  "items"          JSONB NOT NULL,
  "subtotalCents"  INTEGER NOT NULL,
  "abandonedAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "recoveredAt"    TIMESTAMP(3),
  "reminderSentAt" TIMESTAMP(3),
  CONSTRAINT "abandoned_carts_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "abandoned_carts_cartId_key" ON "abandoned_carts"("cartId");
CREATE INDEX IF NOT EXISTS "abandoned_carts_conceptId_abandonedAt_idx"
  ON "abandoned_carts"("conceptId", "abandonedAt");
ALTER TABLE "abandoned_carts"
  ADD CONSTRAINT "abandoned_carts_conceptId_fkey"
  FOREIGN KEY ("conceptId") REFERENCES "concepts"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- QrCode
CREATE TABLE IF NOT EXISTS "qr_codes" (
  "id"          TEXT NOT NULL,
  "conceptId"   TEXT NOT NULL,
  "tableId"     TEXT,
  "orderType"   TEXT NOT NULL DEFAULT 'dine-in',
  "label"       TEXT NOT NULL,
  "qrImageUrl"  TEXT,
  "scanCount"   INTEGER NOT NULL DEFAULT 0,
  "conversions" INTEGER NOT NULL DEFAULT 0,
  "isActive"    BOOLEAN NOT NULL DEFAULT true,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "qr_codes_pkey" PRIMARY KEY ("id")
);
ALTER TABLE "qr_codes"
  ADD CONSTRAINT "qr_codes_conceptId_fkey"
  FOREIGN KEY ("conceptId") REFERENCES "concepts"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
