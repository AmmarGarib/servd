-- Finance wave B (2026-10-14): new values on existing enums. Its own migration:
-- a new enum value cannot be used in the transaction that adds it (precedent
-- 20261013090000_raast_enum_values). Sorts before 20261014090000_finance_wave_b,
-- and NEITHER this nor the main migration uses these values — they are only
-- written by the new code once both have committed.
--
--   on_account     a named on-account client's bill (Dr 1110 at the close,
--                  billed on a monthly statement; CASH tax class)
--   voided         the CEO voided a provisional Raast receipt whose sale was
--                  never booked (RV-MONEY-1): no ledger entry, bankRef claimed
--   settled /      cash requests: receipts + change cover the advance / the
--   converted      unsettled rest moved to a staff loan or the director (H3)
--   code_rerouted / door_problem / returned
--                  delivery emergency overrides and the rider's door report
--   modifier       a recipe for ONE unit of a menu modifier (add-on)
--
-- Harmless to keep if the main migration fails (unused enum values); a
-- Postgres enum value cannot be dropped anyway.

-- AlterEnum
ALTER TYPE "PaymentMethod" ADD VALUE IF NOT EXISTS 'on_account';

-- AlterEnum
ALTER TYPE "RaastReceiptStatus" ADD VALUE IF NOT EXISTS 'voided';

-- AlterEnum
ALTER TYPE "CashVoucherStatus" ADD VALUE IF NOT EXISTS 'settled';
ALTER TYPE "CashVoucherStatus" ADD VALUE IF NOT EXISTS 'converted';

-- AlterEnum
ALTER TYPE "RiderJobEventType" ADD VALUE IF NOT EXISTS 'code_rerouted';
ALTER TYPE "RiderJobEventType" ADD VALUE IF NOT EXISTS 'door_problem';
ALTER TYPE "RiderJobEventType" ADD VALUE IF NOT EXISTS 'returned';

-- AlterEnum
ALTER TYPE "RecipeKind" ADD VALUE IF NOT EXISTS 'modifier';
