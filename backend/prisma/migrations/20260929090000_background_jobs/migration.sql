-- Background jobs + cron bookkeeping for the serverless (Vercel) deployment.
CREATE TYPE "BackgroundJobStatus" AS ENUM ('pending', 'running', 'done', 'failed');

CREATE TABLE "background_jobs" (
  "id"          TEXT NOT NULL,
  "queue"       TEXT NOT NULL,
  "jobKey"      TEXT,
  "payload"     JSONB NOT NULL,
  "status"      "BackgroundJobStatus" NOT NULL DEFAULT 'pending',
  "runAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "attempts"    INTEGER NOT NULL DEFAULT 0,
  "maxAttempts" INTEGER NOT NULL DEFAULT 5,
  "lastError"   TEXT,
  "lockedAt"    TIMESTAMP(3),
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"   TIMESTAMP(3) NOT NULL,
  CONSTRAINT "background_jobs_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "background_jobs_queue_jobKey_key" ON "background_jobs"("queue", "jobKey");
CREATE INDEX "background_jobs_queue_status_runAt_idx" ON "background_jobs"("queue", "status", "runAt");

CREATE TABLE "cron_runs" (
  "name"      TEXT NOT NULL,
  "lastRunAt" TIMESTAMP(3) NOT NULL,
  "lastError" TEXT,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "cron_runs_pkey" PRIMARY KEY ("name")
);
