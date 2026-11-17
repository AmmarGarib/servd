-- Changes to servd's Ingredients sheet wait for the CEO (owner, 2026-11-17: "changes in this sheet need to be approved
-- by me"). Platform data like ingredient_masters: no tenantId, no RLS (deliberate — the sheet belongs to no company).
CREATE TABLE "ingredient_master_change_requests" (
    "id" TEXT NOT NULL,
    "masterIngredientId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "changes" JSONB NOT NULL,
    "requestedById" TEXT NOT NULL,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "decidedById" TEXT,
    "decidedAt" TIMESTAMP(3),
    "decisionNote" TEXT,
    CONSTRAINT "ingredient_master_change_requests_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ingredient_master_change_requests_status_chk" CHECK ("status" IN ('pending', 'approved', 'rejected', 'cancelled'))
);
CREATE INDEX "ingredient_master_change_requests_masterIngredientId_status_idx" ON "ingredient_master_change_requests"("masterIngredientId", "status");
CREATE INDEX "ingredient_master_change_requests_status_requestedAt_idx" ON "ingredient_master_change_requests"("status", "requestedAt");
