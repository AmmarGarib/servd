// Bank SMS parsing — pure (no I/O). Spec §6.1–6.2.
//
// A bank's alert format is described by a TEMPLATE in servd's own small
// language, never a user-supplied regex (no ReDoS, nothing to escape):
//
//   "PKR {amount} received from {payer} via Raast. Ref {ref} on {date} {time}.{*}"
//
// Literal text is matched case-insensitively with any run of whitespace
// matching any run of whitespace. Placeholders become bounded sub-patterns:
//   {amount}  123 / 1,234 / 1,234.50 / PKR 1,234 / Rs.1,234/-   (required in every template)
//   {ref}     the transaction ID (letters, digits, - _ . / # :)  (required in credit templates)
//   {date}    12-10-2026, 12/10/26, 12-Oct-2026, 2026-10-12 (dateFormat narrows it)
//   {time}    14:05, 14:05:09, 2:05 PM
//   {account} a masked account like ****1234 or XX-1234 (its last 4 digits)
//   {payer}   up to 60 characters of free text
//   {*}       up to 200 characters of anything (skip a variable tail)
// Each named placeholder may appear once; {*} and {payer} together at most 3
// times. The whole SMS must match (leading/trailing spaces aside) — a partial
// match is not a match ("never guess").
//
// parseSms returns the normalised fields or null; it never throws on input.

import type { RaastTemplate } from '../types.js'
import { INT4_MAX_CENTS } from '../../lib/money.js'
import { normalizeBankRef } from './reference.js'

/** Longest SMS body servd reads (characters). */
export const MAX_SMS_CHARS = 2000

const PKT_OFFSET_MS = 5 * 3_600_000

// ─── Senders and keywords ────────────────────────────────────────────────────

/**
 * Normalise an SMS sender: phone numbers become 92XXXXXXXXXX (from +92…,
 * 0092…, 03…), short codes / alphanumeric ids are upper-cased with
 * punctuation and spaces removed ("HBL-Alert" → "HBLALERT").
 */
export function normalizeSender(raw: string | null | undefined): string {
  const s = String(raw ?? '').trim()
  if (!s) return ''
  const compact = s.replace(/[\s\-().]/g, '')
  if (/^\+?[0-9]{10,15}$/.test(compact)) {
    let d = compact.replace(/^\+/, '')
    if (d.startsWith('0092')) d = d.slice(2)
    else if (d.startsWith('0') && d.length === 11) d = `92${d.slice(1)}`
    return d
  }
  return s.toUpperCase().replace(/[^A-Z0-9]/g, '')
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\/-]/g, '\\$&')
}

/** True when the body contains an ignore keyword (whole word, any case) — OTPs, PINs, passwords. Such SMS are never stored. */
export function isIgnored(body: string, keywords: readonly string[]): boolean {
  const text = String(body ?? '')
  return keywords.some((k) => {
    const kw = k.trim()
    if (!kw) return false
    const pattern = kw.split(/\s+/).map(escapeRegex).join('\\s+')
    return new RegExp(`(?:^|[^A-Za-z0-9])${pattern}(?:$|[^A-Za-z0-9])`, 'i').test(text)
  })
}

// ─── Template compiler ───────────────────────────────────────────────────────

export const PLACEHOLDERS = ['amount', 'ref', 'date', 'time', 'account', 'payer', '*'] as const
type Placeholder = (typeof PLACEHOLDERS)[number]

const SUB: Record<Exclude<Placeholder, '*'>, string> = {
  amount: '(?:(?:PKR|Rs)\\.?\\s{0,2})?([0-9][0-9,]{0,14}(?:\\.[0-9]{1,2})?)(?:\\s?\\/-)?',
  ref: '([A-Za-z0-9][A-Za-z0-9\\-_./#:]{3,48})',
  date: '([0-9]{1,4}[-/. ][0-9A-Za-z]{1,9}[-/. ][0-9]{2,4})',
  time: '([0-9]{1,2}:[0-9]{2}(?::[0-9]{2})?(?:\\s?[AaPp]\\.?[Mm]\\.?)?)',
  account: '([*xX#0-9][*xX#0-9\\-]{1,23})',
  payer: '(.{1,60}?)',
}

export interface CompiledTemplate {
  regex: RegExp
  /** Capture group index of each placeholder present. */
  groups: Partial<Record<Exclude<Placeholder, '*'>, number>>
}

export interface CompileResult {
  ok: boolean
  compiled: CompiledTemplate | null
  problems: string[]
}

/** Compile a template (see the header). Never throws; problems explain a refusal. */
export function compileTemplate(t: Pick<RaastTemplate, 'template' | 'kind'>): CompileResult {
  const problems: string[] = []
  const src = String(t.template ?? '')
  if (!src.trim()) return { ok: false, compiled: null, problems: ['the template is empty'] }
  if (src.length > 500) problems.push('the template is longer than 500 characters')
  const seen = new Set<string>()
  const groups: CompiledTemplate['groups'] = {}
  let wild = 0
  let group = 0
  let pattern = ''
  const tokenRe = /\{([^{}]*)\}/g
  let last = 0
  const literal = (text: string) => {
    if (!text) return
    // Every whitespace run matches any whitespace run; the rest is literal.
    pattern += text.split(/(\s+)/).map((part) => (/^\s+$/.test(part) ? '\\s+' : escapeRegex(part))).join('')
  }
  for (let m = tokenRe.exec(src); m; m = tokenRe.exec(src)) {
    literal(src.slice(last, m.index))
    last = m.index + m[0].length
    const name = m[1]!.trim().toLowerCase()
    if (!(PLACEHOLDERS as readonly string[]).includes(name)) {
      problems.push(`unknown placeholder {${m[1]}} — use {amount} {ref} {date} {time} {account} {payer} or {*}`)
      continue
    }
    if (name === '*') {
      wild++
      pattern += '[\\s\\S]{0,200}?'
      continue
    }
    if (seen.has(name)) { problems.push(`{${name}} appears more than once`); continue }
    seen.add(name)
    if (name === 'payer') wild++
    group++
    groups[name as Exclude<Placeholder, '*'>] = group
    pattern += SUB[name as Exclude<Placeholder, '*'>]
  }
  literal(src.slice(last))
  if (/[{}]/.test(src.replace(tokenRe, ''))) problems.push('a { or } is not part of a placeholder')
  if (wild > 3) problems.push('use {*} and {payer} at most 3 times in one template')
  if (!seen.has('amount')) problems.push('the template needs {amount}')
  if (t.kind === 'credit' && !seen.has('ref')) problems.push('a credit template needs {ref} (the transaction ID)')
  if (problems.length > 0) return { ok: false, compiled: null, problems }
  try {
    return { ok: true, compiled: { regex: new RegExp(`^\\s*${pattern}\\s*$`, 'i'), groups }, problems: [] }
  } catch (err) {
    return { ok: false, compiled: null, problems: [`the template could not be compiled (${(err as Error).message})`] }
  }
}

// ─── Field parsers ───────────────────────────────────────────────────────────

/** "1,234.5" → 123450 paisa; null when not a positive amount within INT4. */
export function parseAmountCents(raw: string | null | undefined): number | null {
  const s = String(raw ?? '').replace(/,/g, '').trim()
  const m = /^([0-9]{1,13})(?:\.([0-9]{1,2}))?$/.exec(s)
  if (!m) return null
  const cents = Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0') || '0')
  if (!Number.isSafeInteger(cents) || cents <= 0 || cents > INT4_MAX_CENTS) return null
  return cents
}

const MONTHS: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 }

/** {year, month, day} from a date string; `format` (e.g. DD-MM-YYYY, YYYY-MM-DD, DD-MMM-YY, MM/DD/YYYY) fixes the order. */
export function parseDateParts(raw: string, format?: string): { y: number; m: number; d: number } | null {
  const parts = String(raw ?? '').trim().split(/[-/. ]+/)
  if (parts.length !== 3) return null
  let order: Array<'d' | 'm' | 'y'>
  if (format) {
    const f = format.toUpperCase().split(/[-/. ]+/)
    if (f.length !== 3) return null
    order = f.map((x) => (x.startsWith('D') ? 'd' : x.startsWith('M') ? 'm' : 'y'))
    if (new Set(order).size !== 3) return null
  } else {
    // Pakistan writes day first; a leading 4-digit part is ISO year-first.
    order = parts[0]!.length === 4 ? ['y', 'm', 'd'] : ['d', 'm', 'y']
  }
  const v: Record<'d' | 'm' | 'y', number> = { d: NaN, m: NaN, y: NaN }
  order.forEach((k, i) => {
    const p = parts[i]!
    if (k === 'm' && /^[A-Za-z]+$/.test(p)) v.m = MONTHS[p.toLowerCase().slice(0, p.toLowerCase().startsWith('sept') ? 4 : 3)] ?? NaN
    else v[k] = /^[0-9]+$/.test(p) ? Number(p) : NaN
  })
  if (v.y < 100) v.y += 2000
  if (!Number.isInteger(v.y) || !Number.isInteger(v.m) || !Number.isInteger(v.d)) return null
  if (v.m < 1 || v.m > 12 || v.d < 1 || v.d > 31 || v.y < 2000 || v.y > 2100) return null
  return { y: v.y, m: v.m, d: v.d }
}

/** {h, mi, s} from "14:05", "14:05:09", "2:05 PM". */
export function parseTimeParts(raw: string): { h: number; mi: number; s: number } | null {
  const m = /^([0-9]{1,2}):([0-9]{2})(?::([0-9]{2}))?\s?(?:([AaPp])\.?[Mm]\.?)?$/.exec(String(raw ?? '').trim())
  if (!m) return null
  let h = Number(m[1])
  const mi = Number(m[2])
  const s = Number(m[3] ?? 0)
  const ap = m[4]?.toLowerCase()
  if (ap) {
    if (h < 1 || h > 12) return null
    if (ap === 'p' && h !== 12) h += 12
    if (ap === 'a' && h === 12) h = 0
  }
  if (h > 23 || mi > 59 || s > 59) return null
  return { h, mi, s }
}

/** A Pakistan-time (+05:00) wall clock as a Date. */
function pkt(y: number, m: number, d: number, h: number, mi: number, s: number): Date {
  return new Date(Date.UTC(y, m - 1, d, h, mi, s) - PKT_OFFSET_MS)
}

function pktParts(at: Date): { y: number; m: number; d: number } {
  const t = new Date(at.getTime() + PKT_OFFSET_MS)
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() }
}

// ─── parseSms ────────────────────────────────────────────────────────────────

export interface ParsedSms {
  templateId: string
  kind: 'credit' | 'debit'
  amountCents: number
  bankRef: string | null      // normalised; null only for a debit template without {ref}
  bankRefRaw: string | null
  occurredAt: Date
  occurredAtSource: 'sms' | 'forwarder' | 'server'
  accountLast4: string | null
  payer: string | null
}

export interface ParseOpts {
  /** When the forwarder says the phone received it. */
  receivedAt?: Date | null
  /** Server now (injectable). */
  now?: Date
}

/** The first active template that matches the WHOLE body, with its fields; null when none does. */
export function parseSms(body: string, templates: readonly RaastTemplate[], opts: ParseOpts = {}): ParsedSms | null {
  const text = String(body ?? '').slice(0, MAX_SMS_CHARS)
  for (const t of templates) {
    if (!t.active) continue
    const r = matchTemplate(text, t, opts)
    if (r.parsed) return r.parsed
  }
  return null
}

export interface TemplateMatch {
  matched: boolean
  parsed: ParsedSms | null
  fields: Partial<Record<Exclude<Placeholder, '*'>, string>>
  problems: string[]
}

/** One template against one body — the tester shows every field and problem. */
export function matchTemplate(body: string, t: RaastTemplate, opts: ParseOpts = {}): TemplateMatch {
  const text = String(body ?? '').slice(0, MAX_SMS_CHARS)
  const c = compileTemplate(t)
  if (!c.ok || !c.compiled) return { matched: false, parsed: null, fields: {}, problems: c.problems }
  const m = c.compiled.regex.exec(text)
  if (!m) return { matched: false, parsed: null, fields: {}, problems: ['the SMS does not match this template'] }
  const fields: TemplateMatch['fields'] = {}
  for (const [name, idx] of Object.entries(c.compiled.groups)) fields[name as keyof TemplateMatch['fields']] = (m[idx as number] ?? '').trim()
  const problems: string[] = []

  const amountCents = parseAmountCents(fields.amount)
  if (amountCents == null) problems.push(`the amount "${fields.amount ?? ''}" is not a valid PKR amount`)
  const bankRefRaw = fields.ref ?? null
  const bankRef = bankRefRaw ? normalizeBankRef(bankRefRaw) : null
  if (t.kind === 'credit' && !bankRef) problems.push('no transaction ID')

  const now = opts.now ?? new Date()
  let occurredAt: Date | null = null
  let occurredAtSource: ParsedSms['occurredAtSource'] = 'sms'
  if (fields.date || fields.time) {
    const time = fields.time ? parseTimeParts(fields.time) : null
    if (fields.time && !time) problems.push(`the time "${fields.time}" was not understood`)
    let date = fields.date ? parseDateParts(fields.date, t.dateFormat) : null
    if (fields.date && !date) problems.push(`the date "${fields.date}" was not understood${t.dateFormat ? ` as ${t.dateFormat}` : ''}`)
    if (!fields.date && time) date = pktParts(opts.receivedAt ?? now)
    if (date) {
      let at = pkt(date.y, date.m, date.d, time?.h ?? 0, time?.mi ?? 0, time?.s ?? 0)
      // A time-only SMS just after midnight about a transfer just before it.
      if (!fields.date && at.getTime() > now.getTime() + 5 * 60_000) at = new Date(at.getTime() - 86_400_000)
      // Only a time in [now − 24 h, now + 5 min] is believed (a date-only SMS is not a time).
      if (time && at.getTime() >= now.getTime() - 86_400_000 && at.getTime() <= now.getTime() + 5 * 60_000) occurredAt = at
    }
  }
  if (!occurredAt) {
    const rec = opts.receivedAt
    if (rec && rec.getTime() >= now.getTime() - 86_400_000 && rec.getTime() <= now.getTime() + 5 * 60_000) {
      occurredAt = rec
      occurredAtSource = 'forwarder'
    } else {
      occurredAt = now
      occurredAtSource = 'server'
    }
  }
  const digits = (fields.account ?? '').replace(/[^0-9]/g, '')
  const accountLast4 = digits.length >= 4 ? digits.slice(-4) : null
  const payer = fields.payer ? fields.payer.replace(/\s+/g, ' ').trim().slice(0, 60) || null : null

  // A date/time the parser could not read is a template problem, but the
  // money facts are still usable (occurredAt falls back to the forwarder).
  const blocking = problems.filter((p) => !p.startsWith('the time') && !p.startsWith('the date'))
  if (blocking.length > 0 || amountCents == null) return { matched: true, parsed: null, fields, problems }
  return {
    matched: true,
    fields,
    problems,
    parsed: {
      templateId: t.id, kind: t.kind, amountCents, bankRef, bankRefRaw, occurredAt, occurredAtSource, accountLast4, payer,
    },
  }
}
