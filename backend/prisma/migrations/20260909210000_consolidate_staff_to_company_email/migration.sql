-- Move the two real staff accounts onto @gsfoods.pk addresses, and give them
-- usable passwords, BEFORE the domain rule and email-only login are enforced.
--
-- Why this has to happen first: production holds four staff accounts, and two
-- of them sign in on gmail addresses. Enforcing "@gsfoods.pk only" without
-- moving them first locks out the CEO's own admin account and the management
-- account on the same day. That is precisely how this went wrong earlier in
-- the week, when PIN login was disabled for owner roles without checking
-- whether those accounts had passwords.
--
-- And they do not. The PIN-login code carried the comment "Admin role is
-- blocked above — admins must use email + password", but no such block ever
-- existed: the only role check on that path gated PIN *rotation*, not login.
-- So admins signed in with a PIN and their password column holds the
-- deliberately-unusable random hash that account creation writes. Moving the
-- address alone would leave both people unable to sign in at all.

-- ── 1. Retire the duplicate ────────────────────────────────────────────────
-- 20260909190000 created ammar.garib@gsfoods.pk as a fresh `owner` row because
-- the CEO could not get in. His real account is the older `admin` one on
-- gmail, which carries the history and the higher role (admin bypasses the
-- module gate entirely; owner does not). That address has to be freed before
-- the real account can take it.
--
-- Delete it, but never at the cost of failing the migration: a failed
-- migration means the API does not boot. If anything references the row,
-- fall back to retiring it under a tombstone address instead.
DO $$
BEGIN
  DELETE FROM "users"
  WHERE "email" = 'ammar.garib@gsfoods.pk'
    AND "name"  = 'Ammar Garib';
EXCEPTION
  WHEN foreign_key_violation OR restrict_violation THEN
    UPDATE "users"
    SET "email"         = 'ammar.garib+superseded@gsfoods.pk',
        "isActive"      = false,
        "accountStatus" = 'suspended',
        "updatedAt"     = NOW()
    WHERE "email" = 'ammar.garib@gsfoods.pk'
      AND "name"  = 'Ammar Garib';
END $$;

-- ── 2. The CEO's real account moves to the company address ────────────────
-- Password is set to the one he is already using, so nothing changes for him
-- at the sign-in box. He can replace it from the login page once the
-- change-password flow ships.
UPDATE "users"
SET "email"         = 'ammar.garib@gsfoods.pk',
    "password"      = '$2a$10$eSQn6Ckoo/H2xVX7xu7HSeMa5yR3u6X1ilPN00eb76i7KY.0b9t82',
    "accountStatus" = 'active',
    "isActive"      = true,
    "deletedAt"     = NULL,
    "updatedAt"     = NOW()
WHERE "email" = 'a.garib.pakistani@gmail.com';

-- ── 3. Management account moves too ───────────────────────────────────────
-- Only if the target address is free, so a re-run cannot collide.
UPDATE "users"
SET "email"         = 'abeer.garib@gsfoods.pk',
    "password"      = '$2a$10$u9RvFtPe60pS8/Wta2.LiezFySjeP2cnF2HOfXCfwUPtNdVbZb5H.',
    "accountStatus" = 'active',
    "isActive"      = true,
    "deletedAt"     = NULL,
    "updatedAt"     = NOW()
WHERE "email" = 'beaniegarib@gmail.com'
  AND NOT EXISTS (SELECT 1 FROM "users" WHERE "email" = 'abeer.garib@gsfoods.pk');

-- Both hashes above are known, disclosed bootstrap credentials — the same
-- trade already made for the owner bootstrap. They are to be changed on first
-- sign-in once the change-password flow is live.
