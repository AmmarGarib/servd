-- Two-factor authentication for staff accounts (WhatsApp OTP).
--
-- twoFactorPhone is written only after the staff member has proved they
-- receive codes on it. twoFactorEnabledAt being non-null is the ONLY thing
-- that turns 2FA on for an account — never the role — so shipping this
-- cannot lock anyone out of an account they could sign into yesterday.
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "twoFactorPhone"     TEXT;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "twoFactorEnabledAt" TIMESTAMP(3);
