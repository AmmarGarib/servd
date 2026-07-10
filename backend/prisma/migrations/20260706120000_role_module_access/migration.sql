-- Role → module allow-list, persisted server-side. Previously the CEO's
-- Module Access matrix lived only in the admin browser's localStorage and the
-- API never enforced it. A row is the FULL allow-list for that role; roles
-- without a row use the in-code defaults.
CREATE TABLE "role_module_access" (
  "id"        TEXT NOT NULL,
  "role"      "UserRole" NOT NULL,
  "modules"   TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "role_module_access_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "role_module_access_role_key" ON "role_module_access"("role");
