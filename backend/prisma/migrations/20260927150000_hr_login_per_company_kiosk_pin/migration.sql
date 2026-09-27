-- One login may be an employee in each company (owner decision 31).
DROP INDEX "hr_employees_userId_key";
CREATE UNIQUE INDEX "hr_employees_tenantId_userId_key" ON "hr_employees"("tenantId", "userId");
CREATE INDEX "hr_employees_userId_idx" ON "hr_employees"("userId");

-- Kiosk PIN moves from a per-employee settings row to its own column.
ALTER TABLE "hr_employees" ADD COLUMN "kioskPinHash" TEXT;
UPDATE "hr_employees" e SET "kioskPinHash" = s.value FROM "settings" s WHERE s.key = 'hr.kiosk_pin.' || e.id;
DELETE FROM "settings" WHERE key LIKE 'hr.kiosk_pin.%';
