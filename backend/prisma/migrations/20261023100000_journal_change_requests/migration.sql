-- Journals tab (owner, 2026-10-23): "option to edit/cancel/void any back dated or current Journal manual entry
-- with final approval of CEO … CEO approve edits only when amount is edited".
-- A finance edit that changes money (or a cancel) of an existing manual entry is a journal request of kind
-- 'amend' (or the existing 'reverse') that the CEO approves — the ONE journal-request store, no second engine.
--   (a) journal_requests.changeMeta (JSONB, nullable): the fingerprint of the entry when the change was raised
--       (approval refuses 409 ENTRY_CHANGED if it moved) and the corrected payment's classification;
--   (b) the kind CHECK admits 'amend'; reverseEntryId is required for 'amend' too.
-- Additive and instant (nullable column; CHECK swap on a small table). Older images ignore the column, but an
-- older image cannot approve an 'amend' row (it would post it as kind post): withdraw open 'amend' requests
-- before rolling the API back below this release.
SET lock_timeout = '15s';

ALTER TABLE "journal_requests" ADD COLUMN "changeMeta" JSONB;

ALTER TABLE "journal_requests" DROP CONSTRAINT IF EXISTS "journal_requests_kind_chk";
ALTER TABLE "journal_requests" DROP CONSTRAINT IF EXISTS "journal_requests_reverse_chk";

-- ─── SQL-only objects (tests/setup.ts applies this section; no ';' inside a statement)
ALTER TABLE "journal_requests" ADD CONSTRAINT "journal_requests_kind_chk"
  CHECK ("kind" IN ('post', 'reverse', 'amend'));
ALTER TABLE "journal_requests" ADD CONSTRAINT "journal_requests_reverse_chk"
  CHECK ("kind" NOT IN ('reverse', 'amend') OR "reverseEntryId" IS NOT NULL);
