-- Riders sign in with an @gsfoods.pk email + password, same as staff (owner, 2026-10-28). Re-runnable.
ALTER TABLE "riders" ADD COLUMN IF NOT EXISTS "email" TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS "riders_email_key" ON "riders"("email");
