-- One-time owner bootstrap.
--
-- Why this exists: PIN sign-in used to work for `owner`, and the security pass
-- in 20260908 added owner/management/finance/hr/manager/fnb_manager to
-- PIN_LOGIN_BLOCKED_ROLES without checking whether those accounts had a
-- password set. The CEO's account did not, so the only way into the system was
-- closed. There is no staff password-reset flow to fall back on.
--
-- This sets a bootstrap password on that one account so the operator can sign
-- in and change it from the app. It is deliberately narrow: one email, no
-- effect on any other row.
--
-- The bcrypt hash below is a KNOWN, ALREADY-DISCLOSED bootstrap credential —
-- treat it as public. It is here because the alternative was the operator
-- running a shell command against the production database by hand, which is
-- worse. It must be changed on first sign-in, and the follow-up migration that
-- removes this file's relevance is simply: the operator changing the password.
--
-- If the account already exists, only the password / status is touched; the
-- tenant, role, name and PIN are left exactly as they are.
UPDATE "users"
SET    "password"      = '$2a$10$0VKo95eFqDHcdgkwkZI/QO0T9G18tsh/ybDhrXRL84ns2HBQtaTja',
       "accountStatus" = 'active',
       "isActive"      = true,
       "deletedAt"     = NULL,
       "updatedAt"     = NOW()
WHERE  "email" = 'ammar.garib@gsfoods.pk';

-- If no row carries that address, create it as an owner on the oldest company
-- (GS Foods). A NULL tenantId would authenticate but resolve to an empty scope,
-- so every page would render blank — worse than not existing.
INSERT INTO "users" ("id", "tenantId", "name", "email", "password", "role",
                     "accountStatus", "isActive", "createdAt", "updatedAt")
SELECT gen_random_uuid(),
       (SELECT "id" FROM "tenants" ORDER BY "createdAt" ASC LIMIT 1),
       'Ammar Garib',
       'ammar.garib@gsfoods.pk',
       '$2a$10$0VKo95eFqDHcdgkwkZI/QO0T9G18tsh/ybDhrXRL84ns2HBQtaTja',
       'owner',
       'active',
       true,
       NOW(),
       NOW()
WHERE NOT EXISTS (SELECT 1 FROM "users" WHERE "email" = 'ammar.garib@gsfoods.pk');
