// API wrapper for the rider app. Same shape as tablet/src/lib/api.ts: the
// token lives in the session store (loaded once from SecureStore), a 401 tries
// ONE shared refresh before giving up, and errors come back as ApiError with
// the server's `{ error: { code, message, details } }` envelope unpacked.
//
// Rider-specific:
//  - Refresh is POST /rider-auth/refresh, and it ROTATES: the response is a
//    new { accessToken, refreshToken } and the old refresh token is revoked,
//    so both are saved together.
//  - A refresh that fails because the network is down does NOT sign the rider
//    out. Riders are on mobile data in traffic; dropping the session on a dead
//    zone would strand them mid-delivery. Only a refresh the server refuses
//    clears the session.

import Constants from 'expo-constants'
import { sessionStore } from '../store/session'
import type { TokenPair } from './types'

const API_URL: string = (
  (Constants.expoConfig?.extra?.apiUrl as string | undefined) ?? 'https://api.servd.pk'
).replace(/\/+$/, '')

export class ApiError extends Error {
  status: number          // 0 = no response (offline, DNS, timeout)
  code: string
  details: unknown
  body: unknown
  constructor(status: number, code: string, message: string, details?: unknown, body?: unknown) {
    super(message)
    this.status = status
    this.code = code
    this.details = details
    this.body = body
  }
}

const TIMEOUT_MS = 15_000

async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
  try {
    return await fetch(url, { ...init, signal: ctrl.signal })
  } catch (err) {
    throw new ApiError(0, 'NETWORK', 'No connection to servd. Check your mobile data and try again.', undefined, err)
  } finally {
    clearTimeout(timer)
  }
}

// One in-flight refresh at a time. The jobs poll, the job detail poll and the
// location task can all 401 together when the access token expires; without
// this each would fire its own refresh, and all but the first would present an
// already-rotated (revoked) token and sign the rider out.
type RefreshResult = { ok: true; token: string } | { ok: false; reason: 'invalid' | 'network' }
let refreshInFlight: Promise<RefreshResult> | null = null

function refreshAccessToken(): Promise<RefreshResult> {
  if (refreshInFlight) return refreshInFlight
  const rt = sessionStore.getState().refreshToken
  if (!rt) return Promise.resolve({ ok: false, reason: 'invalid' })

  refreshInFlight = (async (): Promise<RefreshResult> => {
    try {
      let res: Response
      try {
        res = await fetchWithTimeout(`${API_URL}/api/v1/rider-auth/refresh`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ refreshToken: rt }),
        })
      } catch {
        return { ok: false, reason: 'network' }
      }
      // 5xx / 429: the server could not decide — keep the session and let the
      // next request try again.
      if (res.status >= 500 || res.status === 429) return { ok: false, reason: 'network' }
      if (!res.ok) return { ok: false, reason: 'invalid' }
      const d = await res.json().catch(() => null) as Partial<TokenPair> | null
      if (!d?.accessToken || !d.refreshToken) return { ok: false, reason: 'invalid' }
      await sessionStore.getState().setTokens(d.accessToken, d.refreshToken)
      return { ok: true, token: d.accessToken }
    } finally {
      refreshInFlight = null
    }
  })()
  return refreshInFlight
}

async function toApiError(res: Response): Promise<ApiError> {
  const body = await res.json().catch(() => null) as
    | { error?: { code?: string; message?: string; details?: unknown; [k: string]: unknown } }
    | null
  const e = body?.error
  // Some routes put extra fields beside code/message instead of in `details`
  // (e.g. `{ code: 'OTP_MISMATCH', attemptsLeft: 3 }`); keep both readable.
  const details = e?.details ?? (e ? { ...e } : undefined)
  return new ApiError(
    res.status,
    e?.code ?? `HTTP_${res.status}`,
    e?.message ?? `Request failed (${res.status})`,
    details,
    body,
  )
}

// `options` may be a function so a retry after a refresh rebuilds the body
// (logout sends the CURRENT refresh token, which the refresh just rotated).
type Options = RequestInit | (() => RequestInit)

async function request<T>(path: string, opts: Options = {}, retrying = false): Promise<T> {
  const token = sessionStore.getState().token
  const options = typeof opts === 'function' ? opts() : opts
  const res = await fetchWithTimeout(`${API_URL}/api/v1${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(token && { Authorization: `Bearer ${token}` }),
      ...options.headers,
    },
  })

  if (res.status === 401 && token && !retrying) {
    // Access tokens last 15 minutes; the refresh token 30 days.
    const r = await refreshAccessToken()
    if (r.ok) return request<T>(path, opts, true)
    if (r.reason === 'invalid') {
      await sessionStore.getState().clear()
      throw new ApiError(401, 'SESSION_ENDED', 'You have been signed out. Sign in again with your phone number.')
    }
    throw new ApiError(0, 'NETWORK', 'No connection to servd. Check your mobile data and try again.')
  }
  if (res.status === 401 && token && retrying) {
    await sessionStore.getState().clear()
    throw new ApiError(401, 'SESSION_ENDED', 'You have been signed out. Sign in again with your phone number.')
  }

  if (!res.ok) throw await toApiError(res)
  if (res.status === 204) return undefined as T
  const text = await res.text()
  return (text ? JSON.parse(text) : undefined) as T
}

export const api = {
  get:  <T>(path: string)                 => request<T>(path),
  post: <T>(path: string, body?: unknown) => request<T>(path, { method: 'POST', body: JSON.stringify(body ?? {}) }),
  /** POST whose body is built at send time (and again on a retry). */
  postLazy: <T>(path: string, body: () => unknown) =>
    request<T>(path, () => ({ method: 'POST', body: JSON.stringify(body() ?? {}) })),
}

/** Read a numeric field the server attached to an error (e.g. attemptsLeft). */
export function errorDetail(err: unknown, key: string): number | null {
  if (!(err instanceof ApiError)) return null
  const d = err.details as Record<string, unknown> | undefined
  const v = d?.[key]
  return typeof v === 'number' ? v : null
}

/** A sentence a rider can act on, for any error the app shows. */
export function friendlyError(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 0) return 'No connection to servd. Check your mobile data and try again.'
    if (err.status === 429) return 'Too many tries. Wait a few minutes and try again.'
    if (err.status >= 500) return 'servd is having a problem. Try again in a minute; if it keeps happening, call the kitchen.'
    return err.message
  }
  return (err as Error)?.message ?? 'Something went wrong. Try again.'
}

export { API_URL }
