// POS connector — small shared helpers (spec §5, §6.4).
//
// Everything here is pure (no DB, no network) so it can be unit-tested and
// shared by the drivers, the outbox, the terminal service and the routes.

import { createHash, createHmac, timingSafeEqual } from 'node:crypto'

/**
 * Race a promise against a timer. The timer is cleared when the promise
 * settles, so a fast answer never leaves a dangling timeout behind. Moved here
 * from pos/service.ts (the SRB sync path used it) — the connector is now the
 * only caller that bounds a vendor call this way.
 */
export function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<T>((_, reject) => {
    timer = setTimeout(() => reject(new TimeoutError(`${label} timed out after ${ms}ms`)), ms)
  })
  return Promise.race([p, timeout]).finally(() => { if (timer) clearTimeout(timer) })
}

export class TimeoutError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TimeoutError'
  }
}

/** Resolve after `ms`, or reject early when `signal` aborts. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new TimeoutError('aborted'))
    const t = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve() }, ms)
    const onAbort = () => { clearTimeout(t); reject(new TimeoutError('aborted')) }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

// ─── Backoff (spec §6.4) ──────────────────────────────────────────────────────
// By attempt number: 5 s, 15 s, 1 m, 5 m, 15 m, 30 m, 1 h, then hourly, with
// ±20 % jitter. The vendor's retryAfterMs wins when it is longer.

const BACKOFF_STEPS_MS = [5_000, 15_000, 60_000, 5 * 60_000, 15 * 60_000, 30 * 60_000, 60 * 60_000]

/** Base delay (no jitter) after `attempt` attempts (1-based). */
export function backoffBaseMs(attempt: number): number {
  const i = Math.max(1, Math.floor(attempt)) - 1
  return BACKOFF_STEPS_MS[Math.min(i, BACKOFF_STEPS_MS.length - 1)]!
}

/** ±20 % jitter. `rand` is injectable for tests (0..1). */
export function jitter(ms: number, rand: () => number = Math.random): number {
  const f = 0.8 + rand() * 0.4
  return Math.round(ms * f)
}

/** The delay before the next attempt: jittered step, or the vendor's retryAfterMs if longer, never below `floorMs`. */
export function nextDelayMs(attempt: number, opts: { retryAfterMs?: number; floorMs?: number; rand?: () => number } = {}): number {
  const base = jitter(backoffBaseMs(attempt), opts.rand)
  return Math.max(base, opts.retryAfterMs ?? 0, opts.floorMs ?? 0)
}

// ─── Hashing / signing (spec §5) ──────────────────────────────────────────────

export function sha256Hex(s: string): string {
  return createHash('sha256').update(s).digest('hex')
}

/** JSON with object keys sorted, so a hash of the same payload is stable. */
export function stableStringify(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null'
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`
  const obj = v as Record<string, unknown>
  const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort()
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`
}

/** `X-Servd-Signature` value: `t=<unix>,v1=<hex HMAC-SHA256(secret, t + "." + rawBody)>`. */
export function signBody(secret: string, rawBody: string, unixSeconds: number): string {
  const v1 = createHmac('sha256', secret).update(`${unixSeconds}.${rawBody}`).digest('hex')
  return `t=${unixSeconds},v1=${v1}`
}

/**
 * Verify an inbound `X-Servd-Signature`. Constant-time compare on equal-length
 * buffers; the timestamp must be within `toleranceSec` of `nowSec`.
 */
export function verifySignature(
  header: string | undefined | null,
  secret: string,
  rawBody: string,
  nowSec: number,
  toleranceSec = 300,
): boolean {
  if (!header || !secret) return false
  const parts = new Map<string, string>()
  for (const piece of header.split(',')) {
    const i = piece.indexOf('=')
    if (i > 0) parts.set(piece.slice(0, i).trim(), piece.slice(i + 1).trim())
  }
  const t = Number(parts.get('t'))
  const v1 = parts.get('v1') ?? ''
  if (!Number.isFinite(t) || !/^[0-9a-f]{64}$/i.test(v1)) return false
  if (Math.abs(nowSec - t) > toleranceSec) return false
  const expected = createHmac('sha256', secret).update(`${t}.${rawBody}`).digest()
  const given = Buffer.from(v1, 'hex')
  if (given.length !== expected.length) return false
  return timingSafeEqual(given, expected)
}

// ─── Messages ─────────────────────────────────────────────────────────────────

/**
 * A vendor message safe to store and show: truncated, with anything that looks
 * like a bearer token, key=value secret, card number or phone number masked.
 */
export function scrubMessage(msg: unknown, max = 500): string {
  let s = typeof msg === 'string' ? msg : (msg instanceof Error ? msg.message : JSON.stringify(msg ?? ''))
  s = s
    .replace(/(bearer\s+)[A-Za-z0-9._~+/=-]+/gi, '$1***')
    .replace(/((?:api[_-]?key|secret|token|password|pass|authorization)["']?\s*[:=]\s*["']?)[^"',\s}]+/gi, '$1***')
    .replace(/\b\d{13,19}\b/g, '****')
    .replace(/\+?\b92\d{9,10}\b/g, '***')
  return s.length > max ? `${s.slice(0, max - 1)}…` : s
}

// ─── Time (Asia/Karachi, UTC+5, no DST) ───────────────────────────────────────

const PKT_OFFSET_MS = 5 * 3_600_000

/** ISO-8601 with an explicit +05:00 offset, e.g. 2026-10-10T14:03:22+05:00. */
export function isoPkt(d: Date): string {
  const p = new Date(d.getTime() + PKT_OFFSET_MS)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${p.getUTCFullYear()}-${pad(p.getUTCMonth() + 1)}-${pad(p.getUTCDate())}T${pad(p.getUTCHours())}:${pad(p.getUTCMinutes())}:${pad(p.getUTCSeconds())}+05:00`
}

/** The Asia/Karachi calendar day of `d` as YYYY-MM-DD. */
export function karachiDay(d: Date): string {
  return isoPkt(d).slice(0, 10)
}

/** Start of the Asia/Karachi day containing `d`, as a UTC Date. */
export function karachiDayStart(d: Date): Date {
  const day = karachiDay(d)
  return new Date(`${day}T00:00:00+05:00`)
}
