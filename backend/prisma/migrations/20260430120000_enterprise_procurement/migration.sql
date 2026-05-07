-- Enterprise procurement: bills, payments, 3-way matching, approvals, price history, variance log, audit trail.

-- ── Supplier extensions ──────────────────────────────────────────────────────
ALTER TABLE "suppliers"
  ADD COLUMN "paymentTermsDays"    INTEGER NOT NULL DEFAULT 30,
  ADD COLUMN "leadTimeDays"        INTEGER,
  ADD COLUMN "openingBalanceCents" INTEGER NOT NULL DEFAULT 0;

-- ── Purchase Order extensions ────────────────────────────────────────────────
ALTER TABLE "purchase_orders"
  ADD COLUMN "approvedById"   TEXT,
  ADD COLUMN "approvedAt"     TIMESTAMP(3),
  ADD COLUMN "rejectedReason" TEXT,
  ADD COLUMN "sentAt"         TIMESTAMP(3),
  ADD COLUMN "sentToEmail"    TEXT,
  ADD COLUMN "cancelledById"  TEXT,
  ADD COLUMN "cancelledAt"    TIMESTAMP(3),
  ADD COLUMN "cancelReason"   TEXT;

CREATE INDEX IF NOT EXISTS "purchase_orders_supplierId_status_idx"   ON "purchase_orders" ("supplierId", "status");
CREATE INDEX IF NOT EXISTS "purchase_orders_status_orderDate_idx"    ON "purchase_orders" ("status", "orderDate" DESC);

-- ── Purchase Order Line indexes ──────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS "purchase_order_lines_purchaseOrderId_idx" ON "purchase_order_lines" ("purchaseOrderId");
CREATE INDEX IF NOT EXISTS "purchase_order_lines_inventoryItemId_idx" ON "purchase_order_lines" ("inventoryItemId");

-- ── PO Activity Log (audit trail) ────────────────────────────────────────────
CREATE TABLE "po_activity_log" (
  "id"              TEXT NOT NULL,
  "purchaseOrderId" TEXT NOT NULL,
  "userId"          TEXT,
  "action"          TEXT NOT NULL,
  "details"         JSONB,
  "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "po_activity_log_pkey"           PRIMARY KEY ("id"),
  CONSTRAINT "po_activity_log_purchaseOrderId_fkey" FOREIGN KEY ("purchaseOrderId") REFERENCES "purchase_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "po_activity_log_userId_fkey"          FOREIGN KEY ("userId")          REFERENCES "users"("id")           ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE INDEX "po_activity_log_purchaseOrderId_createdAt_idx" ON "po_activity_log" ("purchaseOrderId", "createdAt");

-- ── Receiving Discrepancy (variance log) ─────────────────────────────────────
CREATE TABLE "receiving_discrepancies" (
  "id"           TEXT NOT NULL,
  "poLineId"     TEXT NOT NULL,
  "expectedQty"  DOUBLE PRECISION NOT NULL,
  "receivedQty"  DOUBLE PRECISION NOT NULL,
  "reason"       TEXT NOT NULL,
  "notes"        TEXT,
  "recordedById" TEXT,
  "recordedAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "receiving_discrepancies_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "receiving_discrepancies_poLineId_fkey"     FOREIGN KEY ("poLineId")     REFERENCES "purchase_order_lines"("id") ON DELETE CASCADE  ON UPDATE CASCADE,
  CONSTRAINT "receiving_discrepancies_recordedById_fkey" FOREIGN KEY ("recordedById") REFERENCES "users"("id")                ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE INDEX "receiving_discrepancies_poLineId_idx" ON "receiving_discrepancies" ("poLineId");

-- ── Item Price History ───────────────────────────────────────────────────────
CREATE TABLE "item_price_history" (
  "id"              TEXT NOT NULL,
  "inventoryItemId" TEXT NOT NULL,
  "supplierId"      TEXT,
  "oldCostCents"    INTEGER,
  "newCostCents"    INTEGER NOT NULL,
  "source"          TEXT NOT NULL,
  "poLineId"        TEXT,
  "recordedAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "item_price_history_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "item_price_history_inventoryItemId_fkey" FOREIGN KEY ("inventoryItemId") REFERENCES "inventory_items"("id")     ON DELETE CASCADE  ON UPDATE CASCADE,
  CONSTRAINT "item_price_history_supplierId_fkey"      FOREIGN KEY ("supplierId")      REFERENCES "suppliers"("id")           ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "item_price_history_poLineId_fkey"        FOREIGN KEY ("poLineId")        REFERENCES "purchase_order_lines"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE INDEX "item_price_history_inventoryItemId_recordedAt_idx" ON "item_price_history" ("inventoryItemId", "recordedAt" DESC);
CREATE INDEX "item_price_history_supplierId_recordedAt_idx"      ON "item_price_history" ("supplierId",      "recordedAt" DESC);

-- ── Supplier Bills (Accounts Payable) ────────────────────────────────────────
CREATE TABLE "supplier_bills" (
  "id"             TEXT NOT NULL,
  "supplierId"     TEXT NOT NULL,
  "poId"           TEXT,
  "billNumber"     TEXT NOT NULL,
  "billDate"       TIMESTAMP(3) NOT NULL,
  "dueDate"        TIMESTAMP(3) NOT NULL,
  "status"         TEXT NOT NULL DEFAULT 'open',
  "subtotalCents"  INTEGER NOT NULL DEFAULT 0,
  "taxCents"       INTEGER NOT NULL DEFAULT 0,
  "totalCents"     INTEGER NOT NULL DEFAULT 0,
  "paidCents"      INTEGER NOT NULL DEFAULT 0,
  "notes"          TEXT,
  "attachmentUrl"  TEXT,
  "createdBy"      TEXT,
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"      TIMESTAMP(3) NOT NULL,
  "voidedAt"       TIMESTAMP(3),
  "voidReason"     TEXT,
  CONSTRAINT "supplier_bills_pkey"            PRIMARY KEY ("id"),
  CONSTRAINT "supplier_bills_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "suppliers"("id")        ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "supplier_bills_poId_fkey"       FOREIGN KEY ("poId")       REFERENCES "purchase_orders"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "supplier_bills_supplierId_billNumber_key" ON "supplier_bills" ("supplierId", "billNumber");
CREATE INDEX        "supplier_bills_supplierId_status_idx"     ON "supplier_bills" ("supplierId", "status");
CREATE INDEX        "supplier_bills_dueDate_status_idx"        ON "supplier_bills" ("dueDate",    "status");

CREATE TABLE "supplier_bill_lines" (
  "id"              TEXT NOT NULL,
  "billId"          TEXT NOT NULL,
  "inventoryItemId" TEXT,
  "poLineId"        TEXT,
  "description"     TEXT NOT NULL,
  "quantity"        DOUBLE PRECISION NOT NULL,
  "unitCostCents"   INTEGER NOT NULL,
  "lineTotalCents"  INTEGER NOT NULL,
  CONSTRAINT "supplier_bill_lines_pkey"                 PRIMARY KEY ("id"),
  CONSTRAINT "supplier_bill_lines_billId_fkey"          FOREIGN KEY ("billId")          REFERENCES "supplier_bills"("id")        ON DELETE CASCADE  ON UPDATE CASCADE,
  CONSTRAINT "supplier_bill_lines_inventoryItemId_fkey" FOREIGN KEY ("inventoryItemId") REFERENCES "inventory_items"("id")       ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "supplier_bill_lines_poLineId_fkey"        FOREIGN KEY ("poLineId")        REFERENCES "purchase_order_lines"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE INDEX "supplier_bill_lines_billId_idx" ON "supplier_bill_lines" ("billId");

-- ── Supplier Payments + applications ─────────────────────────────────────────
CREATE TABLE "supplier_payments" (
  "id"           TEXT NOT NULL,
  "supplierId"   TEXT NOT NULL,
  "paymentDate"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "method"       TEXT NOT NULL,
  "reference"    TEXT,
  "amountCents"  INTEGER NOT NULL,
  "appliedCents" INTEGER NOT NULL DEFAULT 0,
  "notes"        TEXT,
  "createdBy"    TEXT,
  "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "supplier_payments_pkey"            PRIMARY KEY ("id"),
  CONSTRAINT "supplier_payments_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "suppliers"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "supplier_payments_supplierId_paymentDate_idx" ON "supplier_payments" ("supplierId", "paymentDate" DESC);

CREATE TABLE "supplier_payment_applications" (
  "id"                 TEXT NOT NULL,
  "paymentId"          TEXT NOT NULL,
  "billId"             TEXT NOT NULL,
  "amountAppliedCents" INTEGER NOT NULL,
  "createdAt"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "supplier_payment_applications_pkey"           PRIMARY KEY ("id"),
  CONSTRAINT "supplier_payment_applications_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "supplier_payments"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "supplier_payment_applications_billId_fkey"    FOREIGN KEY ("billId")    REFERENCES "supplier_bills"("id")    ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "supplier_payment_applications_paymentId_billId_key" ON "supplier_payment_applications" ("paymentId", "billId");
CREATE INDEX        "supplier_payment_applications_billId_idx"           ON "supplier_payment_applications" ("billId");
