-- Payment reference # on every back-office money-in screen, and a deposit
-- slip number on bank deposit drops (owner, 2026-10-14). Nullable TEXT
-- columns only: no enum change, no backfill (older rows keep NULL).
ALTER TABLE "gift_cards" ADD COLUMN IF NOT EXISTS "paymentRef" TEXT;
ALTER TABLE "wallet_transactions" ADD COLUMN IF NOT EXISTS "method" TEXT;
ALTER TABLE "wallet_transactions" ADD COLUMN IF NOT EXISTS "paymentRef" TEXT;
ALTER TABLE "capex_payments" ADD COLUMN IF NOT EXISTS "depositReturnRef" TEXT;
ALTER TABLE "deposit_drops" ADD COLUMN IF NOT EXISTS "slipNumber" TEXT;
