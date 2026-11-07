-- Shift corrections: finance pulls a set back from the CEO to change it (owner, 2026-11-07: "Add pull back for
-- shift corrections too"). A new status only; the open-set index is widened in the next migration (a new enum
-- value cannot be used in the transaction that adds it).
ALTER TYPE "ShiftCorrectionStatus" ADD VALUE IF NOT EXISTS 'draft';
