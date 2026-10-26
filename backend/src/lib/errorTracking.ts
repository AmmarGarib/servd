// Backend error tracking (owner, 2026-10-26, S14a): Sentry for the API.
//
// OFF unless SENTRY_DSN_API is set (a complete no-op otherwise: nothing is
// imported-initialised, `captureServerError` returns at once). Never active in
// a practice copy (lib/sandbox.ts: kind 'error_report').
//
// What is reported: unhandled errors from the Fastify error handler that end
// as a 5xx (never AppErrors / validation / 4xx), unhandled rejections,
// uncaught exceptions and worker crashes (`captureWorkerError`).
//
// What is NEVER sent: request bodies, query strings' values, headers (auth,
// cookies), user data, phone numbers or emails (`scrubEvent`, also run as
// beforeSend as the backstop).

import * as Sentry from '@sentry/node'
import { isSandbox, sandboxBlocks } from './sandbox.js'

let active = false

const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi
// 8+ digits, optionally +, spaces / dashes / brackets inside: a phone number
const PHONE_RE = /\+?\d[\d\s\-()]{7,}\d/g
const REDACTED = '[redacted]'

export function scrubString(s: string): string {
  return s.replace(EMAIL_RE, REDACTED).replace(PHONE_RE, REDACTED)
}

/** Strip everything personal from an event. Pure; exported for tests. */
export function scrubEvent<T extends Sentry.ErrorEvent>(event: T): T {
  if (event.request) {
    delete event.request.data
    delete event.request.cookies
    delete event.request.headers
    delete event.request.query_string
    if (typeof event.request.url === 'string') event.request.url = scrubString(event.request.url.split('?')[0] ?? '')
  }
  delete event.user
  delete event.contexts?.['request']
  if (event.message) event.message = scrubString(event.message)
  for (const ex of event.exception?.values ?? []) {
    if (ex.value) ex.value = scrubString(ex.value)
  }
  for (const b of event.breadcrumbs ?? []) {
    if (b.message) b.message = scrubString(b.message)
    delete b.data
  }
  delete event.extra
  return event
}

/** Start Sentry when configured. Safe to call more than once. */
export function initErrorTracking(): boolean {
  if (active) return true
  const dsn = (process.env['SENTRY_DSN_API'] ?? '').trim()
  if (!dsn) return false
  if (isSandbox()) {
    sandboxBlocks('error_report', { summary: 'error tracking is off in a practice copy' })
    return false
  }
  Sentry.init({
    dsn,
    environment: process.env['NODE_ENV'] || 'development',
    sendDefaultPii: false,
    tracesSampleRate: 0,
    // Uncaught exceptions keep Sentry's own handler (it flushes, then the process
    // exits as before). Rejections are captured by index.ts; no request capture.
    integrations: (defaults) => defaults.filter((i) => !['OnUnhandledRejection', 'Http', 'NodeFetch'].includes(i.name)),
    beforeSend: (event) => scrubEvent(event),
  })
  active = true
  return true
}

export const errorTrackingActive = (): boolean => active

/** A 5xx the Fastify error handler is about to answer. 4xx never gets here. */
export function captureServerError(err: unknown, ctx?: { method?: string; route?: string }): void {
  if (!active) return
  try {
    Sentry.withScope((scope) => {
      if (ctx?.method) scope.setTag('http.method', ctx.method)
      if (ctx?.route) scope.setTag('http.route', ctx.route)
      Sentry.captureException(err)
    })
  } catch { /* reporting must never break a request */ }
}

/** A worker / process-level crash. */
export function captureWorkerError(err: unknown, worker: string): void {
  if (!active) return
  try {
    Sentry.withScope((scope) => {
      scope.setTag('worker', worker)
      Sentry.captureException(err)
    })
  } catch { /* never throws */ }
}

/** Tests only. */
export function _resetErrorTrackingForTests(): void { active = false }
