-- Flag for accounts created with a generated password.
--
-- A nudge for the client to prompt a change on first sign-in — deliberately
-- NOT a login block. Hard-blocking on a flag like this is how people get
-- stranded, which this codebase has already done once this week.
ALTER TABLE "users" ADD COLUMN "mustChangePassword" BOOLEAN NOT NULL DEFAULT false;
