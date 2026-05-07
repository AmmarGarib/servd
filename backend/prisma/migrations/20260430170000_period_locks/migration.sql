CREATE TABLE "period_locks" (
  "id"             TEXT          NOT NULL,
  "lockedThrough"  TIMESTAMP(3)  NOT NULL,
  "lockedBy"       TEXT          NOT NULL,
  "lockedAt"       TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "note"           TEXT,

  CONSTRAINT "period_locks_pkey" PRIMARY KEY ("id")
);
