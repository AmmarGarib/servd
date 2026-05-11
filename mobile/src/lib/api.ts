import Constants from 'expo-constants'
import * as SecureStore from 'expo-secure-store'

const API_URL = (Constants.expoConfig?.extra?.apiUrl as string | undefined) ?? 'https://api.servd.pk'

async function getToken() {
  return SecureStore.getItemAsync('servd_token')
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const token = await getToken()
  const res = await fetch(`${API_URL}/api/v1${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(token && { Authorization: `Bearer ${token}` }),
      ...options.headers,
    },
  })
  if (!res.ok) {
    const data = await res.json().catch(() => ({ error: { message: 'Request failed' } }))
    throw new Error((data as { error?: { message?: string } }).error?.message ?? 'Request failed')
  }
  if (res.status === 204) return undefined as T
  return res.json() as Promise<T>
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body: unknown) => request<T>(path, { method: 'POST', body: JSON.stringify(body) }),
  patch: <T>(path: string, body: unknown) => request<T>(path, { method: 'PATCH', body: JSON.stringify(body) }),
  delete: <T>(path: string) => request<T>(path, { method: 'DELETE' }),
}
