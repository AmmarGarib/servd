-- Raast QR tender + bank-SMS matching (2026-10-12, owner decisions; spec
-- .handoff/fixes/raast-spec.md). New tables and nullable / defaulted columns
-- only: nothing existing is dropped, renamed or rewritten, and no rows are
-- backfilled (no Raast data exists yet).
--
--   raast_receipts    one row per Raast tender; 'provisional' until a bank
--                     statement line matches it. Company = the order's brand's.
--   bank_sms_devices  counter phones that forward bank SMS (token: sha256
--                     lookup hash + secretBox ciphertext).
--   bank_sms_alerts   listed bank senders' SMS only (OTPs are never stored).
--   bank_accounts     + raastId, raastDefault (one default per company).
--   concepts          + raastBankAccountId (a brand's own receiving account).
--
-- Money: per-ticket amounts are INT4 like payments; an SMS credit is BIGINT
-- like bank_statement_lines (20261012140000_money_bigint).
-- entrypoint.sh runs this before the API boots; the lock timeout makes a
-- stuck lock fail fast instead of hanging the deploy.
SET lock_timeout = '15s';

-- CreateEnum
CREATE TYPE "RaastReceiptStatus" AS ENUM ('awaiting', 'provisional', 'matched', 'cancelled', 'unreceived', 'needs_attention');

-- CreateEnum
CREATE TYPE "RaastConfirmedVia" AS ENUM ('cashier', 'sms', 'bank_api');

-- CreateEnum
CREATE TYPE "BankSmsAlertStatus" AS ENUM ('received', 'processing', 'unparsed', 'off', 'debit', 'duplicate', 'matched', 'confirmed', 'unmatched', 'ambiguous', 'needs_attention', 'attached', 'dismissed');

-- AlterTable
ALTER TABLE "concepts" ADD COLUMN     "raastBankAccountId" TEXT;

-- AlterTable
ALTER TABLE "bank_accounts" ADD COLUMN     "raastDefault" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "raastId" TEXT;

-- CreateTable
CREATE TABLE "raast_receipts" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "conceptId" TEXT NOT NULL,
    "shiftId" TEXT,
    "targetPaymentId" TEXT,
    "paymentId" TEXT,
    "bankAccountId" TEXT NOT NULL,
    "ledgerCode" TEXT NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "tipCents" INTEGER NOT NULL DEFAULT 0,
    "dueCents" INTEGER NOT NULL,
    "bankRef" TEXT,
    "bankRefRaw" TEXT,
    "status" "RaastReceiptStatus" NOT NULL DEFAULT 'awaiting',
    "confirmedVia" "RaastConfirmedVia",
    "confirmedAt" TIMESTAMP(3),
    "confirmedById" TEXT,
    "cashierVerified" BOOLEAN NOT NULL DEFAULT false,
    "smsAlertId" TEXT,
    "smsConfirmedAt" TIMESTAMP(3),
    "settlingUntil" TIMESTAMP(3),
    "statementLineId" TEXT,
    "matchedAt" TIMESTAMP(3),
    "matchedById" TEXT,
    "expiresAt" TIMESTAMP(3),
    "cancelReason" TEXT,
    "attentionReason" TEXT,
    "flaggedAt" TIMESTAMP(3),
    "writeOffEntryId" TEXT,
    "idempotencyKey" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "raast_receipts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bank_sms_devices" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "connectorId" TEXT NOT NULL,
    "locationId" TEXT,
    "label" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "tokenEnc" TEXT NOT NULL,
    "tokenHint" TEXT NOT NULL,
    "allowPathToken" BOOLEAN NOT NULL DEFAULT false,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "lastSeenAt" TIMESTAMP(3),
    "lastSmsAt" TIMESTAMP(3),
    "ignoredCount" INTEGER NOT NULL DEFAULT 0,
    "lastIgnoredAt" TIMESTAMP(3),
    "rotatedAt" TIMESTAMP(3),
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "bank_sms_devices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bank_sms_alerts" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "locationId" TEXT,
    "sender" TEXT NOT NULL,
    "bodyHash" TEXT NOT NULL,
    "body" TEXT,
    "receivedAt" TIMESTAMP(3) NOT NULL,
    "templateId" TEXT,
    "kind" TEXT,
    "amountCents" BIGINT,
    "bankRef" TEXT,
    "occurredAt" TIMESTAMP(3),
    "payer" TEXT,
    "accountLast4" TEXT,
    "bankAccountId" TEXT,
    "status" "BankSmsAlertStatus" NOT NULL DEFAULT 'received',
    "candidateIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "processedAt" TIMESTAMP(3),
    "resolvedById" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "resolution" TEXT,
    "claimedRef" TEXT,
    "alertedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "bank_sms_alerts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "raast_receipts_paymentId_key" ON "raast_receipts"("paymentId");

-- CreateIndex
CREATE UNIQUE INDEX "raast_receipts_smsAlertId_key" ON "raast_receipts"("smsAlertId");

-- CreateIndex
CREATE UNIQUE INDEX "raast_receipts_statementLineId_key" ON "raast_receipts"("statementLineId");

-- CreateIndex
CREATE INDEX "raast_receipts_tenantId_status_createdAt_idx" ON "raast_receipts"("tenantId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "raast_receipts_tenantId_bankAccountId_status_amountCents_idx" ON "raast_receipts"("tenantId", "bankAccountId", "status", "amountCents");

-- CreateIndex
CREATE INDEX "raast_receipts_orderId_idx" ON "raast_receipts"("orderId");

-- CreateIndex
CREATE INDEX "raast_receipts_shiftId_status_idx" ON "raast_receipts"("shiftId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "raast_receipts_tenantId_bankRef_key" ON "raast_receipts"("tenantId", "bankRef");

-- CreateIndex
CREATE UNIQUE INDEX "raast_receipts_tenantId_idempotencyKey_key" ON "raast_receipts"("tenantId", "idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "bank_sms_devices_tokenHash_key" ON "bank_sms_devices"("tokenHash");

-- CreateIndex
CREATE INDEX "bank_sms_devices_tenantId_idx" ON "bank_sms_devices"("tenantId");

-- CreateIndex
CREATE INDEX "bank_sms_alerts_tenantId_status_receivedAt_idx" ON "bank_sms_alerts"("tenantId", "status", "receivedAt");

-- CreateIndex
CREATE INDEX "bank_sms_alerts_tenantId_bankRef_idx" ON "bank_sms_alerts"("tenantId", "bankRef");

-- CreateIndex
CREATE INDEX "bank_sms_alerts_status_createdAt_idx" ON "bank_sms_alerts"("status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "bank_sms_alerts_tenantId_bodyHash_key" ON "bank_sms_alerts"("tenantId", "bodyHash");

-- CreateIndex
CREATE UNIQUE INDEX "bank_sms_alerts_tenantId_claimedRef_key" ON "bank_sms_alerts"("tenantId", "claimedRef");

-- AddForeignKey
ALTER TABLE "concepts" ADD CONSTRAINT "concepts_raastBankAccountId_fkey" FOREIGN KEY ("raastBankAccountId") REFERENCES "bank_accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "raast_receipts" ADD CONSTRAINT "raast_receipts_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "raast_receipts" ADD CONSTRAINT "raast_receipts_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "raast_receipts" ADD CONSTRAINT "raast_receipts_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "payments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "raast_receipts" ADD CONSTRAINT "raast_receipts_bankAccountId_fkey" FOREIGN KEY ("bankAccountId") REFERENCES "bank_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "raast_receipts" ADD CONSTRAINT "raast_receipts_smsAlertId_fkey" FOREIGN KEY ("smsAlertId") REFERENCES "bank_sms_alerts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "raast_receipts" ADD CONSTRAINT "raast_receipts_statementLineId_fkey" FOREIGN KEY ("statementLineId") REFERENCES "bank_statement_lines"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bank_sms_devices" ADD CONSTRAINT "bank_sms_devices_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bank_sms_devices" ADD CONSTRAINT "bank_sms_devices_connectorId_fkey" FOREIGN KEY ("connectorId") REFERENCES "pos_connectors"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bank_sms_alerts" ADD CONSTRAINT "bank_sms_alerts_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bank_sms_alerts" ADD CONSTRAINT "bank_sms_alerts_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "bank_sms_devices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- One awaiting Raast intent per order, and one default receiving account per
-- company. Partial unique indexes (Prisma can't express them; tests/setup.ts
-- re-creates both after db push).
CREATE UNIQUE INDEX IF NOT EXISTS "raast_receipts_one_awaiting_per_order" ON "raast_receipts" ("orderId") WHERE "status" = 'awaiting';
CREATE UNIQUE INDEX IF NOT EXISTS "bank_accounts_one_raast_default_per_company" ON "bank_accounts" ("tenantId") WHERE "raastDefault" = true AND "deletedAt" IS NULL;
