-- Cash vouchers (owner, 2026-10-13): GS Foods' internal cash payment voucher —
-- HOD signs, director signs, the cashier signs the paper and pays, and the
-- uploaded photo of the signed paper turns it into ONE petty-cash spend.
-- New tables only; nothing existing changes.
SET lock_timeout = '15s';

-- CreateEnum
CREATE TYPE "CashVoucherStatus" AS ENUM ('draft', 'hod_signed', 'approved', 'disbursed', 'rejected', 'cancelled');

-- CreateTable
CREATE TABLE "cash_vouchers" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "number" TEXT NOT NULL,
    "voucherDate" TIMESTAMP(3) NOT NULL,
    "payeeName" TEXT NOT NULL,
    "payeeUserId" TEXT,
    "purpose" TEXT NOT NULL,
    "category" TEXT,
    "conceptId" TEXT,
    "department" TEXT,
    "amountCents" INTEGER NOT NULL,
    "boxId" TEXT NOT NULL,
    "status" "CashVoucherStatus" NOT NULL DEFAULT 'draft',
    "preparedById" TEXT NOT NULL,
    "hodSignedById" TEXT,
    "hodSignedAt" TIMESTAMP(3),
    "directorSignedById" TEXT,
    "directorSignedAt" TIMESTAMP(3),
    "rejectedById" TEXT,
    "rejectedAt" TIMESTAMP(3),
    "rejectNote" TEXT,
    "cancelledById" TEXT,
    "cancelledAt" TIMESTAMP(3),
    "cancelNote" TEXT,
    "disbursedById" TEXT,
    "disbursedAt" TIMESTAMP(3),
    "cashierName" TEXT,
    "pettyCashMovementId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "cash_vouchers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cash_voucher_attachments" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "voucherId" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'signed_voucher',
    "mime" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "data" BYTEA NOT NULL,
    "uploadedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cash_voucher_attachments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "cash_vouchers_pettyCashMovementId_key" ON "cash_vouchers"("pettyCashMovementId");

-- CreateIndex
CREATE INDEX "cash_vouchers_tenantId_status_createdAt_idx" ON "cash_vouchers"("tenantId", "status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "cash_vouchers_tenantId_seq_key" ON "cash_vouchers"("tenantId", "seq");

-- CreateIndex
CREATE INDEX "cash_voucher_attachments_voucherId_idx" ON "cash_voucher_attachments"("voucherId");

-- CreateIndex
CREATE INDEX "cash_voucher_attachments_tenantId_idx" ON "cash_voucher_attachments"("tenantId");

-- AddForeignKey
ALTER TABLE "cash_vouchers" ADD CONSTRAINT "cash_vouchers_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cash_vouchers" ADD CONSTRAINT "cash_vouchers_boxId_fkey" FOREIGN KEY ("boxId") REFERENCES "petty_cash_boxes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cash_voucher_attachments" ADD CONSTRAINT "cash_voucher_attachments_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cash_voucher_attachments" ADD CONSTRAINT "cash_voucher_attachments_voucherId_fkey" FOREIGN KEY ("voucherId") REFERENCES "cash_vouchers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

