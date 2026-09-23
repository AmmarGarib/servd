-- Base layers for three modules that had nothing built: fixed assets,
-- receivables and food safety.

CREATE TABLE "fixed_assets" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "conceptId" TEXT,
    "locationId" TEXT,
    "name" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "assetTag" TEXT,
    "serialNumber" TEXT,
    "supplier" TEXT,
    "acquiredAt" TIMESTAMP(3) NOT NULL,
    "costCents" INTEGER NOT NULL,
    "salvageCents" INTEGER NOT NULL DEFAULT 0,
    "usefulLifeMonths" INTEGER NOT NULL,
    "acquisitionCreditCode" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "disposedAt" TIMESTAMP(3),
    "disposalProceedsCents" INTEGER,
    "notes" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "fixed_assets_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "fixed_asset_depreciation" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "period" TEXT NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "postedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "fixed_asset_depreciation_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "receivable_invoices" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "conceptId" TEXT,
    "number" TEXT NOT NULL,
    "customerName" TEXT NOT NULL,
    "customerEmail" TEXT,
    "customerPhone" TEXT,
    "customerNtn" TEXT,
    "customerId" TEXT,
    "issueDate" TIMESTAMP(3) NOT NULL,
    "dueDate" TIMESTAMP(3) NOT NULL,
    "description" TEXT NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "taxCents" INTEGER NOT NULL DEFAULT 0,
    "paidCents" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'open',
    "revenueAccountCode" TEXT NOT NULL DEFAULT '4090',
    "notes" TEXT,
    "createdById" TEXT,
    "voidedAt" TIMESTAMP(3),
    "voidReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "receivable_invoices_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "receivable_payments" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL,
    "method" TEXT NOT NULL,
    "reference" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "receivable_payments_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "food_safety_units" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "locationId" TEXT,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "minC" DOUBLE PRECISION,
    "maxC" DOUBLE PRECISION,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "food_safety_units_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "temperature_logs" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "unitId" TEXT NOT NULL,
    "readingC" DOUBLE PRECISION NOT NULL,
    "withinRange" BOOLEAN NOT NULL,
    "correctiveAction" TEXT,
    "note" TEXT,
    "takenById" TEXT,
    "takenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "temperature_logs_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "cleaning_tasks" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "locationId" TEXT,
    "name" TEXT NOT NULL,
    "area" TEXT,
    "frequency" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cleaning_tasks_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "cleaning_logs" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "doneById" TEXT,
    "doneAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "note" TEXT,

    CONSTRAINT "cleaning_logs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "fixed_assets_tenantId_status_idx" ON "fixed_assets"("tenantId", "status");

CREATE INDEX "fixed_asset_depreciation_tenantId_period_idx" ON "fixed_asset_depreciation"("tenantId", "period");

CREATE UNIQUE INDEX "fixed_asset_depreciation_assetId_period_key" ON "fixed_asset_depreciation"("assetId", "period");

CREATE INDEX "receivable_invoices_tenantId_status_dueDate_idx" ON "receivable_invoices"("tenantId", "status", "dueDate");

CREATE UNIQUE INDEX "receivable_invoices_tenantId_number_key" ON "receivable_invoices"("tenantId", "number");

CREATE INDEX "receivable_payments_invoiceId_idx" ON "receivable_payments"("invoiceId");

CREATE INDEX "food_safety_units_tenantId_isActive_idx" ON "food_safety_units"("tenantId", "isActive");

CREATE INDEX "temperature_logs_tenantId_takenAt_idx" ON "temperature_logs"("tenantId", "takenAt");

CREATE INDEX "temperature_logs_unitId_takenAt_idx" ON "temperature_logs"("unitId", "takenAt");

CREATE INDEX "cleaning_tasks_tenantId_isActive_idx" ON "cleaning_tasks"("tenantId", "isActive");

CREATE INDEX "cleaning_logs_taskId_doneAt_idx" ON "cleaning_logs"("taskId", "doneAt");

ALTER TABLE "fixed_asset_depreciation" ADD CONSTRAINT "fixed_asset_depreciation_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "fixed_assets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "receivable_payments" ADD CONSTRAINT "receivable_payments_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "receivable_invoices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "temperature_logs" ADD CONSTRAINT "temperature_logs_unitId_fkey" FOREIGN KEY ("unitId") REFERENCES "food_safety_units"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "cleaning_logs" ADD CONSTRAINT "cleaning_logs_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "cleaning_tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;
