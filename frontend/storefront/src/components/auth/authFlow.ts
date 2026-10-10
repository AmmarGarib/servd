'use client'
import { useEffect, useState } from 'react'

// The pieces /login, /signup and the `signup_form` block share: where to send
// the customer once they're signed in, how to carry that through a hop between
// the two pages, and the plain wording for errors.

// ─── Return path ────────────────────────────────────────────────────────────
//
// Checkout sends ?next=, the order tracker sends ?return= — honour both, and
// carry the target on as ?next= when the customer hops between /login and
// /signup, so someone sent to sign in from checkout lands back in checkout
// after creating an account instead of on /account.
//
// Open-redirect guard: only a same-site relative path is accepted — one
// leading '/', never '//' (protocol-relative), never a backslash (browsers
// read '/\host' as '//host'), no whitespace or control characters (the URL
// parser strips tabs/newlines, so '/\t/host' would become '//host'). The
// result is re-checked by resolving it against a dummy origin.

const DUMMY_ORIGIN = 'https://servd.invalid'

export function safeReturnPath(raw: string | null | undefined): string | null {
  if (!raw) return null
  const p = raw.trim()
  if (!p.startsWith('/') || p.startsWith('//')) return null
  // eslint-disable-next-line no-control-regex
  if (/[\\\s\u0000-\u001f\u007f]/.test(p)) return null
  let url: URL
  try { url = new URL(p, DUMMY_ORIGIN) } catch { return null }
  if (url.origin !== DUMMY_ORIGIN) return null
  // Sending someone back to the page they're leaving would loop.
  if (url.pathname === '/login' || url.pathname === '/signup') return null
  return url.pathname + url.search + url.hash
}

/** The validated ?next= / ?return= on the current URL, or null. Browser only. */
export function authReturnPath(): string | null {
  if (typeof window === 'undefined') return null
  const sp = new URLSearchParams(window.location.search)
  return safeReturnPath(sp.get('next')) ?? safeReturnPath(sp.get('return'))
}

/** Where to send the customer after they sign in or sign up. */
export function postAuthDest(): string {
  return authReturnPath() ?? '/account'
}

/** `/signup` or `/login`, carrying the return target as ?next= when there is one. */
export function withReturnPath(page: '/login' | '/signup', dest: string | null): string {
  return dest ? `${page}?next=${encodeURIComponent(dest)}` : page
}

/** The return target, read after mount — the server HTML (and the first client
 *  render) has no query string to read, so links start plain and pick the
 *  target up once the page is in the browser. */
export function useAuthReturnPath(): string | null {
  const [dest, setDest] = useState<string | null>(null)
  useEffect(() => { setDest(authReturnPath()) }, [])
  return dest
}

// ─── Error wording ──────────────────────────────────────────────────────────
//
// Customers never see developer text ("Make sure the API is running",
// "Validation failed", "Internal server error").

export const NETWORK_ERROR = 'We couldn’t reach servd just now. Please try again in a moment.'

const SERVER_ERROR = 'Something went wrong on our side. Please try again in a moment.'
const RATE_LIMITED = 'Too many tries. Please wait a minute and try again.'

const FIELD_ERROR: Record<string, string> = {
  email:    'Please enter a valid email.',
  phone:    'Please enter a valid mobile number.',
  name:     'Please enter your name.',
  password: 'Your password needs at least 8 characters, with a letter and a number.',
  code:     'Enter the 6-digit code.',
}

export interface ApiErrorBody {
  error?: {
    code?: string
    message?: string
    details?: Array<{ path?: Array<string | number>; message?: string }>
  }
}

/** The customer-facing message for a failed auth call. The API's own message
 *  is used for its deliberate errors (AppError codes such as OTP_WRONG,
 *  RATE_LIMITED, OTP_SEND_FAILED — written for customers); schema
 *  validation, framework errors (FST_*, BAD_REQUEST) and server failures get
 *  plain wording instead. */
export function customerErrorMessage(status: number, body: ApiErrorBody | null, fallback: string): string {
  const err = body?.error
  const code = err?.code ?? ''
  if (code === 'VALIDATION_ERROR') {
    const issue = err?.details?.[0]
    const field = String(issue?.path?.[0] ?? '')
    // The API's own password rules are written for customers.
    if (field === 'password' && issue?.message?.startsWith('Password must')) return issue.message
    return FIELD_ERROR[field] ?? 'Please check your details and try again.'
  }
  const deliberate = /^[A-Z][A-Z0-9_]*$/.test(code)
    && !code.startsWith('FST_') && code !== 'INTERNAL_ERROR' && code !== 'BAD_REQUEST'
  const message = err?.message?.trim()
  if (deliberate && message) return message
  if (status === 429) return RATE_LIMITED
  if (status >= 500) return SERVER_ERROR
  return fallback || SERVER_ERROR
}
