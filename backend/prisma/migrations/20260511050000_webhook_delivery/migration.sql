-- CreateTable: per-attempt outbound webhook delivery log
CREATE TABLE "webhook_deliveries" (
    "id"             TEXT NOT NULL,
    "subscriptionId" TEXT NOT NULL,
    "event"          TEXT NOT NULL,
    "url"            TEXT NOT NULL,
    "requestBody"    TEXT NOT NULL,
    "responseCode"   INTEGER,
    "responseBody"   TEXT,
    "status"         TEXT NOT NULL,
    "durationMs"     INTEGER,
    "attemptNumber"  INTEGER NOT NULL DEFAULT 1,
    "attemptedAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "webhook_deliveries_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "webhook_deliveries"
    ADD CONSTRAINT "webhook_deliveries_subscriptionId_fkey"
    FOREIGN KEY ("subscriptionId") REFERENCES "webhook_subscriptions"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateIndex
CREATE INDEX "webhook_deliveries_subscriptionId_attemptedAt_idx"
    ON "webhook_deliveries"("subscriptionId", "attemptedAt" DESC);

CREATE INDEX "webhook_deliveries_event_attemptedAt_idx"
    ON "webhook_deliveries"("event", "attemptedAt" DESC);
