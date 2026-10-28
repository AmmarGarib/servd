// The rider API client for servd.pk/rider (docs/rider-app.md) — the web twin
// of the Expo app's rider/src/lib/api.ts. Same contract, same rules:
//
//  - The session lives in lib/riderSession.ts (its own store, never the
//    customer's): a rider is not a customer, and a rider token is refused on
//    every customer and staff route.
//  - A 401 tries ONE refresh (POST /rider-auth/refresh) and replays the
//    request. The refresh ROTATES — the old refresh token is revoked the
//    moment a new pair is issued — so every caller in this tab shares the one
//    in-flight refresh, and tabs take turns through a Web Lock (and adopt a
//    pair another tab already rotated to, instead of presenting a revoked
//    token and signing the rider out).
//  - A refresh that fails because the network is down, the API is restarting
//    (5xx) or rate limited (429) does NOT sign the rider out. Riders are on
//    mobile data in traffic; dropping the session in a dead zone would strand
//    them mid-delivery. Only a refresh the server refuses clears the session.
//  - Errors come back as RiderApiError with the API's
//    `{ error: { code, message, details } }` envelope unpacked.

import { readPersistedRiderTokens, useRiderSession } from './riderSession'

export const RIDER_API_URL = (process.env['NEXT_PUBLIC_API_URL'] ?? 'http://localhost:3001').replace(/\/+$/, '')

// ─── Contract shapes (docs/rider-app.md) ─────────────────────────────────────
// Keep in step with backend/src/modules/rider and riderAuth, and with the
// Expo app's rider/src/lib/types.ts.

export type RiderStatus = 'available' | 'busy' | 'offline'

export interface RiderPublic {
  id: string
  name: string
  phone: string            // normalised 92… digits
  vehicleType: string
  status: RiderStatus | string
  companyName: string | null
}

export type JobStage = 'offered' | 'accepted' | 'picked_up' | 'arrived'

export interface JobPlace {
  name: string | null
  address: string | null
  lat: number | null
  lng: number | null
  phone: string | null
}

export interface Job {
  orderId: string
  orderNumber: string
  status: string                            // the order's status (received … ready …)
  stage: JobStage
  brand: { name: string; slug: string }
  company: { id: string | null; name: string | null }   // the client company
  pickup: JobPlace                          // the kitchen
  dropoff: JobPlace                         // the customer; address = delivery notes text
  itemCount: number
  items: Array<{ name: string; qty: number }>
  cashToCollectCents: number                // pending cash (COD); 0 when prepaid
  notes: string | null
  assignedAt: string | null
  acceptedAt: string | null
  pickedUpAt: string | null
  arrivedAt: string | null
  otpAttemptsLeft: number
  /** Emergency override: a manager sent the code to this rider's WhatsApp.
   *  `code` is only present when it was sent to THIS rider (a fallback). */
  handover?: { rerouted: boolean; reroutedAt: string | null; code: string | null; whatsappSent: boolean }
  /** The last problem this rider reported at the door, if any. */
  doorProblem?: { kind: DoorProblemKind; at: string } | null
  /** True when the order's company delivers by code only (door problems are on). */
  doorProblemEnabled?: boolean
}

export type DoorProblemKind = 'no_code' | 'refused' | 'unreachable'

export interface ShiftResponse {
  rider: RiderPublic
  /** COD cash the rider holds and has not handed in (going off shift only). A reminder, never a block. */
  cashHeldCents?: number
}

export interface RiderSessionResponse {
  accessToken: string
  refreshToken: string
  rider: RiderPublic
}

export interface DeliverResult {
  orderId: string
  status: string
  deliveredAt: string | null
  alreadyDelivered: boolean
}

export interface RiderFix {
  lat: number
  lng: number
  heading?: number
  accuracy?: number
  speedMps?: number
  orderId?: string
}

export type Pos = { lat?: number; lng?: number }

/** On shift = the server says the rider is not offline. */
export function isOnShift(status: string | null | undefined): boolean {
  return status === 'available' || status === 'busy'
}

/** The job the rider is carrying right now — location fixes are tagged with it. */
export function carryingJob(jobs: Job[] | null | undefined): Job | null {
  return jobs?.find((j) => j.stage === 'picked_up' || j.stage === 'arrived') ?? null
}

// ─── Errors ──────────────────────────────────────────────────────────────────

export class RiderApiError extends Error {
  /** 0 = no response (offline, DNS, timeout). */
  status: number
  code: string
  details: Record<string, unknown> | undefined
  constructor(status: number, code: string, message: string, details?: Record<string, unknown>) {
    super(message)
    this.name = 'RiderApiError'
    this.status = status
    this.code = code
    this.details = details
  }
}

const NETWORK_MESSAGE = 'No connection to servd. Check your mobile data and try again.'
const SIGNED_OUT_MESSAGE = 'You have been signed out. Sign in again with your phone number.'

const TIMEOUT_MS = 15_000

async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
  try {
    return await fetch(url, { ...init, cache: 'no-store', signal: ctrl.signal })
  } catch {
    throw new RiderApiError(0, 'NETWORK', NETWORK_MESSAGE)
  } finally {
    clearTimeout(timer)
  }
}

async function toApiError(res: Response): Promise<RiderApiError> {
  const body = await res.json().catch(() => null) as
    | { error?: { code?: string; message?: string; details?: unknown; [k: string]: unknown } }
    | null
  const e = body?.error
  // Some routes put extra fields beside code/message as well as in `details`
  // (OTP_MISMATCH carries `attemptsLeft` in both); keep both readable.
  const details = e?.details && typeof e.details === 'object' && !Array.isArray(e.details)
    ? { ...e, ...(e.details as Record<string, unknown>) }
    : e ? { ...e } : undefined
  return new RiderApiError(
    res.status,
    e?.code ?? `HTTP_${res.status}`,
    e?.message ?? `Request failed (${res.status})`,
    details,
  )
}

async function readBody<T>(res: Response): Promise<T> {
  if (res.status === 204) return undefined as T
  const text = await res.text()
  return (text ? JSON.parse(text) : undefined) as T
}

// ─── Refresh: one at a time, per tab and across tabs ─────────────────────────

type RefreshResult = { ok: true } | { ok: false; reason: 'invalid' | 'network' }

let refreshInFlight: Promise<RefreshResult> | null = null

/** Run `fn` holding a cross-tab lock where the browser has Web Locks (secure
 *  contexts in every current browser); straight through otherwise. */
async function withRefreshLock<T>(fn: () => Promise<T>): Promise<T> {
  const locks = typeof navigator !== 'undefined' && 'locks' in navigator ? navigator.locks : undefined
  if (!locks || typeof locks.request !== 'function') return fn()
  return locks.request('servd-rider-refresh', () => fn()) as Promise<T>
}

/** Another tab rotated the pair since this one last read it: adopt theirs. */
function adoptOtherTabTokens(presented: string | null): boolean {
  const persisted = readPersistedRiderTokens()
  if (persisted?.accessToken && persisted.refreshToken && persisted.refreshToken !== presented) {
    useRiderSession.getState().setTokens(persisted.accessToken, persisted.refreshToken)
    return true
  }
  return false
}

async function doRefresh(): Promise<RefreshResult> {
  const presented = useRiderSession.getState().refreshToken
  if (adoptOtherTabTokens(presented)) return { ok: true }
  if (!presented) return { ok: false, reason: 'invalid' }

  let res: Response
  try {
    res = await fetchWithTimeout(`${RIDER_API_URL}/api/v1/rider-auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken: presented }),
    })
  } catch {
    return { ok: false, reason: 'network' }
  }
  // 5xx / 429: the server could not decide — keep the session and let the
  // next request try again.
  if (res.status >= 500 || res.status === 429) return { ok: false, reason: 'network' }
  if (!res.ok) {
    // Refused. A tab without Web Locks may have rotated it a moment earlier.
    if (adoptOtherTabTokens(presented)) return { ok: true }
    return { ok: false, reason: 'invalid' }
  }
  const d = await res.json().catch(() => null) as Partial<RiderSessionResponse> | null
  if (!d?.accessToken || !d.refreshToken) return { ok: false, reason: 'invalid' }
  useRiderSession.getState().setTokens(d.accessToken, d.refreshToken)
  return { ok: true }
}

/** Refresh the access token. Concurrent callers share one request. */
export function refreshRiderSession(): Promise<RefreshResult> {
  if (refreshInFlight) return refreshInFlight
  refreshInFlight = withRefreshLock(doRefresh).finally(() => { refreshInFlight = null })
  return refreshInFlight
}

// ─── Requests ────────────────────────────────────────────────────────────────

interface RequestOpts {
  method?: 'GET' | 'POST'
  /** JSON body, or a function that builds it at send time (and again on the
   *  replay after a refresh — logout sends the CURRENT refresh token). */
  body?: unknown | (() => unknown)
}

async function send<T>(path: string, opts: RequestOpts, replay: boolean): Promise<T> {
  const token = useRiderSession.getState().accessToken
  const method = opts.method ?? 'GET'
  const body = typeof opts.body === 'function' ? (opts.body as () => unknown)() : opts.body
  const res = await fetchWithTimeout(`${RIDER_API_URL}/api/v1${path}`, {
    method,
    headers: {
      ...(method !== 'GET' && { 'Content-Type': 'application/json' }),
      ...(token && { Authorization: `Bearer ${token}` }),
    },
    // Fastify refuses an empty body sent as JSON, so a bare POST sends {}.
    ...(method !== 'GET' && { body: JSON.stringify(body ?? {}) }),
  })

  if (res.status === 401 && token) {
    if (!replay) {
      // Already rotated by another caller while this one was in flight.
      const current = useRiderSession.getState().accessToken
      if (current && current !== token) return send<T>(path, opts, true)
      // Access tokens last 15 minutes; the refresh token 30 days.
      const r = await refreshRiderSession()
      if (r.ok) return send<T>(path, opts, true)
      if (r.reason === 'network') throw new RiderApiError(0, 'NETWORK', NETWORK_MESSAGE)
    }
    useRiderSession.getState().clear()
    throw new RiderApiError(401, 'SESSION_ENDED', SIGNED_OUT_MESSAGE)
  }

  if (!res.ok) throw await toApiError(res)
  return readBody<T>(res)
}

/** An authenticated rider request (Bearer rider access token). */
export function riderFetch<T>(path: string, opts: RequestOpts = {}): Promise<T> {
  return send<T>(path, opts, false)
}

/** The two public sign-in calls: no token, no refresh. */
async function publicPost<T>(path: string, body: unknown): Promise<T> {
  const res = await fetchWithTimeout(`${RIDER_API_URL}/api/v1${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw await toApiError(res)
  return readBody<T>(res)
}

const enc = encodeURIComponent

export type StepAction = 'accept' | 'decline' | 'picked-up' | 'arrived'

export const riderApi = {
  /** Phone + password (owner, 2026-10-28: riders have full accounts). 401 INVALID_CREDENTIALS. */
  signIn: (phone: string, password: string) =>
    publicPost<RiderSessionResponse>('/rider-auth/login', { phone, password }),
  /** A WhatsApp code to SET the password (first sign-in, forgotten password). 202 { sent: true } for every number. */
  requestCode: (phone: string) =>
    publicPost<{ sent: boolean }>('/rider-auth/otp/request', { phone }),
  /** The code + the new password: stores it and signs in. A code never signs in on its own. */
  setPassword: (phone: string, code: string, newPassword: string) =>
    publicPost<RiderSessionResponse>('/rider-auth/otp/verify', { phone, code, newPassword }),

  me: () => riderFetch<{ rider: RiderPublic }>('/rider/me'),
  setShift: (online: boolean) =>
    riderFetch<ShiftResponse>('/rider/shift', { method: 'POST', body: { online } }),
  jobs: () => riderFetch<{ jobs: Job[] }>('/rider/jobs'),
  job: (orderId: string) => riderFetch<{ job: Job }>(`/rider/jobs/${enc(orderId)}`),
  step: (orderId: string, action: StepAction, body: Pos & { reason?: string }) =>
    riderFetch<{ job?: Job; ok?: boolean }>(`/rider/jobs/${enc(orderId)}/${action}`, { method: 'POST', body }),
  deliver: (orderId: string, otp: string, pos: Pos) =>
    riderFetch<DeliverResult>(`/rider/jobs/${enc(orderId)}/deliver`, { method: 'POST', body: { otp, ...pos } }),
  reportDoorProblem: (orderId: string, kind: DoorProblemKind, pos: Pos & { note?: string }) =>
    riderFetch<unknown>(`/rider/jobs/${enc(orderId)}/door-problem`, { method: 'POST', body: { kind, ...pos } }),
  location: (fix: RiderFix) => riderFetch<unknown>('/rider/location', { method: 'POST', body: fix }),
}

/**
 * Sign out: revoke both tokens on the server (best effort), then forget them
 * here whatever the server said.
 */
export async function signOutRider(): Promise<void> {
  if (useRiderSession.getState().accessToken) {
    try {
      await riderFetch<void>('/rider-auth/logout', {
        method: 'POST',
        body: () => ({ refreshToken: useRiderSession.getState().refreshToken ?? undefined }),
      })
    } catch { /* offline or already revoked — the local sign-out still happens */ }
  }
  useRiderSession.getState().clear()
}

// ─── Error helpers for the screens ───────────────────────────────────────────

/** A numeric field the server attached to an error (e.g. attemptsLeft). */
export function errorNumber(err: unknown, key: string): number | null {
  if (!(err instanceof RiderApiError)) return null
  const v = err.details?.[key]
  return typeof v === 'number' ? v : null
}

/** A sentence a rider can act on, for any error a screen shows. */
export function friendlyError(err: unknown): string {
  if (err instanceof RiderApiError) {
    if (err.status === 0) return NETWORK_MESSAGE
    if (err.status === 429) return 'Too many tries. Wait a few minutes and try again.'
    if (err.status >= 500) return 'servd is having a problem. Try again in a minute; if it keeps happening, call the kitchen.'
    return err.message
  }
  return (err as Error | null)?.message || 'Something went wrong. Try again.'
}
