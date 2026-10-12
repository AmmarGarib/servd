-- POS connector (2026-10-10, owner decision): servd files FBR/SRB ONLY through the
-- external fiscal POS (fiscal outbox) and charges cards on the processor's card
-- machine. New tables only; nothing existing is dropped, renamed or nulled
-- (Order.fbr*/srb* and Concept.fbrPosId/srbPosId stay). No rows are seeded.

-- CreateEnum
CREATE TYPE "ConnectorKind" AS ENUM ('fiscal', 'terminal');

-- CreateEnum
CREATE TYPE "FiscalDocKind" AS ENUM ('sale', 'refund');

-- CreateEnum
CREATE TYPE "FiscalDocStatus" AS ENUM ('held', 'waiting', 'pending', 'submitting', 'filed', 'rejected', 'failed', 'skipped', 'manual_required', 'manual_filed');

-- CreateEnum
CREATE TYPE "TerminalChargeKind" AS ENUM ('charge', 'refund');

-- CreateEnum
CREATE TYPE "TerminalChargeStatus" AS ENUM ('pending', 'sent', 'approved', 'recorded', 'declined', 'cancel_requested', 'cancelled', 'expired', 'unknown', 'unverified', 'void_pending', 'voided', 'needs_attention', 'manual_resolved');

-- CreateTable
CREATE TABLE "pos_connectors" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "kind" "ConnectorKind" NOT NULL,
    "driver" TEXT NOT NULL DEFAULT 'none',
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "liveSince" TIMESTAMP(3),
    "baseUrl" TEXT,
    "apiKeyEnc" TEXT,
    "apiKeyHint" TEXT,
    "webhookSecretEnc" TEXT,
    "webhookSecretHint" TEXT,
    "webhookToken" TEXT NOT NULL,
    "settings" JSONB NOT NULL DEFAULT '{}',
    "lastTestAt" TIMESTAMP(3),
    "lastTestOk" BOOLEAN,
    "lastTestDetail" TEXT,
    "lastOkAt" TIMESTAMP(3),
    "lastError" TEXT,
    "lastErrorAt" TIMESTAMP(3),
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

CONSTRAINT "pos_connectors_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fiscal_documents" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "kind" "FiscalDocKind" NOT NULL,
    "orderId" TEXT NOT NULL,
    "conceptId" TEXT NOT NULL,
    "locationId" TEXT,
    "idempotencyKey" TEXT NOT NULL,
    "saleDocumentId" TEXT,
    "refundPaymentId" TEXT,
    "status" "FiscalDocStatus" NOT NULL DEFAULT 'pending',
    "statusReason" TEXT,
    "driver" TEXT,
    "payload" JSONB NOT NULL,
    "payloadHash" TEXT NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "leaseUntil" TIMESTAMP(3),
    "leaseOwner" TEXT,
    "lastErrorCode" TEXT,
    "lastError" TEXT,
    "fiscalNumber" TEXT,
    "authority" TEXT,
    "qrPayload" TEXT,
    "verifyUrl" TEXT,
    "extraNumbers" JSONB,
    "providerRef" TEXT,
    "fiscalAt" TIMESTAMP(3),
    "filedAt" TIMESTAMP(3),
    "isTest" BOOLEAN NOT NULL DEFAULT false,
    "alertedAt" TIMESTAMP(3),
    "resolvedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

CONSTRAINT "fiscal_documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fiscal_attempts" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "attemptNo" INTEGER NOT NULL,
    "op" TEXT NOT NULL,
    "outcome" TEXT NOT NULL,
    "httpStatus" INTEGER,
    "errorCode" TEXT,
    "message" TEXT,
    "durationMs" INTEGER NOT NULL,
    "via" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

CONSTRAINT "fiscal_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "terminal_charges" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "kind" "TerminalChargeKind" NOT NULL DEFAULT 'charge',
    "connectorId" TEXT NOT NULL,
    "terminalId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "shiftId" TEXT,
    "targetPaymentId" TEXT,
    "paymentId" TEXT,
    "originalChargeId" TEXT,
    "amountCents" INTEGER NOT NULL,
    "tipCents" INTEGER NOT NULL DEFAULT 0,
    "quoteDueCents" INTEGER NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "status" "TerminalChargeStatus" NOT NULL DEFAULT 'pending',
    "providerRef" TEXT,
    "approvalRef" TEXT,
    "authCode" TEXT,
    "cardBrand" TEXT,
    "cardLast4" TEXT,
    "message" TEXT,
    "refusalCode" TEXT,
    "manualReason" TEXT,
    "vendorMeta" JSONB,
    "reverseAttempts" INTEGER NOT NULL DEFAULT 0,
    "nextActionAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "lastPolledAt" TIMESTAMP(3),
    "pollLeaseUntil" TIMESTAMP(3),
    "resolvedAt" TIMESTAMP(3),
    "alertedAt" TIMESTAMP(3),
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

CONSTRAINT "terminal_charges_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "pos_connectors_webhookToken_key" ON "pos_connectors"("webhookToken");

-- CreateIndex
CREATE INDEX "pos_connectors_tenantId_idx" ON "pos_connectors"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "pos_connectors_tenantId_kind_key" ON "pos_connectors"("tenantId", "kind");

-- CreateIndex
CREATE INDEX "fiscal_documents_tenantId_status_nextAttemptAt_idx" ON "fiscal_documents"("tenantId", "status", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "fiscal_documents_status_nextAttemptAt_idx" ON "fiscal_documents"("status", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "fiscal_documents_status_leaseUntil_idx" ON "fiscal_documents"("status", "leaseUntil");

-- CreateIndex
CREATE INDEX "fiscal_documents_orderId_idx" ON "fiscal_documents"("orderId");

-- CreateIndex
CREATE INDEX "fiscal_documents_saleDocumentId_idx" ON "fiscal_documents"("saleDocumentId");

-- CreateIndex
CREATE INDEX "fiscal_documents_tenantId_createdAt_idx" ON "fiscal_documents"("tenantId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "fiscal_documents_tenantId_fiscalNumber_idx" ON "fiscal_documents"("tenantId", "fiscalNumber");

-- CreateIndex
CREATE UNIQUE INDEX "fiscal_documents_tenantId_idempotencyKey_key" ON "fiscal_documents"("tenantId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "fiscal_attempts_tenantId_createdAt_idx" ON "fiscal_attempts"("tenantId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "fiscal_attempts_documentId_idx" ON "fiscal_attempts"("documentId");

-- CreateIndex
CREATE UNIQUE INDEX "terminal_charges_paymentId_key" ON "terminal_charges"("paymentId");

-- CreateIndex
CREATE INDEX "terminal_charges_tenantId_status_updatedAt_idx" ON "terminal_charges"("tenantId", "status", "updatedAt");

-- CreateIndex
CREATE INDEX "terminal_charges_status_nextActionAt_idx" ON "terminal_charges"("status", "nextActionAt");

-- CreateIndex
CREATE INDEX "terminal_charges_orderId_idx" ON "terminal_charges"("orderId");

-- CreateIndex
CREATE INDEX "terminal_charges_shiftId_status_idx" ON "terminal_charges"("shiftId", "status");

-- CreateIndex
CREATE INDEX "terminal_charges_connectorId_providerRef_idx" ON "terminal_charges"("connectorId", "providerRef");

-- CreateIndex
CREATE UNIQUE INDEX "terminal_charges_tenantId_idempotencyKey_key" ON "terminal_charges"("tenantId", "idempotencyKey");

-- AddForeignKey
ALTER TABLE "pos_connectors" ADD CONSTRAINT "pos_connectors_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fiscal_documents" ADD CONSTRAINT "fiscal_documents_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fiscal_documents" ADD CONSTRAINT "fiscal_documents_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fiscal_attempts" ADD CONSTRAINT "fiscal_attempts_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "fiscal_documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "terminal_charges" ADD CONSTRAINT "terminal_charges_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "terminal_charges" ADD CONSTRAINT "terminal_charges_connectorId_fkey" FOREIGN KEY ("connectorId") REFERENCES "pos_connectors"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "terminal_charges" ADD CONSTRAINT "terminal_charges_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- At most one live charge per order on the card machine (spec D11).
CREATE UNIQUE INDEX "terminal_charges_one_active_per_order" ON "terminal_charges" ("orderId")
  WHERE "kind" = 'charge' AND "status" IN ('pending','sent','approved','cancel_requested','unknown');
