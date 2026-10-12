-- Pre-bills (2026-10-10, owner decision): every bill printed before payment is a
-- permanent, non-fiscal record (Finance -> Voided pre bills). Only the full &
-- final bill files with the fiscal POS. New tables only.

-- CreateEnum
CREATE TYPE "PreBillStatus" AS ENUM ('open', 'superseded', 'converted', 'cancelled');

-- CreateTable
CREATE TABLE "pre_bills" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "conceptId" TEXT NOT NULL,
    "locationId" TEXT,
    "orderId" TEXT NOT NULL,
    "shiftId" TEXT,
    "number" INTEGER NOT NULL,
    "tableLabel" TEXT,
    "printedById" TEXT NOT NULL,
    "printedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "tender" TEXT NOT NULL,
    "lines" JSONB NOT NULL,
    "subtotalCents" INTEGER NOT NULL,
    "discountCents" INTEGER NOT NULL,
    "serviceChargeCents" INTEGER NOT NULL,
    "taxCents" INTEGER NOT NULL,
    "totalCents" INTEGER NOT NULL,
    "cardTotalCents" INTEGER,
    "status" "PreBillStatus" NOT NULL DEFAULT 'open',
    "statusAt" TIMESTAMP(3),
    "finalTotalCents" INTEGER,
    "finalAt" TIMESTAMP(3),
    "cancelledById" TEXT,
    "cancelReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

CONSTRAINT "pre_bills_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pre_bill_counters" (
    "tenantId" TEXT NOT NULL,
    "next" INTEGER NOT NULL DEFAULT 1,

CONSTRAINT "pre_bill_counters_pkey" PRIMARY KEY ("tenantId")
);

-- CreateIndex
CREATE INDEX "pre_bills_tenantId_printedAt_idx" ON "pre_bills"("tenantId", "printedAt" DESC);

-- CreateIndex
CREATE INDEX "pre_bills_tenantId_status_idx" ON "pre_bills"("tenantId", "status");

-- CreateIndex
CREATE INDEX "pre_bills_orderId_idx" ON "pre_bills"("orderId");

-- CreateIndex
CREATE UNIQUE INDEX "pre_bills_tenantId_number_key" ON "pre_bills"("tenantId", "number");

-- AddForeignKey
ALTER TABLE "pre_bills" ADD CONSTRAINT "pre_bills_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pre_bills" ADD CONSTRAINT "pre_bills_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
