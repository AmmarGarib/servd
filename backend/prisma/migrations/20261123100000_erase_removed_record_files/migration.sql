-- Record files taken off a record are erased, not kept (owner, 2026-11-23: "delete the detached docs from backend
-- too"). For two releases a removed PO invoice file was kept under owner type '<type>__removed'; erase those rows.
DELETE FROM "cash_voucher_attachments"
WHERE "kind" = 'record_file' AND "ownerType" LIKE '%\_\_removed' ESCAPE '\';
