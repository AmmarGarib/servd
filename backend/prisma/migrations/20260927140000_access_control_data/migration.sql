-- Access-control reconcile (2026-09-27) — DATA ONLY, no schema/enum change.
-- Suggested folder: backend/prisma/migrations/20260927140000_access_control_data/migration.sql

-- #67 / decision 7: legacy 'manager' accounts become floor managers (no company P&L).
-- The enum value 'manager' is KEPT (history, old audit rows); nobody can be assigned it any more.
UPDATE "users" SET "role" = 'foh_management' WHERE "role" = 'manager';
-- A saved module override for the retired role would never be read again.
DELETE FROM "role_module_access" WHERE "role" = 'manager';

-- #79: accountStatus is the one suspension column; isActive is its mirror.
UPDATE "users" SET "accountStatus" = 'suspended'
 WHERE "isActive" = false AND "deletedAt" IS NULL AND "accountStatus" <> 'suspended';
UPDATE "users" SET "isActive" = false
 WHERE "accountStatus" = 'suspended' AND "isActive" = true;

-- #66: module ids retired from the registry (they tagged nothing). Harmless if left
-- (the API strips them on read/write); this just tidies stored rows.
UPDATE "role_module_access"
   SET "modules" = array(SELECT m FROM unnest("modules") m WHERE m NOT IN
       ('staff_management','staff_foh','staff_boh','staff_procurement','staff_marketing','staff_finance','kitchen_staff'));
UPDATE "users"
   SET "moduleAllow" = array(SELECT m FROM unnest("moduleAllow") m WHERE m NOT IN
       ('staff_management','staff_foh','staff_boh','staff_procurement','staff_marketing','staff_finance','kitchen_staff')),
       "moduleDeny"  = array(SELECT m FROM unnest("moduleDeny") m WHERE m NOT IN
       ('staff_management','staff_foh','staff_boh','staff_procurement','staff_marketing','staff_finance','kitchen_staff'));
