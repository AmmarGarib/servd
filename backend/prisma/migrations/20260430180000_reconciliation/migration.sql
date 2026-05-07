CREATE TABLE "bank_statement_imports" (
  "id"                  TEXT          NOT NULL,
  "source"              TEXT          NOT NULL,
  "accountCode"         TEXT          NOT NULL,
  "statementDate"       TIMESTAMP(3)  NOT NULL,
  "openingBalanceCents" INTEGER       NOT NULL DEFAULT 0,
  "closingBalanceCents" INTEGER       NOT NULL DEFAULT 0,
  "filename"            TEXT,
  "importedById"        TEXT,
  "importedAt"          TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "bank_statement_imports_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "bank_statement_imports_source_statementDate_idx"
  ON "bank_statement_imports" ("source", "statementDate" DESC);

CREATE TABLE "bank_statement_lines" (
  "id"                   TEXT          NOT NULL,
  "importId"             TEXT          NOT NULL,
  "postedDate"           TIMESTAMP(3)  NOT NULL,
  "description"          TEXT          NOT NULL,
  "reference"            TEXT,
  "amountCents"          INTEGER       NOT NULL,
  "matchStatus"          TEXT          NOT NULL DEFAULT 'unmatched',
  "matchedJournalLineId" TEXT,
  "notes"                TEXT,
  "createdAt"            TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"            TIMESTAMP(3)  NOT NULL,
  CONSTRAINT "bank_statement_lines_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "bank_statement_lines_importId_fkey"
    FOREIGN KEY ("importId") REFERENCES "bank_statement_imports"("id") ON DELETE CASCADE
);
CREATE INDEX "bank_statement_lines_importId_matchStatus_idx"
  ON "bank_statement_lines" ("importId", "matchStatus");
CREATE INDEX "bank_statement_lines_postedDate_idx"
  ON "bank_statement_lines" ("postedDate" DESC);

CREATE TABLE "foodpanda_settlements" (
  "id"                  TEXT          NOT NULL,
  "settlementDate"      TIMESTAMP(3)  NOT NULL,
  "reference"           TEXT,
  "expectedAmountCents" INTEGER       NOT NULL,
  "actualAmountCents"   INTEGER       NOT NULL,
  "varianceCents"       INTEGER       NOT NULL DEFAULT 0,
  "status"              TEXT          NOT NULL DEFAULT 'open',
  "notes"               TEXT,
  "recordedById"        TEXT,
  "createdAt"           TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"           TIMESTAMP(3)  NOT NULL,
  CONSTRAINT "foodpanda_settlements_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "foodpanda_settlements_settlementDate_idx"
  ON "foodpanda_settlements" ("settlementDate" DESC);
