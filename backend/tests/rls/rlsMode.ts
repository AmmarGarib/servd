// TEST_RLS=1 — run the suite with the live company lock (row-level security) ON.
//
// The normal test database is built with `db push` and has NO row-level
// security, and the suite connects as the `postgres` superuser, which bypasses
// RLS anyway. So a query that forgets its company filter passes every test.
// In this mode (wired from tests/setup.ts):
//
//   1. setup builds the schema as the OWNER (the URL the run started with),
//   2. replays every row-level-security statement of the migration history
//      onto it, in migration order (helper functions, ENABLE ROW LEVEL
//      SECURITY, CREATE / DROP POLICY, the guarded DO blocks) — one copy of
//      the SQL, read from prisma/migrations,
//   3. points DATABASE_URL at a plain LOGIN role (`servd_test_rls`: not a
//      superuser, not the table owner, NOBYPASSRLS) with table privileges
//      only, and sets RLS_ENFORCE=1 — the way lib/prisma.ts runs on live.
//
// The app's `prisma` client then SET LOCALs app.tenant_ids / app.customer_id
// per request, and the policies decide what each request sees.
//
// ONE deliberate difference from the migrations' helper functions: "service
// mode" (workers, boot, fixtures — no request context) is a session variable
// that is UNSET. Postgres cannot unset a custom variable again: once a
// request's SET LOCAL has run on a pooled connection, the variable reads ''
// on that connection for the rest of its life, so a later serviceClient
// query on it is no longer service mode and sees NOTHING. (That is a real
// product hazard once live connects as a non-bypassing role — reported with
// the F9 findings.) Here the role carries a session default of '__service__'
// for both variables and the three helpers read that sentinel as "unset", so
// service mode survives connection reuse exactly as the product intends.
//
// Files that test RLS themselves (create roles, replace the helper functions,
// SET ROLE) are excluded from this mode — see RLS_SELF_MANAGED below.

import { readFileSync, readdirSync } from 'node:fs'
import type { PrismaClient } from '@prisma/client'

export const RLS_ROLE = 'servd_test_rls'
const RLS_PASSWORD = 'servd_test_rls'
export const SERVICE_SENTINEL = '__service__'

export function isRlsMode(): boolean {
  return process.env.TEST_RLS === '1'
}

/** Test files that manage RLS themselves and cannot run as the plain role. */
export const RLS_SELF_MANAGED = [
  'tests/fixedAssetsRls.test.ts',
  'tests/headOfficeRlsContext.test.ts',
  'tests/moneyBigintRls.test.ts',
]

/**
 * The owner's URL (the one the run started with) — remembered in the
 * environment because the fork is reused across files and DATABASE_URL is
 * swapped to the app role after the first file.
 */
export function ownerUrl(): string {
  if (!process.env.TEST_RLS_OWNER_URL) process.env.TEST_RLS_OWNER_URL = process.env.DATABASE_URL ?? ''
  return process.env.TEST_RLS_OWNER_URL
}

/** The same database, as the plain app role. */
export function appRoleUrl(): string {
  const u = new URL(ownerUrl())
  u.username = RLS_ROLE
  u.password = RLS_PASSWORD
  return u.toString()
}

/** Called at setup's module load: the app (imported next) connects as the role, with enforcement on. */
export function enterRlsMode(): void {
  ownerUrl()
  process.env.DATABASE_URL = appRoleUrl()
  process.env.RLS_ENFORCE = '1'
}

// ─── SQL splitting ──────────────────────────────────────────────────────────

/** Split a migration into statements: comments dropped, quotes and $tag$ bodies kept whole. */
export function splitSql(sql: string): string[] {
  const out: string[] = []
  let cur = ''
  let i = 0
  while (i < sql.length) {
    const c = sql[i]
    const two = sql.slice(i, i + 2)
    if (two === '--') { const nl = sql.indexOf('\n', i); i = nl === -1 ? sql.length : nl; continue }
    if (two === '/*') { const end = sql.indexOf('*/', i + 2); i = end === -1 ? sql.length : end + 2; continue }
    if (c === "'" || c === '"') {
      let j = i + 1
      while (j < sql.length) {
        if (sql[j] === c) { if (sql[j + 1] === c) { j += 2; continue } break }
        j++
      }
      cur += sql.slice(i, j + 1); i = j + 1; continue
    }
    if (c === '$') {
      const m = /^\$[A-Za-z_]*\$/.exec(sql.slice(i))
      if (m) {
        const end = sql.indexOf(m[0], i + m[0].length)
        const stop = end === -1 ? sql.length : end + m[0].length
        cur += sql.slice(i, stop); i = stop; continue
      }
    }
    if (c === ';') { if (cur.trim()) out.push(cur.trim()); cur = ''; i++; continue }
    cur += c; i++
  }
  if (cur.trim()) out.push(cur.trim())
  return out
}

/** Is this statement part of the row-level-security layer? */
export function isRlsStatement(s: string): boolean {
  if (/^CREATE\s+(OR\s+REPLACE\s+)?FUNCTION\s+"?app_/i.test(s)) return true
  if (/^(CREATE|DROP|ALTER)\s+POLICY\b/i.test(s)) return true
  if (/^ALTER\s+TABLE\b[\s\S]*\b(ENABLE|DISABLE|FORCE|NO\s+FORCE)\s+ROW\s+LEVEL\s+SECURITY\s*$/i.test(s)) return true
  if (/^DO\b/i.test(s) && /\bPOLICY\b|ROW\s+LEVEL\s+SECURITY/i.test(s)) return true
  return false
}

export interface RlsReplayReport { applied: number; failed: Array<{ migration: string; error: string; statement: string }> }

/** Replay every RLS statement of the migration history, in order. Failures are collected, not thrown. */
export async function replayRlsFromMigrations(owner: PrismaClient): Promise<RlsReplayReport> {
  const dir = new URL('../../prisma/migrations/', import.meta.url)
  const migrations = readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort()
  const report: RlsReplayReport = { applied: 0, failed: [] }
  for (const name of migrations) {
    let sql: string
    try { sql = readFileSync(new URL(`${name}/migration.sql`, dir), 'utf8') } catch { continue }
    for (const statement of splitSql(sql).filter(isRlsStatement)) {
      try {
        await owner.$executeRawUnsafe(statement)
        report.applied++
      } catch (e) {
        report.failed.push({ migration: name, error: (e as Error).message.split('\n').slice(-1)[0] ?? String(e), statement: statement.slice(0, 160) })
      }
    }
  }
  return report
}

/** The helpers, reading the '__service__' session default as "unset" (see the header). */
async function installSentinelHelpers(owner: PrismaClient): Promise<void> {
  const raw = (v: string) => `nullif(current_setting('${v}', true), '${SERVICE_SENTINEL}')`
  await owner.$executeRawUnsafe(`CREATE OR REPLACE FUNCTION app_tenant_ids() RETURNS text[]
    LANGUAGE sql STABLE AS $$
      SELECT CASE
        WHEN ${raw('app.tenant_ids')} IS NULL THEN NULL
        WHEN ${raw('app.tenant_ids')} = '' THEN ARRAY[]::text[]
        ELSE string_to_array(${raw('app.tenant_ids')}, ',')
      END
    $$`)
  await owner.$executeRawUnsafe(`CREATE OR REPLACE FUNCTION app_customer_id() RETURNS text
    LANGUAGE sql STABLE AS $$ SELECT nullif(${raw('app.customer_id')}, '') $$`)
  await owner.$executeRawUnsafe(`CREATE OR REPLACE FUNCTION app_is_service_mode() RETURNS boolean
    LANGUAGE sql STABLE AS $$ SELECT ${raw('app.tenant_ids')} IS NULL AND ${raw('app.customer_id')} IS NULL $$`)
}

/** The plain app role: login, no superuser, no BYPASSRLS, privileges on the rebuilt schema only. */
async function grantAppRole(owner: PrismaClient): Promise<void> {
  await owner.$executeRawUnsafe(`DO $r$ BEGIN
      CREATE ROLE ${RLS_ROLE} LOGIN PASSWORD '${RLS_PASSWORD}' NOSUPERUSER NOBYPASSRLS NOCREATEROLE;
    EXCEPTION WHEN duplicate_object OR unique_violation THEN NULL; END $r$`)
  await owner.$executeRawUnsafe(`ALTER ROLE ${RLS_ROLE} SET app.tenant_ids = '${SERVICE_SENTINEL}'`)
  await owner.$executeRawUnsafe(`ALTER ROLE ${RLS_ROLE} SET app.customer_id = '${SERVICE_SENTINEL}'`)
  await owner.$executeRawUnsafe(`GRANT USAGE ON SCHEMA public TO ${RLS_ROLE}`)
  await owner.$executeRawUnsafe(`GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES ON ALL TABLES IN SCHEMA public TO ${RLS_ROLE}`)
  await owner.$executeRawUnsafe(`GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO ${RLS_ROLE}`)
  await owner.$executeRawUnsafe(`GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO ${RLS_ROLE}`)
}

let reported = false

/** After the schema is built (as owner): policies on, sentinel helpers, app role granted. */
export async function applyRlsMode(owner: PrismaClient): Promise<void> {
  const report = await replayRlsFromMigrations(owner)
  await installSentinelHelpers(owner)
  await grantAppRole(owner)
  if (!reported && process.env.TEST_RLS_VERBOSE === '1') {
    reported = true
    const tables = await owner.$queryRawUnsafe<Array<{ n: number }>>(
      `SELECT count(*)::int AS n FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'r' AND c.relrowsecurity`)
    console.log(`[TEST_RLS] ${report.applied} RLS statements applied, ${report.failed.length} failed; ${tables[0]?.n} tables with RLS on`)
    for (const f of report.failed) console.log(`[TEST_RLS]   ${f.migration}: ${f.error} :: ${f.statement.replace(/\s+/g, ' ')}`)
  }
}
