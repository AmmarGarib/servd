-- Add birthdayMmDd to customers
ALTER TABLE "customers" ADD COLUMN "birthdayMmDd" TEXT;

-- Create trigger_logs table
CREATE TABLE "trigger_logs" (
  "id"          TEXT NOT NULL,
  "customerId"  TEXT NOT NULL,
  "triggerType" TEXT NOT NULL,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "trigger_logs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "trigger_logs_customerId_triggerType_createdAt_idx"
  ON "trigger_logs"("customerId", "triggerType", "createdAt");

ALTER TABLE "trigger_logs"
  ADD CONSTRAINT "trigger_logs_customerId_fkey"
  FOREIGN KEY ("customerId") REFERENCES "customers"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
