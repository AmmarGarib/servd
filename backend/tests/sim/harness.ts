// The simulated month — SHARED HARNESS (finance readiness plan §4a, owner:
// "finalize the finance module, it has to be ready and tested by 25th
// October"; "Do the simulation then"). Not a test file itself: every
// `tests/sim/*.sim.test.ts` builds its world with it.
//
// ─── What it gives you ──────────────────────────────────────────────────────
//
//   const sim = await startSim()          // in beforeAll (≈10 s: app + world); afterAll: sim.close()
//   sim.app                                // Fastify app: EVERY route plugin
//                                          // src/index.ts registers, under the
//                                          // same /api/v1 prefixes (read from
//                                          // index.ts itself, so it never drifts),
//                                          // with the production error handler
//                                          // shape, the RLS request context, the
//                                          // empty-JSON-body and brand-scope hooks.
//                                          // Not registered: helmet, CORS, the
//                                          // rate limiter (the month makes thousands
//                                          // of calls), swagger, inline social OAuth.
//   sim.A, sim.B                           // the two companies (SimCompany below)
//   sim.ceo                                // ONE admin login, member of A and B
//   await sim.as(sim.A.finance).post('/accounting/night-audit/2026-10-01/run', {})
//   await sim.as(sim.ceo, sim.B).get('/accounting/trial-balance?asOf=2026-10-31')
//                                          // as(user, company?) → { get, post, put,
//                                          // patch, del } returning the inject
//                                          // response; the company is sent as the
//                                          // active-company header; paths are
//                                          // WITHOUT /api/v1. Every call advances
//                                          // the clock one second.
//   ok(res, 201)                           // asserts the status (body in the message), returns json()
//   errCode(res)                           // res.json().error.code
//   pdfFile('slip.pdf')                    // a tiny valid PDF upload { fileName, mime, dataBase64 }
//   sim.asCustomer(customerId) / sim.asRider(riderId)   // storefront / rider-app callers
//   await sim.mkCustomer('Sana', '923331112233')        // a customer with a verified phone
//
// ─── Time: the simulated month is October 2026 ──────────────────────────────
//
// The code reads "now" (Karachi today, DAY_NOT_OVER, back-dated sales, the
// business-day cut-off, card lag days, COD hours) from the JS clock, and the
// rows it writes carry Prisma-filled timestamps (`@default(now())`,
// `@updatedAt`). Both are frozen to the simulated time:
//   - `vi.useFakeTimers({ toFake: ['Date'] })`: only Date is faked — timers,
//     sockets and the Prisma engine keep real time, so awaits still work;
//   - a Prisma middleware on the base client (the one `lib/prisma.ts` keeps on
//     globalThis) fills every `@default(now())` / `@updatedAt` field of every
//     create / createMany / upsert / update — nested creates included — with
//     the simulated time when the caller did not set it. (The engine would
//     otherwise stamp the real wall clock.)
// Not covered: raw SQL `now()` (two places outside sales: tax-invoice series
// `updatedAt`, a wallet row's timestamps) — harmless for the checks here.
//   sim.clock.at('2026-10-03', '23:30')    // jump (never backwards)
//   sim.clock.now() / sim.clock.today()   // Date / 'YYYY-MM-DD' (PKT)
//   sim.clock.tick(ms)
//   pkt('2026-10-03', '01:30')            // a Date at that Karachi wall time
//   SIM_DAYS                               // the trading days of the sales sim
//
// The world is built on 30 Sept 2026 10:00 PKT. Calling clock.at with an
// earlier time throws.
//
// ─── The world (built through the API where the API exists) ─────────────────
//
// Seeded directly (no API creates them, or the API needs them first): the two
// companies (A = 'GS Foods', B = 'GS x Viva', kind company, chart via
// ensureChartOfAccounts as the API boot does), the logins and their company
// memberships, the manager PIN, one outlet per company, a rider per company
// (sim.A.riderId), and the brands with their menu (category + 4 items: main,
// side, drink, dessert; coordinates set for delivery quotes):
//   A: Simmer ('simmer', SRB / province SD) + Flipd ('flipd', FBR / ICT)
//   B: Stackd ('stackd', SRB / SD) + Viva Grill ('viva-grill', FBR / ICT)
// (One sales account per brand, 2026-10-17: simmer 4001, stackd 4002, flipd
// 4004 keep their legacy codes; viva-grill gets "Sales — Viva Grill" 4010 in
// B's chart, as the brand create / boot step gives it.)
// Through the API, as the people who do it in real life:
//   - finance: two bank accounts (POST /setup/bank-accounts → 1020 and a new
//     102x), the Raast receiving account per brand (PUT /setup/raast-accounts,
//     the second bank), card payout matching ON with the first bank as payout
//     bank (PUT /reconciliation/card-payouts/settings, lag 1 day, MDR 2% + 16%
//     tax), withholding in A (PUT /accounting/withholding/rates + /enabled);
//   - the CEO: night-audit start day 1 Oct (PUT /accounting/night-audit/settings),
//     code-only delivery ON in A / OFF in B (PUT /emergency-overrides/settings),
//     a 5% service charge on till orders (PATCH /setup/operations-config);
//   - the manager: storefront hours 09:00–23:59 every day (PUT /setup/hours/:id)
//     and one delivery zone with a PKR 150 fee (POST /setup/delivery-zones).
//
// The fiscal POS has no connector (driver 'none'): sale documents stay 'held'
// as before go-live; the outbox kicker is a no-op, nothing leaves the box.
//
// Logins per company (UserRole): finance ('finance', Hasnain — holds the
// `accounting` module by default), manager ('fnb_manager', the manager-PIN
// approver, PIN in SIM_PIN[co.key]), cashier + cashier2 ('cashier'). The CEO
// is one 'admin' login, member of both (primary A).
//
// ─── Ledger helpers (read the books straight from the DB, per company) ──────
//
//   await sim.ledger.balanceOf(co, '1010', asOf?)     // Σ debit − Σ credit (cents)
//   await sim.ledger.trialBalance(co, asOf?)          // the REAL report (accounting/reports.ts trialBalance)
//   await sim.ledger.assertBalanced(co)               // every entry Σdr = Σcr and the TB balances
//   await sim.ledger.entriesBySource(co, 'shift.close:') // entries whose reference starts with it
//   await sim.ledger.openFlags(co, kind?)              // open exception flags
//   asOf is a 'YYYY-MM-DD' (end of that Karachi day) or a Date; default now.
//
// ─── Misc ───────────────────────────────────────────────────────────────────
//
//   await sim.settle()        // let fire-and-forget work finish (shift-close
//                             // posting, completion effects): waits until no
//                             // new journal entry appeared for a short while.
//   await sim.waitFor(fn)     // poll an async predicate (real time).
//   sim.close()               // afterAll
//
// Everything a sim test writes is company-scoped the same way the app is; a
// sim test that needs more of the world (a supplier, an employee, a client)
// creates it through the API in its own file.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { expect, vi } from 'vitest'
import Fastify, { type FastifyInstance, type LightMyRequestResponse } from 'fastify'
import { ZodError } from 'zod'
import bcrypt from 'bcryptjs'
import { Prisma, type PrismaClient, type UserRole } from '@prisma/client'

// ─── Clock ──────────────────────────────────────────────────────────────────

export const SIM_MONTH = '2026-10'
/** Trading days of the sales simulation: Thu 1 – Sun 4, Monday 5 closed, Tue 6, and month-end Sat 31. */
export const SIM_DAYS = ['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-06', '2026-10-31'] as const
export const WORLD_BUILT_AT = '2026-09-30T10:00:00+05:00'

/** A Date at a Karachi wall time. */
export const pkt = (day: string, hhmm = '12:00'): Date => new Date(`${day}T${hhmm}:00+05:00`)
/** 'YYYY-MM-DD' of a Date in Karachi. */
export const pktDay = (d: Date): string => new Date(d.getTime() + 5 * 3_600_000).toISOString().slice(0, 10)
/** The next calendar day. */
export const nextDay = (day: string, n = 1): string => pktDay(new Date(pkt(day).getTime() + n * 86_400_000))

export interface SimClock {
  now(): Date
  today(): string
  at(day: string, hhmm?: string): Date
  set(d: Date): Date
  tick(ms?: number): Date
}

let clockInstalled = false

function makeClock(): SimClock {
  const set = (d: Date): Date => {
    const cur = Date.now()
    if (d.getTime() < cur - 1) throw new Error(`sim clock: ${d.toISOString()} is before the current simulated time ${new Date(cur).toISOString()}`)
    vi.setSystemTime(d)
    return new Date(d.getTime())
  }
  return {
    now: () => new Date(),
    today: () => pktDay(new Date()),
    at: (day, hhmm = '12:00') => set(pkt(day, hhmm)),
    set,
    tick: (ms = 1_000) => { vi.setSystemTime(Date.now() + ms); return new Date() },
  }
}

/** Fields filled by the engine's clock: `@default(now())` and `@updatedAt`, per model. */
function clockFields(): { nowDefault: Map<string, string[]>; updatedAt: Map<string, string[]>; relations: Map<string, Map<string, string>> } {
  const nowDefault = new Map<string, string[]>()
  const updatedAt = new Map<string, string[]>()
  const relations = new Map<string, Map<string, string>>()
  for (const m of Prisma.dmmf.datamodel.models) {
    const d: string[] = []
    const u: string[] = []
    const rel = new Map<string, string>()
    for (const f of m.fields) {
      const def = f.default as { name?: string } | undefined
      if (f.type === 'DateTime' && def && typeof def === 'object' && def.name === 'now') d.push(f.name)
      if (f.isUpdatedAt) u.push(f.name)
      if (f.kind === 'object') rel.set(f.name, f.type)
    }
    nowDefault.set(m.name, d)
    updatedAt.set(m.name, u)
    relations.set(m.name, rel)
  }
  return { nowDefault, updatedAt, relations }
}

function installClockMiddleware(base: PrismaClient): void {
  const { nowDefault, updatedAt, relations } = clockFields()
  const stampCreate = (model: string, data: unknown): void => {
    if (!data || typeof data !== 'object') return
    if (Array.isArray(data)) { for (const d of data) stampCreate(model, d); return }
    const row = data as Record<string, unknown>
    const now = new Date()
    for (const f of [...(nowDefault.get(model) ?? []), ...(updatedAt.get(model) ?? [])]) if (row[f] === undefined) row[f] = now
    walkNested(model, row)
  }
  const stampUpdate = (model: string, data: unknown): void => {
    if (!data || typeof data !== 'object' || Array.isArray(data)) return
    const row = data as Record<string, unknown>
    for (const f of updatedAt.get(model) ?? []) if (row[f] === undefined) row[f] = new Date()
    walkNested(model, row)
  }
  const walkNested = (model: string, row: Record<string, unknown>): void => {
    const rel = relations.get(model)
    if (!rel) return
    for (const [field, target] of rel) {
      const v = row[field] as Record<string, unknown> | undefined
      if (!v || typeof v !== 'object') continue
      if (v['create'] !== undefined) stampCreate(target, v['create'])
      const cm = v['createMany'] as { data?: unknown } | undefined
      if (cm?.data !== undefined) stampCreate(target, cm.data)
      const coc = v['connectOrCreate']
      for (const c of (Array.isArray(coc) ? coc : coc ? [coc] : []) as Array<{ create?: unknown }>) stampCreate(target, c.create)
      const ups = v['upsert']
      for (const u of (Array.isArray(ups) ? ups : ups ? [ups] : []) as Array<{ create?: unknown; update?: unknown }>) {
        stampCreate(target, u.create)
        stampUpdate(target, u.update)
      }
      const upd = v['update']
      for (const u of (Array.isArray(upd) ? upd : upd ? [upd] : []) as Array<{ data?: unknown }>) {
        if (u && typeof u === 'object' && 'data' in u) stampUpdate(target, u.data)
        else stampUpdate(target, u)
      }
      const um = v['updateMany']
      for (const u of (Array.isArray(um) ? um : um ? [um] : []) as Array<{ data?: unknown }>) stampUpdate(target, u?.data)
    }
  }
  ;(base as unknown as { $use: (mw: (p: Prisma.MiddlewareParams, next: (p: Prisma.MiddlewareParams) => Promise<unknown>) => Promise<unknown>) => void }).$use(async (params, next) => {
    const model = params.model
    const args = params.args as Record<string, unknown> | undefined
    if (model && args) {
      switch (params.action) {
        case 'create': stampCreate(model, args['data']); break
        case 'createMany': stampCreate(model, args['data']); break
        case 'upsert': stampCreate(model, args['create']); stampUpdate(model, args['update']); break
        case 'update': case 'updateMany': stampUpdate(model, args['data']); break
        default: break
      }
    }
    return next(params)
  })
}

// ─── The app: every route plugin src/index.ts registers ─────────────────────

const HERE = dirname(fileURLToPath(import.meta.url))
const SRC = resolve(HERE, '../../src')

interface Registration { name: string; prefix: string | null; kind: 'route' | 'connectors' }

/** The /api/v1 registrations of src/index.ts, in order, with where each plugin is imported from. */
export function indexRegistrations(): { regs: Registration[]; importOf: Map<string, { from: string; exported: string }> } {
  const src = readFileSync(resolve(SRC, 'index.ts'), 'utf8')
  const importOf = new Map<string, { from: string; exported: string }>()
  for (const m of src.matchAll(/import\s*\{([^}]*)\}\s*from\s*'(\.\/[^']+)'/g)) {
    for (const part of m[1]!.split(',').map((s) => s.trim()).filter(Boolean)) {
      if (part.startsWith('type ')) continue
      const [exported, local] = part.split(/\s+as\s+/).map((s) => s.trim())
      importOf.set(local ?? exported!, { from: m[2]!, exported: exported! })
    }
  }
  for (const m of src.matchAll(/import\s+(\w+)\s+from\s*'(\.\/[^']+)'/g)) importOf.set(m[1]!, { from: m[2]!, exported: 'default' })
  const start = src.indexOf('// ─── Routes')
  const end = src.indexOf("{ prefix: '/api/v1' }", start)
  if (start < 0 || end < 0) throw new Error('harness: could not find the /api/v1 block in src/index.ts — update tests/sim/harness.ts')
  const block = src.slice(start, end)
  const regs: Registration[] = []
  for (const m of block.matchAll(/await\s+api\.register\(\s*(\w+)\s*,\s*\{\s*prefix:\s*'([^']*)'\s*\}\s*\)|await\s+(registerConnectorPlugins)\(\s*api\s*\)/g)) {
    if (m[3]) regs.push({ name: m[3], prefix: null, kind: 'connectors' })
    else regs.push({ name: m[1]!, prefix: m[2]!, kind: 'route' })
  }
  if (regs.length < 80) throw new Error(`harness: only ${regs.length} route registrations parsed from src/index.ts — the parser needs updating`)
  return { regs, importOf }
}

export async function buildSimApp(): Promise<FastifyInstance> {
  const { AppError, errorResponse } = await import('../../src/lib/errors.js')
  const { runWithRlsContext } = await import('../../src/lib/rlsContext.js')
  const { registerEmptyJsonBody } = await import('../../src/lib/jsonBody.js')
  const { registerBrandScope } = await import('../../src/lib/brandScope.js')
  const { regs, importOf } = indexRegistrations()

  const app = Fastify({ bodyLimit: 30 * 1024 * 1024 })
  app.addHook('onRequest', (_req, _reply, done) => { runWithRlsContext({}, () => done()) })
  registerEmptyJsonBody(app)
  registerBrandScope(app)
  // The production handler's shape (src/index.ts), minus logging.
  app.setErrorHandler((err: unknown, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send(errorResponse(err))
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', message: 'Validation failed', details: err.issues } })
    const e = err as { validation?: unknown; statusCode?: number; code?: string; message?: string }
    if (e?.validation) return reply.status(422).send({ error: { code: 'VALIDATION_ERROR', message: 'Validation failed', details: e.validation } })
    const status = typeof e?.statusCode === 'number' ? e.statusCode : 0
    if (status >= 400 && status < 500) return reply.status(status).send({ error: { code: e.code ?? 'BAD_REQUEST', message: e.message ?? 'Request rejected' } })
    // A 500 keeps its message here (production hides it) — the sim needs to see it.
    return reply.status(500).send({ error: { code: 'INTERNAL_ERROR', message: (err as Error)?.message ?? String(err), stack: (err as Error)?.stack?.split('\n').slice(0, 6) } })
  })

  const modCache = new Map<string, Record<string, unknown>>()
  const load = async (name: string): Promise<unknown> => {
    const imp = importOf.get(name)
    if (!imp) throw new Error(`harness: ${name} is registered in src/index.ts but its import was not found`)
    const path = resolve(SRC, imp.from.replace(/\.js$/, '.ts'))
    let mod = modCache.get(path)
    if (!mod) { mod = (await import(path)) as Record<string, unknown>; modCache.set(path, mod) }
    const fn = mod[imp.exported]
    if (typeof fn !== 'function') throw new Error(`harness: ${imp.exported} from ${imp.from} is not a function`)
    return fn
  }
  await app.register(async (api) => {
    for (const r of regs) {
      const plugin = await load(r.name)
      if (r.kind === 'connectors') await (plugin as (a: FastifyInstance) => Promise<void>)(api)
      else await api.register(plugin as Parameters<FastifyInstance['register']>[0], { prefix: r.prefix! })
    }
  }, { prefix: '/api/v1' })
  await app.ready()
  return app
}

// ─── World ──────────────────────────────────────────────────────────────────

export interface SimUser { id: string; name: string; email: string; role: UserRole; tenantId: string }
export interface SimItem { id: string; name: string; priceCents: number }
export interface SimBrand {
  /** A: Simmer (SRB, 'simmer') + Flipd (FBR, 'flipd'); B: Stackd (SRB, 'stackd') + Viva Grill (FBR, 'viva-grill'). */
  id: string; slug: string; name: string; authority: 'srb' | 'fbr'; province: string
  items: { main: SimItem; side: SimItem; drink: SimItem; dessert: SimItem }
}
export interface SimBank { id: string; code: string; name: string }
export interface SimCompany {
  key: 'A' | 'B'
  tenantId: string
  name: string
  brands: { srb: SimBrand; fbr: SimBrand }
  banks: { main: SimBank; second: SimBank }
  /** The Raast receiving account (the second bank). */
  raast: SimBank
  locationId: string
  riderId: string
  finance: SimUser
  manager: SimUser
  cashier: SimUser
  cashier2: SimUser
}

export const SIM_PIN = { A: '482175', B: '739526' } as const
export const MDR_BPS = 200
export const FEE_TAX_BPS = 1600

export interface Caller {
  get(path: string): Promise<LightMyRequestResponse>
  post(path: string, body?: unknown): Promise<LightMyRequestResponse>
  put(path: string, body?: unknown): Promise<LightMyRequestResponse>
  patch(path: string, body?: unknown): Promise<LightMyRequestResponse>
  del(path: string, body?: unknown): Promise<LightMyRequestResponse>
}

export interface Sim {
  app: FastifyInstance
  prisma: PrismaClient
  clock: SimClock
  A: SimCompany
  B: SimCompany
  ceo: SimUser
  as(user: SimUser, company?: SimCompany): Caller
  /** A customer of the storefront (a customer session token, as sign-in issues it). */
  asCustomer(customerId: string): Caller
  /** A rider of the rider app (issueRiderSession). */
  asRider(riderId: string): Caller
  /** A storefront customer with a verified phone (seeded: sign-up needs a WhatsApp code). */
  mkCustomer(name: string, phone: string): Promise<string>
  ledger: Ledger
  settle(quietMs?: number): Promise<void>
  waitFor(fn: () => Promise<boolean>, opts?: { timeoutMs?: number; label?: string }): Promise<void>
  close(): Promise<void>
}

/** Assert a status (the body is the failure message) and return the JSON body. */
export function ok<T = any>(res: LightMyRequestResponse, status: number | number[] = [200, 201]): T {
  const want = Array.isArray(status) ? status : [status]
  expect(want, `${res.statusCode} ${res.body.slice(0, 1500)}`).toContain(res.statusCode)
  return (res.body ? res.json() : null) as T
}
export const errCode = (res: LightMyRequestResponse): string | undefined => {
  try { return res.json()?.error?.code } catch { return undefined }
}

/** A tiny valid PDF as an upload ({ fileName, mime, dataBase64 }) — for deposit slips and record files. */
export function pdfFile(fileName = 'slip.pdf'): { fileName: string; mime: string; dataBase64: string } {
  const pdf = `%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Count 0/Kids[]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n`
  return { fileName, mime: 'application/pdf', dataBase64: Buffer.from(pdf).toString('base64') }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export async function startSim(): Promise<Sim> {
  if (clockInstalled) throw new Error('startSim: one simulation per test file')
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(WORLD_BUILT_AT))
  clockInstalled = true
  const clock = makeClock()

  const { serviceClient: prisma } = await import('../../src/lib/prisma.js')
  const base = (globalThis as unknown as { basePrisma?: PrismaClient }).basePrisma
  if (!base) throw new Error('harness: lib/prisma.ts did not expose its base client on globalThis (NODE_ENV must not be production)')
  installClockMiddleware(base)

  // Nothing leaves the box: the fiscal POS is never kicked.
  const { setFiscalKicker } = await import('../../src/connectors/fiscal/outbox.js')
  setFiscalKicker(async () => {})

  const app = await buildSimApp()
  const { issueStaffSession } = await import('../../src/modules/auth/service.js')

  const tokenOf = (u: SimUser): string => (issueStaffSession({ id: u.id, name: u.name, email: u.email, role: u.role }) as { accessToken: string }).accessToken
  const as = (user: SimUser, company?: SimCompany): Caller => {
    const send = (method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE') => async (path: string, body?: unknown) => {
      clock.tick(1_000)
      return app.inject({
        method,
        url: `/api/v1${path}`,
        headers: {
          authorization: `Bearer ${tokenOf(user)}`,
          ...(company ? { 'x-servd-active-tenant': company.tenantId } : {}),
        },
        ...(body !== undefined ? { payload: body as Record<string, unknown> } : {}),
      })
    }
    return { get: send('GET'), post: send('POST'), put: send('PUT'), patch: send('PATCH'), del: send('DELETE') }
  }

  const raw = (tokenOf2: () => string): Caller => {
    const send = (method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE') => async (path: string, body?: unknown) => {
      clock.tick(1_000)
      return app.inject({
        method, url: `/api/v1${path}`, headers: { authorization: `Bearer ${tokenOf2()}` },
        ...(body !== undefined ? { payload: body as Record<string, unknown> } : {}),
      })
    }
    return { get: send('GET'), post: send('POST'), put: send('PUT'), patch: send('PATCH'), del: send('DELETE') }
  }
  const jwt = (await import('jsonwebtoken')).default
  const asCustomer = (customerId: string): Caller =>
    raw(() => jwt.sign({ sub: customerId, type: 'customer' }, process.env['JWT_SECRET']!, { expiresIn: '14d' }))
  const { issueRiderSession } = await import('../../src/modules/riderAuth/service.js')
  const asRider = (riderId: string): Caller => raw(() => issueRiderSession({ id: riderId }).accessToken)
  const mkCustomer = async (name: string, phone: string): Promise<string> =>
    (await prisma.customer.create({ data: { name, phone, phoneVerifiedAt: new Date(), email: `${phone}@sim.customer.test` } })).id

  const settle = async (quietMs = 250): Promise<void> => {
    // Fire-and-forget work (postShiftClose, completion effects) writes journal
    // entries / flags shortly after the response. Wait until the counts are
    // still for `quietMs` (real time).
    let last = -1
    for (let i = 0; i < 80; i++) {
      const n = (await prisma.journalEntry.count()) + (await prisma.exceptionFlag.count()) + (await prisma.fiscalDocument.count())
      if (n === last) return
      last = n
      await sleep(quietMs)
    }
  }
  const waitFor = async (fn: () => Promise<boolean>, opts: { timeoutMs?: number; label?: string } = {}): Promise<void> => {
    const until = performance.now() + (opts.timeoutMs ?? 10_000)
    while (performance.now() < until) {
      if (await fn()) return
      await sleep(50)
    }
    throw new Error(`waitFor timed out${opts.label ? `: ${opts.label}` : ''}`)
  }

  const world = await buildWorld(prisma, as)
  const ledger = makeLedger(prisma)
  return {
    app, prisma, clock, ...world, as, asCustomer, asRider, mkCustomer, ledger, settle, waitFor,
    close: async () => {
      setFiscalKicker(null)
      await app.close()
      vi.useRealTimers()
      clockInstalled = false
    },
  }
}

async function buildWorld(prisma: PrismaClient, as: Sim['as']): Promise<{ A: SimCompany; B: SimCompany; ceo: SimUser }> {
  const { ensureChartOfAccounts } = await import('../../src/lib/chartOfAccounts.js')
  const { setManagerPin } = await import('../../src/modules/auth/managerPin.js')
  const password = await bcrypt.hash('Sim-Password-1', 4)

  const mkUser = async (name: string, role: UserRole, tenantIds: string[]): Promise<SimUser> => {
    const email = `${name.toLowerCase().replace(/[^a-z0-9]+/g, '.')}@sim.gsfoods.test`
    const u = await prisma.user.create({
      data: {
        name, email, password, role, isActive: true, accountStatus: 'active', tenantId: tenantIds[0]!,
        tenantMemberships: { create: tenantIds.map((t) => ({ tenant: { connect: { id: t } }, role: role === 'admin' ? 'admin' : 'manager' })) },
      },
    })
    return { id: u.id, name, email, role, tenantId: tenantIds[0]! }
  }

  // Companies: A is 'GS Foods' (procurement's company-less supplier rule looks for it by name).
  const tA = await prisma.tenant.create({ data: { name: 'GS Foods', slug: 'sim-gs-foods', kind: 'company' } })
  const tB = await prisma.tenant.create({ data: { name: 'GS x Viva', slug: 'sim-gs-viva', kind: 'company' } })
  for (const t of [tA, tB]) await ensureChartOfAccounts(t.id)
  const ceo = await mkUser('Ammar CEO', 'admin', [tA.id, tB.id])

  const mkCompany = async (key: 'A' | 'B', tenantId: string, name: string): Promise<SimCompany> => {
    const k = key.toLowerCase()
    const locationId = (await prisma.location.create({ data: { slug: `sim-outlet-${k}`, name: `${name} Clifton`, tenantId, latitude: 24.8138, longitude: 67.0300, fenceLatitude: 24.8138, fenceLongitude: 67.0300 } })).id
    const mkBrand = async (authority: 'srb' | 'fbr', bname: string, prices: [number, number, number, number]): Promise<SimBrand> => {
      // Real brand slugs where servd has them: the legacy brands keep their codes
      // (accounting/journal.ts CONCEPT_REVENUE_CODE — simmer 4001, stackd 4002, flipd 4004);
      // 'viva-grill' gets its own "Sales — Viva Grill" account (brandRevenueAccount.ts).
      const slug = bname.toLowerCase().replace(/[^a-z0-9]+/g, '-')
      const province = authority === 'srb' ? 'SD' : 'ICT'
      const concept = await prisma.concept.create({
        data: {
          name: bname, slug, type: 'restaurant', tenantId, taxRateCash: 15, taxRateCard: 8, province,
          ntn: '1234567-8', strn: '3277876123456', invoiceLegalName: `${name} (Pvt) Ltd`,
          ...(authority === 'srb' ? { srbPosId: key === 'A' ? 811001 : 822001 } : { fbrPosId: key === 'A' ? 911001 : 922001 }),
          serviceVessel: 'plate', isActive: true, latitude: 24.8138, longitude: 67.0300,
        },
      })
      // One sales account per brand (2026-10-17) — what POST /concepts and the boot step do.
      const { ensureBrandRevenueAccount } = await import('../../src/modules/accounting/brandRevenueAccount.js')
      await ensureBrandRevenueAccount(concept.id)
      await prisma.conceptLocation.create({ data: { conceptId: concept.id, locationId, isPrimary: true } })
      const cat = await prisma.category.create({ data: { conceptId: concept.id, name: 'Menu' } })
      const item = async (n: string, priceCents: number): Promise<SimItem> =>
        ({ id: (await prisma.menuItem.create({ data: { conceptId: concept.id, categoryId: cat.id, name: n, priceCents } })).id, name: n, priceCents })
      return {
        id: concept.id, slug, name: bname, authority, province,
        items: {
          main: await item(`${bname} Main`, prices[0]),
          side: await item(`${bname} Side`, prices[1]),
          drink: await item(`${bname} Drink`, prices[2]),
          dessert: await item(`${bname} Dessert`, prices[3]),
        },
      }
    }
    const srb = await mkBrand('srb', key === 'A' ? 'Simmer' : 'Stackd', [180_000, 60_000, 35_000, 50_000])
    const fbr = await mkBrand('fbr', key === 'A' ? 'Flipd' : 'Viva Grill', [150_000, 45_000, 30_000, 40_000])
    const riderId = (await prisma.rider.create({ data: { name: `Rider ${key}`, phone: key === 'A' ? '923001110001' : '923001110002', tenantId, status: 'available' } })).id
    const finance = await mkUser(`Hasnain Finance ${key}`, 'finance', [tenantId])
    const manager = await mkUser(`Manager ${key}`, 'fnb_manager', [tenantId])
    const cashier = await mkUser(`Cashier ${key}1`, 'cashier', [tenantId])
    const cashier2 = await mkUser(`Cashier ${key}2`, 'cashier', [tenantId])
    await setManagerPin(manager.id, SIM_PIN[key])
    return {
      key, tenantId, name, brands: { srb, fbr }, locationId, riderId, finance, manager, cashier, cashier2,
      banks: undefined as unknown as SimCompany['banks'], raast: undefined as unknown as SimBank,
    }
  }
  const A = await mkCompany('A', tA.id, tA.name)
  const B = await mkCompany('B', tB.id, tB.name)

  // ── Through the API ──
  for (const co of [A, B]) {
    const fin = as(co.finance, co)
    const main = ok(await fin.post('/setup/bank-accounts', { name: `${co.name} — HBL current`, bankName: 'HBL', accountTitle: co.name, accountNumber: `0011${co.key === 'A' ? '1' : '2'}2233445` }), 201)
    const second = ok(await fin.post('/setup/bank-accounts', { name: `${co.name} — Meezan collections`, bankName: 'Meezan', accountTitle: co.name, accountNumber: `0101${co.key === 'A' ? '1' : '2'}9988776` }), 201)
    co.banks = { main: { id: main.id, code: main.accountCode, name: main.name }, second: { id: second.id, code: second.accountCode, name: second.name } }
    // The Raast id (the bank's own merchant setting) is not on the bank-account form: set as the bank gives it.
    await prisma.bankAccount.update({ where: { id: second.id }, data: { raastId: co.key === 'A' ? '03001234567' : '03007654321' } })
    co.raast = co.banks.second
    ok(await fin.put('/setup/raast-accounts', { brands: [co.brands.srb, co.brands.fbr].map((b) => ({ conceptId: b.id, bankAccountId: second.id })) }), 200)
    ok(await fin.put('/reconciliation/card-payouts/settings', {
      enabled: true, payoutBankAccountId: main.id, mdrBps: MDR_BPS, feeTaxBps: FEE_TAX_BPS, startDay: '2026-09-30', lagDays: 1,
    }), 200)
    const ceoHere = as(ceo, co)
    ok(await ceoHere.put('/accounting/night-audit/settings', { startDay: '2026-10-01', reason: 'Night audit live from day one of the simulated month' }), 200)
    ok(await ceoHere.put('/emergency-overrides/settings', { tenantId: co.tenantId, codeOnly: co.key === 'A', reason: 'Simulation: code-only delivery in A, off in B' }), 200)
    ok(await ceoHere.patch('/setup/operations-config', { serviceChargePct: 0.05, serviceChargeAppliesToChannels: ['pos'] }), 200)
    // Storefront: open 09:00–23:59 every day; one delivery zone (PKR 150 fee) for every brand.
    const mgr = as(co.manager, co)
    for (const b of [co.brands.srb, co.brands.fbr]) {
      ok(await mgr.put(`/setup/hours/${b.id}`, { hours: [0, 1, 2, 3, 4, 5, 6].map((dayOfWeek) => ({ dayOfWeek, openMin: 9 * 60, closeMin: 1439 })) }), 200)
    }
    ok(await mgr.post('/setup/delivery-zones', { conceptId: null, name: 'Clifton', radiusKmMin: 0, radiusKmMax: 50, feeCents: 15_000, minOrderCents: 0, estimatedMinutes: 40 }), 201)
  }
  // Withholding in A (H32 / H47): confirmed rates, then switched on by finance.
  const finA = as(A.finance, A)
  ok(await finA.put('/accounting/withholding/rates', { rates: {
    '153_1_a': { filerBps: 100, nonFilerBps: 200 },
    '153_1_b': { filerBps: 1100, nonFilerBps: 2200 },
    '153_1_c': { filerBps: 600, nonFilerBps: 1200 },
    '155': { filerBps: 1500, nonFilerBps: 3000 },
  } }), 200)
  ok(await finA.put('/accounting/withholding/enabled', { enabled: true, reason: 'Confirmed by the accountant for the simulated month' }), 200)
  return { A, B, ceo }
}

// ─── Ledger helpers ─────────────────────────────────────────────────────────

export interface Ledger {
  balanceOf(co: SimCompany, code: string, asOf?: string | Date): Promise<number>
  balances(co: SimCompany, asOf?: string | Date): Promise<Map<string, number>>
  trialBalance(co: SimCompany, asOf?: string | Date): Promise<{ rows: Array<{ code: string; name: string; debitCents: number; creditCents: number }>; debitCents: number; creditCents: number }>
  assertBalanced(co: SimCompany): Promise<void>
  entriesBySource(co: SimCompany, prefix: string): Promise<Array<{ id: string; reference: string | null; entryDate: Date; lines: Array<{ code: string; type: 'debit' | 'credit'; cents: number; conceptId: string | null; memo: string | null }> }>>
  openFlags(co: SimCompany, kind?: string): Promise<Array<{ id: string; kind: string; title: string; entityType: string | null; entityId: string | null; metadata: unknown }>>
}

const endOf = (asOf?: string | Date): Date =>
  asOf === undefined ? new Date() : typeof asOf === 'string' ? new Date(`${asOf}T23:59:59.999+05:00`) : asOf

function makeLedger(prisma: PrismaClient): Ledger {
  const balances = async (co: SimCompany, asOf?: string | Date): Promise<Map<string, number>> => {
    const rows = await prisma.$queryRaw<Array<{ code: string; bal: bigint | number | string }>>`
      SELECT a.code, SUM(CASE WHEN l.type = 'debit' THEN l."amountCents" ELSE -l."amountCents" END)::bigint AS bal
        FROM journal_lines l
        JOIN journal_entries e ON e.id = l."journalEntryId"
        JOIN accounts a ON a.id = l."accountId"
       WHERE e."tenantId" = ${co.tenantId} AND e."entryDate" <= ${endOf(asOf)}
       GROUP BY a.code`
    return new Map(rows.map((r) => [r.code, Number(r.bal)]))
  }
  return {
    balances,
    balanceOf: async (co, code, asOf) => (await balances(co, asOf)).get(code) ?? 0,
    trialBalance: async (co, asOf) => {
      const { trialBalance } = await import('../../src/modules/accounting/reports.js')
      const r = await trialBalance([co.tenantId], endOf(asOf)) as unknown as {
        rows: Array<{ code: string; name: string; debitCents: number; creditCents: number }>
        totals?: { debitCents: number; creditCents: number }
      }
      const debitCents = r.rows.reduce((t, x) => t + Number(x.debitCents), 0)
      const creditCents = r.rows.reduce((t, x) => t + Number(x.creditCents), 0)
      return { rows: r.rows, debitCents, creditCents }
    },
    assertBalanced: async (co) => {
      const bad = await prisma.$queryRaw<Array<{ id: string; reference: string | null; dr: bigint; cr: bigint }>>`
        SELECT e.id, e.reference,
               SUM(CASE WHEN l.type = 'debit' THEN l."amountCents" ELSE 0 END)::bigint AS dr,
               SUM(CASE WHEN l.type = 'credit' THEN l."amountCents" ELSE 0 END)::bigint AS cr
          FROM journal_entries e JOIN journal_lines l ON l."journalEntryId" = e.id
         WHERE e."tenantId" = ${co.tenantId}
         GROUP BY e.id, e.reference
        HAVING SUM(CASE WHEN l.type = 'debit' THEN l."amountCents" ELSE -l."amountCents" END) <> 0`
      expect(bad.map((b) => `${b.reference} dr ${b.dr} cr ${b.cr}`), `unbalanced entries in ${co.name}`).toEqual([])
      const foreign = await prisma.$queryRaw<Array<{ n: bigint }>>`
        SELECT COUNT(*)::bigint AS n FROM journal_lines l
          JOIN journal_entries e ON e.id = l."journalEntryId" JOIN accounts a ON a.id = l."accountId"
         WHERE e."tenantId" = ${co.tenantId} AND a."tenantId" IS DISTINCT FROM ${co.tenantId}`
      expect(Number(foreign[0]!.n), `${co.name} entries posting to another company's chart`).toBe(0)
      const all = await balances(co)
      let sum = 0
      for (const v of all.values()) sum += v
      expect(sum, `${co.name} trial balance does not balance`).toBe(0)
    },
    entriesBySource: async (co, prefix) => {
      const rows = await prisma.journalEntry.findMany({
        where: { tenantId: co.tenantId, reference: { startsWith: prefix } },
        include: { lines: { include: { account: { select: { code: true } } } } },
        orderBy: { entryDate: 'asc' },
      })
      return rows.map((e) => ({
        id: e.id, reference: e.reference, entryDate: e.entryDate,
        lines: e.lines.map((l) => ({ code: l.account.code, type: l.type as 'debit' | 'credit', cents: Number(l.amountCents), conceptId: l.conceptId, memo: l.memo })),
      }))
    },
    openFlags: async (co, kind) => prisma.exceptionFlag.findMany({
      where: { tenantId: co.tenantId, status: 'open', ...(kind ? { kind } : {}) },
      select: { id: true, kind: true, title: true, entityType: true, entityId: true, metadata: true },
    }),
  }
}
