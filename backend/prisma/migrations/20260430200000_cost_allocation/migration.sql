CREATE TYPE "AllocationDriver" AS ENUM ('fixed_pct', 'revenue_share');

CREATE TABLE "cost_allocation_rules" (
  "id"                TEXT             NOT NULL,
  "name"              TEXT             NOT NULL,
  "sourceAccountCode" TEXT             NOT NULL,
  "driver"            "AllocationDriver" NOT NULL,
  "isActive"          BOOLEAN          NOT NULL DEFAULT TRUE,
  "createdAt"         TIMESTAMP(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"         TIMESTAMP(3)     NOT NULL,

  CONSTRAINT "cost_allocation_rules_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "cost_allocation_rules_sourceAccountCode_key"
  ON "cost_allocation_rules" ("sourceAccountCode");

CREATE TABLE "allocation_rule_weights" (
  "id"                TEXT NOT NULL,
  "ruleId"            TEXT NOT NULL,
  "conceptId"         TEXT NOT NULL,
  "weightBps"         INTEGER NOT NULL,
  "targetAccountCode" TEXT,

  CONSTRAINT "allocation_rule_weights_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "allocation_rule_weights_ruleFk"
    FOREIGN KEY ("ruleId")    REFERENCES "cost_allocation_rules"("id") ON DELETE CASCADE,
  CONSTRAINT "allocation_rule_weights_conceptFk"
    FOREIGN KEY ("conceptId") REFERENCES "concepts"("id")               ON DELETE NO ACTION
);
CREATE UNIQUE INDEX "allocation_rule_weights_rule_concept_key"
  ON "allocation_rule_weights" ("ruleId", "conceptId");

CREATE TABLE "cost_allocation_runs" (
  "id"               TEXT          NOT NULL,
  "ruleId"           TEXT          NOT NULL,
  "periodStart"      TIMESTAMP(3)  NOT NULL,
  "periodEnd"        TIMESTAMP(3)  NOT NULL,
  "totalAmountCents" INTEGER       NOT NULL,
  "postedAt"         TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "postedById"       TEXT,

  CONSTRAINT "cost_allocation_runs_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "cost_allocation_runs_ruleFk"
    FOREIGN KEY ("ruleId") REFERENCES "cost_allocation_rules"("id") ON DELETE NO ACTION
);
CREATE INDEX "cost_allocation_runs_ruleId_periodStart_idx"
  ON "cost_allocation_runs" ("ruleId", "periodStart" DESC);
