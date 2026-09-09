-- Development / support account with full access.
--
-- Role `admin` is the only role that short-circuits the module gate outright
-- (`if (user.role === 'admin') return` in lib/moduleAccess.ts), so it reaches
-- finance, payroll, procurement, reconciliation and gift cards without needing
-- per-module grants.
--
-- Role alone is NOT full access though. Company scope is separate: every read
-- resolves through resolveTenantScope, which in portfolio mode ("All
-- companies") expands to the tenants this user has a TenantMember row for, and
-- otherwise to users.tenantId alone. An admin with one membership sees exactly
-- one company. So this also enrols the account in EVERY tenant, and re-runs
-- pick up companies created later.
--
-- The password hash is a known, disclosed credential — treat it as public, the
-- same trade as the owner bootstrap in the previous migration.
--
-- TO DISABLE THIS ACCOUNT (it is a standing full-access login on live
-- financial data, so switch it off when it is not being used):
--     UPDATE users SET "isActive" = false, "accountStatus" = 'suspended'
--     WHERE email = 'dev@gsfoods.pk';
-- Re-enable by setting isActive = true, accountStatus = 'active'.

-- The account itself. On re-run, reset only the credential and status —
-- never clobber a name or tenant someone has since adjusted.
UPDATE "users"
SET    "password"      = '$2a$10$MIoyOTKOfxRsRKdnZHvfDugQevUXpWZfNfgxuHkgDZyPMxMrS9lXq',
       "role"          = 'admin',
       "accountStatus" = 'active',
       "isActive"      = true,
       "deletedAt"     = NULL,
       "updatedAt"     = NOW()
WHERE  "email" = 'dev@gsfoods.pk';

INSERT INTO "users" ("id", "tenantId", "name", "email", "password", "role",
                     "jobTitle", "accountStatus", "isActive", "createdAt", "updatedAt")
SELECT gen_random_uuid(),
       (SELECT "id" FROM "tenants" ORDER BY "createdAt" ASC LIMIT 1),
       'servd dev',
       'dev@gsfoods.pk',
       '$2a$10$MIoyOTKOfxRsRKdnZHvfDugQevUXpWZfNfgxuHkgDZyPMxMrS9lXq',
       'admin',
       'Development / support',
       'active',
       true,
       NOW(),
       NOW()
WHERE NOT EXISTS (SELECT 1 FROM "users" WHERE "email" = 'dev@gsfoods.pk');

-- Membership in every company, so portfolio mode actually spans the group
-- rather than showing one company's books. NOT EXISTS rather than ON CONFLICT
-- so this stays correct if the unique index is ever renamed.
INSERT INTO "tenant_members" ("id", "userId", "tenantId", "role", "createdAt")
SELECT gen_random_uuid()::text,
       u."id",
       t."id",
       'admin',
       NOW()
FROM   "users" u
CROSS JOIN "tenants" t
WHERE  u."email" = 'dev@gsfoods.pk'
  AND  NOT EXISTS (
         SELECT 1 FROM "tenant_members" m
         WHERE m."userId" = u."id" AND m."tenantId" = t."id"
       );
