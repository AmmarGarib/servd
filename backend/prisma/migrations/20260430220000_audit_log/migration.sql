CREATE TABLE "audit_logs" (
  "id"         TEXT          NOT NULL,
  "action"     TEXT          NOT NULL,
  "entity"     TEXT          NOT NULL,
  "entityId"   TEXT,
  "userId"     TEXT,
  "userEmail"  TEXT,
  "before"     JSONB,
  "after"      JSONB,
  "metadata"   JSONB,
  "createdAt"  TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "audit_logs_action_createdAt_idx" ON "audit_logs" ("action", "createdAt" DESC);
CREATE INDEX "audit_logs_entity_entityId_idx"  ON "audit_logs" ("entity", "entityId");
CREATE INDEX "audit_logs_userId_createdAt_idx" ON "audit_logs" ("userId", "createdAt" DESC);
