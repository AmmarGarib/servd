-- A PO's cash voucher waits for finance (owner, 2026-11-10: "Finance approval getting skipped, fix it").
-- PO cash vouchers raised straight into 'approved' with no finance approval and not paid yet go back to finance's
-- step ('submitted'); the CEO's signature (the PO approval) stays. A PO a finance login raised keeps its state (the
-- finance-raised rule), as does any voucher already paid or decided.
UPDATE "cash_vouchers" cv
SET "status" = 'submitted', "updatedAt" = now()
WHERE cv."purchaseOrderId" IS NOT NULL
  AND cv."status" = 'approved'
  AND cv."financeApprovedById" IS NULL
  AND cv."disbursedAt" IS NULL
  AND NOT EXISTS (SELECT 1 FROM "users" u WHERE u."id" = cv."preparedById" AND u."role" = 'finance');
