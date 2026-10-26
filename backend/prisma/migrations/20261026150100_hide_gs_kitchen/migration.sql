-- C5 (owner, 2026-10-26: "my test case, my home kitchen"): hide the brand "G's Kitchen" from the public website.
-- Data only: storefrontVisible = false. The brand is not deleted, renamed or moved; the CEO can switch it back on
-- in the brand editor. Name match ignores case, spaces and apostrophe style (G's / G’s / Gs Kitchen). No match = no change.
UPDATE "concepts"
SET "storefrontVisible" = false
WHERE "storefrontVisible" = true
  AND regexp_replace(lower("name"), '[''’‘`´[:space:]]', '', 'g') = 'gskitchen';
