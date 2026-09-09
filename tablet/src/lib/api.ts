// API wrapper for the staff tablet. Mirrors mobile/src/lib/api.ts so the two
// codebases stay aligned, with one difference: the token is held by the
// session store (zustand) instead of SecureStore-on-every-call, because the
// tablet has high request volume on KDS / POS and the SecureStore IPC adds up.
// Token is still persisted to SecureStore but loaded once at boot.

import Constants from 'expo-constants'
import { sessionStore } from '../store/session'

const API_URL = (Constants.expoConfig?.extra?.apiUrl as string | undefined) ?? 'http://10.0.2.2:4000'

export class ApiError extends Error {
  status: number
  body: unknown
  constructor(status: number, message: string, body: unknown) {
    super(message)
    this.status = status
    this.body = body
  }
}

// One in-flight refresh at a time. On a KDS board a dozen requests can 401
// together when the access token expires; without this they would each fire
// their own refresh, and all but the first would present an already-rotated
// token and fail — logging the tablet out at exactly the moment we are trying
// to keep it signed in.
let refreshInFlight: Promise<string | null> | null = null

async function refreshAccessToken(): Promise<string | null> {
  const rt = sessionStore.getState().refreshToken
  if (!rt) return null
  if (refreshInFlight) return refreshInFlight

  refreshInFlight = (async () => {
    try {
      const res = await fetch(`${API_URL}/api/v1/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken: rt }),
      })
      if (!res.ok) return null
      const d = await res.json() as { accessToken?: string }
      if (!d.accessToken) return null
      await sessionStore.getState().setAccessToken(d.accessToken)
      return d.accessToken
    } catch {
      return null
    } finally {
      refreshInFlight = null
    }
  })()
  return refreshInFlight
}

async function request<T>(path: string, options: RequestInit = {}, retrying = false): Promise<T> {
  const token = sessionStore.getState().token
  const res = await fetch(`${API_URL}/api/v1${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(token && { Authorization: `Bearer ${token}` }),
      ...options.headers,
    },
  })

  if (res.status === 401 && !retrying) {
    // Access tokens last 15 minutes. Try the refresh token before throwing the
    // session away — otherwise every staff member re-types a 12-character
    // password on an on-screen keyboard roughly 32 times a shift.
    const fresh = await refreshAccessToken()
    if (fresh) return request<T>(path, options, true)
    sessionStore.getState().clear()
  } else if (res.status === 401) {
    sessionStore.getState().clear()
  }

  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: { message: 'Request failed' } }))
    const msg = (body as { error?: { message?: string } }).error?.message ?? `HTTP ${res.status}`
    throw new ApiError(res.status, msg, body)
  }
  if (res.status === 204) return undefined as T
  return res.json() as Promise<T>
}

export const api = {
  get:    <T>(path: string)                  => request<T>(path),
  post:   <T>(path: string, body: unknown)   => request<T>(path, { method: 'POST',   body: JSON.stringify(body ?? {}) }),
  patch:  <T>(path: string, body: unknown)   => request<T>(path, { method: 'PATCH',  body: JSON.stringify(body ?? {}) }),
  put:    <T>(path: string, body: unknown)   => request<T>(path, { method: 'PUT',    body: JSON.stringify(body ?? {}) }),
  delete: <T>(path: string)                  => request<T>(path, { method: 'DELETE' }),
}

export { API_URL }
