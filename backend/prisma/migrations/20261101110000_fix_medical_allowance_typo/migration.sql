-- Data fix (owner, 2026-11-01: "it was a typo error, fix that error and keep one column for MA"): an allowance row
-- named "Medical Allowane" on an employee record becomes "Medical Allowance". Only that exact name, only the
-- allowances list; amounts and everything else untouched.
UPDATE "hr_employees" e
SET "data" = jsonb_set(
  e."data"::jsonb, '{allowances}',
  (SELECT jsonb_agg(CASE WHEN trim(a->>'name') = 'Medical Allowane' THEN jsonb_set(a, '{name}', '"Medical Allowance"') ELSE a END ORDER BY ord)
   FROM jsonb_array_elements(e."data"::jsonb->'allowances') WITH ORDINALITY AS t(a, ord))
)
WHERE jsonb_typeof(e."data"::jsonb->'allowances') = 'array'
  AND EXISTS (SELECT 1 FROM jsonb_array_elements(e."data"::jsonb->'allowances') a WHERE trim(a->>'name') = 'Medical Allowane');
