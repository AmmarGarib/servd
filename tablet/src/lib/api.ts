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

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const token = sessionStore.getState().token
  const res = await fetch(`${API_URL}/api/v1${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(token && { Authorization: `Bearer ${token}` }),
      ...options.headers,
    },
  })

  if (res.status === 401) {
    // Token expired or PIN revoked — drop session so the auth gate kicks in.
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
