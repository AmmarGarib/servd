-- Adds pinMustReset to flag legacy phone-derived PINs for rotation.
--
-- Every existing User row with a non-null PIN is presumed to be on the old
-- phone-last-4 scheme (the codebase used pinFromPhone() at signup time until
-- the security commit just before this migration). They keep working only
-- after an admin issues a fresh CSPRNG PIN.

ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "pinMustReset" BOOLEAN NOT NULL DEFAULT false;

UPDATE "users"
SET "pinMustReset" = true
WHERE "pin" IS NOT NULL;
