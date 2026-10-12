-- Membership backfill for the company-scoped staff screens (AUTH-R1).
--
-- Who may list, edit, approve and switch into a company is now decided by
-- belonging to it — TenantMember rows plus the login's CURRENT users.tenantId
-- (auth middleware memberTenantIds) — for the CEO role too; the old "admin sees
-- every company" bypass is gone. Many logins are tied to their company ONLY
-- through users.tenantId (the boot backfill sets that column and never adds a
-- member row). For such a login, switching to another company overwrote
-- users.tenantId and the original company dropped out of their reach, with no
-- in-app way back. This makes the primary company a real membership.
--
-- Data only, idempotent (NOT EXISTS + ON CONFLICT DO NOTHING), safe to re-run.

-- ── 1. Every live login is a member of its own primary company ─────────────
-- Grants nothing new: users.tenantId already counts as membership everywhere.
INSERT INTO "tenant_members" ("id", "userId", "tenantId", "role", "createdAt")
SELECT gen_random_uuid()::text,
       u."id",
       u."tenantId",
       CASE WHEN u."role" = 'admin' THEN 'owner' ELSE 'member' END,
       NOW()
FROM   "users" u
JOIN   "tenants" t ON t."id" = u."tenantId" AND t."deletedAt" IS NULL
WHERE  u."deletedAt" IS NULL
  AND  NOT EXISTS (
         SELECT 1 FROM "tenant_members" m
         WHERE  m."userId" = u."id" AND m."tenantId" = u."tenantId"
       )
ON CONFLICT ("userId", "tenantId") DO NOTHING;

-- ── 2. The GS Foods owner belongs to every company ─────────────────────────
-- Before this change the CEO's admin role reached every company on the staff
-- screens and the company switcher without a member row; those screens now
-- read memberships only. Approving hires is CEO-only, so a company he is not a
-- member of could never have its Monday hires approved. This restores exactly
-- the reach he had (the owner's own scripts/ensure-ceo-tenant-memberships.ts
-- does the same by hand). Only the CEO's own account, only while it is the
-- live `admin` login, only live companies. Other admin logins (another
-- company's CEO) are NOT widened.
INSERT INTO "tenant_members" ("id", "userId", "tenantId", "role", "createdAt")
SELECT gen_random_uuid()::text,
       u."id",
       t."id",
       'owner',
       NOW()
FROM   "users" u
CROSS JOIN "tenants" t
WHERE  u."email" = 'ammar.garib@gsfoods.pk'
  AND  u."role" = 'admin'
  AND  u."deletedAt" IS NULL
  AND  t."deletedAt" IS NULL
  AND  NOT EXISTS (
         SELECT 1 FROM "tenant_members" m
         WHERE  m."userId" = u."id" AND m."tenantId" = t."id"
       )
ON CONFLICT ("userId", "tenantId") DO NOTHING;
