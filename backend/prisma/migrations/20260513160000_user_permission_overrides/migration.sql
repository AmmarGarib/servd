-- Per-user permission + module overrides. The role gives the baseline; these
-- four arrays let the CEO subjectively tune a single staff member without
-- changing the role's defaults for everyone else.
--
--   permissionAllow: action keys this user has DESPITE role saying no
--   permissionDeny:  action keys this user can't do DESPITE role saying yes
--   moduleAllow:     sidebar module IDs visible DESPITE role hiding them
--   moduleDeny:      sidebar module IDs hidden DESPITE role showing them
--
-- Empty arrays = "follow role defaults exactly" (no overrides).
-- Resolution: effective = (role_default ∪ allow) \ deny — implemented in
-- backend/src/lib/permissions.ts.

ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "permissionAllow" TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "permissionDeny"  TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "moduleAllow"     TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "moduleDeny"      TEXT[] NOT NULL DEFAULT '{}';
