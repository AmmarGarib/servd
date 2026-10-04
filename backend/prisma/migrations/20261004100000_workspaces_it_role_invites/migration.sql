-- Workspaces (owner decision 47): an IT / developer role for the Dev
-- workspace, and who added each login (owners add staff under them; the CEO
-- approves before the login can sign in).
ALTER TYPE "UserRole" ADD VALUE IF NOT EXISTS 'it';

ALTER TABLE "users" ADD COLUMN "invitedById" TEXT;
CREATE INDEX "users_invitedById_idx" ON "users"("invitedById");
