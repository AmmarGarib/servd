-- Workforce hub flow: CEO stubs a staff row with just (name?, category, job
-- title) and fills the rest in later. Two schema relaxations support that:
--
--   1. `users.email` becomes nullable. Postgres allows multiple NULLs on a
--      UNIQUE column out of the box, so real addresses still can't collide.
--      Login routes already reject `email IS NULL` rows.
--   2. New `users.job_title` free-text column for the operator-readable role
--      name shown alongside the enum category chip in /workforce.

ALTER TABLE "users" ALTER COLUMN "email" DROP NOT NULL;

ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "jobTitle" TEXT;
