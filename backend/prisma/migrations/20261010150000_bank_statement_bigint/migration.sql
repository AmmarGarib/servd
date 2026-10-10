-- BOOKS-06: bank statement balances are paisa, and an operating account
-- holds more than PKR 21,474,836.47 (2^31 − 1 paisa). As INT4 those imports
-- failed with a 500 ("Unable to fit integer value … into an INT4"). Widening
-- INT4 → INT8 keeps every existing value; no data changes.
ALTER TABLE "bank_statement_imports"
  ALTER COLUMN "openingBalanceCents" SET DATA TYPE BIGINT,
  ALTER COLUMN "closingBalanceCents" SET DATA TYPE BIGINT;
