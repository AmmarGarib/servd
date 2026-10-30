-- Owner, 2026-10-30: "Dock October too". The absent-without-a-punch rule (hr/attendanceDays.ts, HR setting
-- absentWithoutPunchFrom) starts on 1 October instead of 1 November. A company whose saved HR settings still carry the
-- old default moves with it; a company that chose another day (or switched the rule off, null) keeps its choice.
-- Rows that never stored the field take the new code default. Draft payrolls change only when HR presses Recalculate.
UPDATE "settings"
SET "value" = jsonb_set("value"::jsonb, '{absentWithoutPunchFrom}', '"2026-10-01"')::text,
    "updatedAt" = NOW()
WHERE "key" LIKE 'hr.settings.%'
  AND "value" ~ '^\s*\{'
  AND ("value"::jsonb ->> 'absentWithoutPunchFrom') = '2026-11-01';
