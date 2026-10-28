-- Riders sign in with phone + password (owner, 2026-10-28). The WhatsApp code only sets the password the first
-- time and after a forgotten one. Re-runnable.
ALTER TABLE "riders" ADD COLUMN IF NOT EXISTS "passwordHash" TEXT;
ALTER TABLE "riders" ADD COLUMN IF NOT EXISTS "passwordSetAt" TIMESTAMP(3);
