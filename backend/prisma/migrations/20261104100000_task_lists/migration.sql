-- Task lists (owner, 2026-11-04): a marketing card or a content-calendar entry is a task of the people on it; it is
-- checked off only once marked done AND approved by leadership. Nullable columns: existing rows are open tasks.
ALTER TABLE "content_events" ADD COLUMN "taskDoneAt" TIMESTAMP(3);
ALTER TABLE "content_events" ADD COLUMN "taskDoneById" TEXT;
ALTER TABLE "content_events" ADD COLUMN "leadApprovedAt" TIMESTAMP(3);
ALTER TABLE "content_events" ADD COLUMN "leadApprovedById" TEXT;
CREATE INDEX "content_events_tenantId_leadApprovedAt_idx" ON "content_events"("tenantId", "leadApprovedAt");
