-- Director logins (owner, 2026-10-18): "a new category of login, 'Director'.
-- For Yusuf and Ali, partners in Flipd, to be able to see how business is
-- doing." A director sees ONLY the brands listed on their login, read-only,
-- through GET /director/* (modules/director). Every other route refuses the
-- role centrally (auth/middleware.ts DIRECTOR_ROUTES).
--
-- ADD VALUE cannot run inside a transaction block that later uses the value;
-- nothing below uses it.
ALTER TYPE "UserRole" ADD VALUE IF NOT EXISTS 'director';

-- The brands (concept ids) a director may see. Empty = sees nothing. Written
-- only by the CEO (POST /auth/users, PATCH /auth/users/:id); every id is
-- checked to be a brand of one of the CEO's companies. NOT the legacy
-- `conceptIds` column (decision 35: no longer read).
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "directorConceptIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
