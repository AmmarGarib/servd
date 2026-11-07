-- One open correction per drawer counts a pulled-back draft too.
DROP INDEX IF EXISTS "shift_corrections_one_open";
CREATE UNIQUE INDEX "shift_corrections_one_open" ON "shift_corrections"("shiftId") WHERE "status" IN ('submitted', 'draft');
