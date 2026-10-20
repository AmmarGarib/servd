// POS connector — settings schemas, the SSRF guard and the per-company
// "fiscal reporting required" switch (spec §3 settings, §5 transport, §8.1,
// §17.7).
//
// Settings live in PosConnector.settings (JSON). They are always read through
// parseFiscalSettings / parseTerminalSettings, which apply the defaults and
// clamp to the documented ranges, so a hand-edited or older row can never hand
// a driver an out-of-range value.

import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import { z } from 'zod'
import type { Prisma } from '@prisma/client'
import { prisma } from '../lib/prisma.js'
import { AppError } from '../lib/errors.js'
import type { FiscalSettings, RaastSettings, TerminalSettings } from './types.js'

type Db = Prisma.TransactionClient | typeof prisma

export const AUTHORITIES = ['fbr', 'srb', 'pra', 'kpra', 'bra'] as const

const pathSchema = z.string().trim().min(1).max(200).regex(/^\/[A-Za-z0-9._~/{}-]*$/, 'a path starting with /')
const headerName = z.string().trim().min(1).max(64).regex(/^[A-Za-z0-9-]+$/, 'an HTTP header name')

export const fiscalOutletSchema = z.object({
  locationId: z.string().min(1).max(64),
  conceptId: z.string().min(1).max(64).nullable(),
  authority: z.enum(AUTHORITIES),
  posId: z.string().trim().min(1).max(64),
  storeId: z.string().trim().min(1).max(64).optional(),
})

export const fiscalSettingsSchema = z.object({
  syncTimeoutMs: z.number().int().min(500).max(5000).default(3000),
  syncAtTill: z.boolean().default(true),
  fileZeroValue: z.boolean().default(true),
  maxAgeHours: z.number().int().min(1).max(168).default(72),
  outlets: z.array(fiscalOutletSchema).max(200).default([]),
  apiKeyHeader: headerName.optional(),
  paths: z.object({ sales: pathSchema, refunds: pathSchema, documents: pathSchema, health: pathSchema }).partial().optional(),
  test: z.object({
    scenario: z.enum(['ok', 'slow', 'down', 'reject', 'auth', 'processing_then_ok', 'unknown_then_filed']),
    // Keenu bill push (till flow, 2026-10-20): what the test POS does with a pushed bill. Default 'settle'.
    push: z.enum(['settle', 'decline', 'pending']).optional(),
  }).optional(),
})

export const terminalEntrySchema = z.object({
  id: z.string().min(1).max(64),
  label: z.string().trim().min(1).max(80),
  locationId: z.string().min(1).max(64),
  terminalId: z.string().trim().min(1).max(64),
  active: z.boolean().default(true),
})

export const terminalSettingsSchema = z.object({
  chargeTimeoutSec: z.number().int().min(45).max(300).default(120),
  pollMs: z.number().int().min(1000).max(5000).default(1500),
  allowManualRef: z.boolean().default(true),
  terminals: z.array(terminalEntrySchema).max(100).default([]),
  apiKeyHeader: headerName.optional(),
  paths: z.object({ charges: pathSchema, refunds: pathSchema, health: pathSchema }).partial().optional(),
  test: z.object({
    scenario: z.enum(['approve', 'decline', 'never', 'unknown_start', 'late_approve', 'void_fails', 'offline', 'by_amount']),
  }).optional(),
})

/**
 * What PosConnector(fiscal).settings holds: the driver settings plus the
 * company-level `fiscalReportingRequired` switch (§17.7). The switch is kept
 * out of FiscalSettings (the frozen driver contract) because no driver reads
 * it — it decides whether a FiscalDocument exists at all.
 */
export type StoredFiscalSettings = FiscalSettings & { fiscalReportingRequired?: boolean }

export const DEFAULT_FISCAL_SETTINGS: FiscalSettings = fiscalSettingsSchema.parse({})
export const DEFAULT_TERMINAL_SETTINGS: TerminalSettings = terminalSettingsSchema.parse({})

function asObject(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
}

/** Lenient read of stored settings: a field that fails validation falls back to its default. */
function lenient<S extends z.ZodObject<z.ZodRawShape>>(schema: S, raw: unknown): z.infer<S> {
  const obj = asObject(raw)
  const full = schema.safeParse(obj)
  if (full.success) return full.data
  const kept: Record<string, unknown> = {}
  const shape: z.ZodRawShape = schema.shape
  for (const [key, field] of Object.entries(shape)) {
    if (!(key in obj)) continue
    const one = field.safeParse(obj[key])
    if (one.success && one.data !== undefined) kept[key] = one.data
  }
  return schema.parse(kept)
}

export function parseFiscalSettings(raw: unknown): FiscalSettings {
  return lenient(fiscalSettingsSchema, raw)
}

export function parseTerminalSettings(raw: unknown): TerminalSettings {
  return lenient(terminalSettingsSchema, raw)
}

// ─── Raast QR bank alerts (2026-10-12, spec §6.1) ─────────────────────────────
// PosConnector(kind 'raast').settings. `enabled` on the row = bank-SMS
// matching ON (the CEO switches it on after a readiness check). A template is
// servd's own DSL (connectors/raast/sms.ts compileTemplate), never a user
// regex.

export const RAAST_IGNORE_KEYWORDS = ['OTP', 'one time', 'one-time', 'password', 'PIN', 'verification code']

export const raastSenderSchema = z.object({
  id: z.string().min(1).max(64),
  senderId: z.string().trim().min(2).max(40),
  bankAccountId: z.string().min(1).max(64),
  accountLast4: z.string().regex(/^[0-9]{4}$/, '4 digits').optional(),
  templateIds: z.array(z.string().min(1).max(64)).min(1).max(10),
  active: z.boolean().default(true),
})

export const raastTemplateSchema = z.object({
  id: z.string().min(1).max(64),
  label: z.string().trim().min(1).max(80),
  kind: z.enum(['credit', 'debit']),
  template: z.string().min(1).max(500),
  dateFormat: z.string().trim().min(1).max(20).optional(),
  timeFormat: z.string().trim().min(1).max(20).optional(),
  active: z.boolean().default(true),
})

export const raastSettingsSchema = z.object({
  matchWindowMin: z.number().int().min(2).max(60).default(10),
  intentTtlMin: z.number().int().min(5).max(120).default(30),
  clockSkewMin: z.number().int().min(0).max(10).default(2),
  smsConfirmMin: z.number().int().min(5).max(240).default(30),
  unmatchedAlertEscalateMin: z.number().int().min(15).max(1440).default(120),
  statementMatchDays: z.number().int().min(1).max(10).default(3),
  provisionalFlagDays: z.number().int().min(1).max(30).default(3),
  refMinLength: z.number().int().min(4).max(20).default(6),
  refMaxLength: z.number().int().min(8).max(64).default(35),
  ignoreKeywords: z.array(z.string().trim().min(1).max(40)).max(30).default(RAAST_IGNORE_KEYWORDS),
  senders: z.array(raastSenderSchema).max(20).default([]),
  templates: z.array(raastTemplateSchema).max(50).default([]),
})

export const DEFAULT_RAAST_SETTINGS: RaastSettings = raastSettingsSchema.parse({})

/**
 * Lenient read of the stored Raast settings: scalar fields fall back to their
 * default one by one, and a sender / template entry that no longer validates
 * is dropped on its own (never the whole list — one bad entry must not switch
 * every bank's matching off).
 */
export function parseRaastSettings(raw: unknown): RaastSettings {
  const obj = asObject(raw)
  const { senders, templates, ...rest } = obj
  const base = lenient(raastSettingsSchema.omit({ senders: true, templates: true }), rest)
  const keep = <T>(schema: z.ZodType<T>, list: unknown, max: number): T[] => {
    if (!Array.isArray(list)) return []
    const out: T[] = []
    for (const item of list) {
      const one = schema.safeParse(item)
      if (one.success) out.push(one.data)
      if (out.length >= max) break
    }
    return out
  }
  return {
    ...base,
    senders: keep(raastSenderSchema, senders, 20) as RaastSettings['senders'],
    templates: keep(raastTemplateSchema, templates, 50) as RaastSettings['templates'],
  }
}

/** The company switch from a stored fiscal settings blob (default TRUE). */
export function reportingRequiredOf(raw: unknown): boolean {
  const v = asObject(raw)['fiscalReportingRequired']
  return v === false ? false : true
}

/**
 * When "Fiscal reporting required" was last switched ON after being off
 * (`settings.reportingRequiredSince`, ISO time, written by
 * setFiscalReportingRequired — e.g. a test company made real). Null for a
 * company that has always reported (the default): nothing changes for it.
 */
export function reportingRequiredSinceOf(raw: unknown): Date | null {
  const v = asObject(raw)['reportingRequiredSince']
  if (typeof v !== 'string') return null
  const d = new Date(v)
  return Number.isNaN(d.getTime()) ? null : d
}

/**
 * THE rule for "should this sale be filed?" (fr-2): reporting is required
 * now, the company is not a test company, and the sale was completed while
 * reporting was required — never a sale completed before
 * `reportingRequiredSince` (a test company's past sales are never filed, by
 * any path: live completion, the recovery sweep, the legacy drain, a refund
 * with no sale document). `completedAt` null = completing now.
 */
export function saleFileable(settings: unknown, opts: { hasRow: boolean; isTest: boolean; completedAt: Date | null }): boolean {
  if (opts.isTest) return false
  if (!opts.hasRow) return true
  if (!reportingRequiredOf(settings)) return false
  const since = reportingRequiredSinceOf(settings)
  return !since || !opts.completedAt || opts.completedAt >= since
}

/**
 * §17.7 — does this company file its sales with the fiscal POS at all?
 * Default TRUE. FALSE only for a company the CEO marked non-commercial / test
 * (a test company, the owner's home kitchen): its completions create no
 * FiscalDocument, so there is no held backlog, no /health warning and no
 * alert. The terminal connector is independent of this. Read inside the
 * caller's transaction when one is passed.
 */
export async function fiscalReportingRequired(tenantId: string, db: Db = prisma): Promise<boolean> {
  const row = await db.posConnector.findUnique({
    where: { tenantId_kind: { tenantId, kind: 'fiscal' } },
    select: { settings: true },
  })
  return row ? reportingRequiredOf(row.settings) : true
}

// ─── SSRF guard (spec §5) ─────────────────────────────────────────────────────

/** True for loopback, private, link-local, CGNAT, multicast, unspecified and other non-public ranges. */
export function isPrivateAddress(ip: string): boolean {
  const v = isIP(ip)
  if (v === 4) {
    const [a, b] = ip.split('.').map(Number) as [number, number, number, number]
    if (a === 0 || a === 10 || a === 127) return true
    if (a === 169 && b === 254) return true
    if (a === 172 && b >= 16 && b <= 31) return true
    if (a === 192 && b === 168) return true
    if (a === 100 && b >= 64 && b <= 127) return true // CGNAT
    if (a === 192 && b === 0) return true
    if (a === 198 && (b === 18 || b === 19)) return true
    if (a >= 224) return true // multicast + reserved + broadcast
    return false
  }
  if (v === 6) {
    // W1-R3: judged on the 16 bytes, never on the spelling — WHATWG URL
    // rewrites [::ffff:127.0.0.1] as [::ffff:7f00:1], which a text match misses.
    const b = ipv6Bytes(ip)
    if (!b) return true
    const zero = (from: number, to: number) => b.slice(from, to).every((x) => x === 0)
    const v4 = (at: number) => `${b[at]}.${b[at + 1]}.${b[at + 2]}.${b[at + 3]}`
    if (zero(0, 16)) return true                                              // ::/128 unspecified
    if (zero(0, 15) && b[15] === 1) return true                               // ::1 loopback
    if (zero(0, 10) && b[10] === 0xff && b[11] === 0xff) return isPrivateAddress(v4(12)) // ::ffff:0:0/96 IPv4-mapped
    if (zero(0, 12)) return true                                              // ::/96 IPv4-compatible (deprecated) — never a vendor
    if (b[0] === 0x00 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b && zero(4, 12)) return isPrivateAddress(v4(12)) // 64:ff9b::/96 NAT64
    if (b[0] === 0x00 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b && b[4] === 0x00 && b[5] === 0x01) return true // 64:ff9b:1::/48 local NAT64
    if (b[0] === 0x20 && b[1] === 0x02) return isPrivateAddress(v4(2))       // 2002::/16 6to4
    if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0x00 && b[3] === 0x00) return true // 2001::/32 Teredo (embeds an obfuscated IPv4)
    if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0x0d && b[3] === 0xb8) return true // 2001:db8::/32 documentation
    if (b[0] === 0x01 && zero(1, 8)) return true                              // 100::/64 discard
    if (b[0] === 0xfe && (b[1]! & 0xc0) === 0x80) return true                 // fe80::/10 link-local
    if (b[0] === 0xfe && (b[1]! & 0xc0) === 0xc0) return true                 // fec0::/10 site-local (deprecated)
    if ((b[0]! & 0xfe) === 0xfc) return true                                  // fc00::/7 unique local
    if (b[0] === 0xff) return true                                            // ff00::/8 multicast
    return false
  }
  return true
}

/** An IPv6 literal (any spelling, optional zone id, embedded dotted IPv4) as 16 bytes; null when it is not one. */
export function ipv6Bytes(ip: string): number[] | null {
  let s = ip.trim().replace(/^\[|\]$/g, '')
  const zone = s.indexOf('%')
  if (zone >= 0) s = s.slice(0, zone)
  if (isIP(s) !== 6) return null
  const words: number[] = []
  const toWords = (part: string): number[] | null => {
    if (part === '') return []
    const out: number[] = []
    const groups = part.split(':')
    for (let i = 0; i < groups.length; i++) {
      const g = groups[i]!
      if (i === groups.length - 1 && g.includes('.')) {
        if (isIP(g) !== 4) return null
        const [a, b2, c, d] = g.split('.').map(Number) as [number, number, number, number]
        out.push((a << 8) | b2, (c << 8) | d)
      } else {
        if (!/^[0-9a-f]{1,4}$/i.test(g)) return null
        out.push(parseInt(g, 16))
      }
    }
    return out
  }
  const halves = s.split('::')
  if (halves.length > 2) return null
  const head = toWords(halves[0]!)
  const tail = halves.length === 2 ? toWords(halves[1]!) : []
  if (!head || !tail) return null
  const fill = 8 - head.length - tail.length
  if (halves.length === 2 ? fill < 0 : fill !== 0) return null
  words.push(...head, ...new Array<number>(halves.length === 2 ? fill : 0).fill(0), ...tail)
  if (words.length !== 8) return null
  return words.flatMap((w) => [(w >> 8) & 0xff, w & 0xff])
}

/** The host of a URL with IPv6 brackets removed. */
function bareHost(url: URL): string {
  return url.hostname.replace(/^\[|\]$/g, '')
}

/**
 * The http driver's per-call check of the URL it is about to call: an IP
 * literal never goes through the guarded DNS lookup (Node connects to it
 * directly), so an IPv6 literal or a non-public IPv4 literal is refused here.
 */
export function isForbiddenLiteralHost(url: URL): boolean {
  const host = bareHost(url).toLowerCase()
  if (!host || host === 'localhost' || host.endsWith('.localhost')) return true
  const v = isIP(host)
  if (v === 6) return true
  return v === 4 && isPrivateAddress(host)
}

function urlNotAllowed(why: string): AppError {
  return new AppError('URL_NOT_ALLOWED', `That URL can't be used for a connector: ${why}`, 422)
}

/**
 * A connector base URL must be https, carry no credentials, and its host must
 * not be (or resolve to) a private / loopback / link-local address. Returns
 * the normalised URL (no trailing slash). The http driver re-checks the
 * resolved address on every call (DNS can change after the URL was saved).
 */
export async function assertUrlAllowed(raw: string): Promise<string> {
  let url: URL
  try { url = new URL(raw.trim()) } catch { throw urlNotAllowed('not a valid URL') }
  if (url.protocol !== 'https:') throw urlNotAllowed('only https:// is allowed')
  if (url.username || url.password) throw urlNotAllowed('credentials in the URL are not allowed — use the API key field')
  if (url.search || url.hash) throw urlNotAllowed('no query string or fragment')
  const host = bareHost(url)
  if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
    throw urlNotAllowed('the host is not a public address')
  }
  // W1-R3: no IPv6 literal at all — it has too many spellings for an IPv4
  // (mapped, compatible, NAT64, 6to4) and a vendor endpoint has a host name.
  if (isIP(host) === 6) throw urlNotAllowed('use the host name, not an IPv6 address')
  if (isIP(host)) {
    if (isPrivateAddress(host)) throw urlNotAllowed('the host is not a public address')
  } else {
    let addrs: Array<{ address: string }>
    try {
      addrs = await lookup(host, { all: true, verbatim: true })
    } catch {
      throw urlNotAllowed('the host name does not resolve')
    }
    if (addrs.length === 0 || addrs.some((a) => isPrivateAddress(a.address))) {
      throw urlNotAllowed('the host resolves to a non-public address')
    }
  }
  return url.toString().replace(/\/+$/, '')
}
