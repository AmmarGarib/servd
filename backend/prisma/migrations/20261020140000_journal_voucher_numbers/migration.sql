-- Automatic voucher numbers on the ledger (owner, 2026-10-20: "Every manual journal entry, and every voucher should
-- generate a unique number in ascending order automatically"). accounting/voucherNumbers.ts stamps new entries
-- (JV- manual / reversal, PV- payment, RV- receipt; per company, ascending). This migration numbers every existing
-- entry ONCE, in (entryDate, createdAt, id) order per company and kind, by the same rule. Additive; an older image
-- ignores the columns (its new entries would simply carry no number — re-run the numbering below for those).
ALTER TABLE "journal_entries"
  ADD COLUMN "voucherKind" TEXT,
  ADD COLUMN "voucherSeq"  INTEGER,
  ADD COLUMN "voucherNo"   TEXT;

WITH kinds AS (
  SELECT e.id, e."tenantId", e."entryDate", e."createdAt",
         CASE
           WHEN COALESCE(e.reference, '') LIKE 'order%' OR COALESCE(e.reference, '') LIKE 'pos.%' OR COALESCE(e.reference, '') LIKE 'shift.close%' THEN NULL
           WHEN COALESCE(e.reference, '') LIKE 'manual:%' OR COALESCE(e.reference, '') LIKE 'manual.%' OR split_part(COALESCE(e.reference, ''), ':', 1) ~ '\.(reversal|void)$' THEN 'JV'
           WHEN m.net > 0 THEN 'PV'
           WHEN m.net < 0 THEN 'RV'
           ELSE NULL
         END AS kind
    FROM journal_entries e
    LEFT JOIN LATERAL (
      SELECT SUM(CASE WHEN l.type = 'credit' THEN l."amountCents" ELSE -l."amountCents" END) AS net
        FROM journal_lines l
        JOIN accounts a ON a.id = l."accountId"
       WHERE l."journalEntryId" = e.id
         AND (a.code IN ('1010', '1011', '1020')
              OR (a.code NOT IN ('1015', '1030', '1110', '1115', '1351', '1355', '1356', '1357')
                  AND EXISTS (SELECT 1 FROM bank_accounts b WHERE b."tenantId" = e."tenantId" AND b."accountCode" = a.code)))
    ) m ON TRUE
   WHERE e."tenantId" IS NOT NULL
), numbered AS (
  SELECT id, kind, ROW_NUMBER() OVER (PARTITION BY "tenantId", kind ORDER BY "entryDate", "createdAt", id) AS seq
    FROM kinds
   WHERE kind IS NOT NULL
)
UPDATE journal_entries e
   SET "voucherKind" = n.kind,
       "voucherSeq"  = n.seq,
       "voucherNo"   = n.kind || '-' || lpad(n.seq::text, 5, '0')
  FROM numbered n
 WHERE n.id = e.id;

CREATE UNIQUE INDEX "journal_entries_tenantId_voucherNo_key" ON "journal_entries"("tenantId", "voucherNo");
CREATE UNIQUE INDEX "journal_entries_tenantId_voucherKind_voucherSeq_key" ON "journal_entries"("tenantId", "voucherKind", "voucherSeq");
