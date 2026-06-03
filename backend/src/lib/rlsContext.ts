// Request-scoped row-level-security context.
//
// AsyncLocalStorage holds a mutable object for the lifetime of a Fastify
// request. The Prisma extension in lib/prisma.ts reads from it to set
// `app.tenant_id` and `app.customer_id` Postgres session vars before every
// query, so DB policies can gate row visibility.
//
// Background workers, webhook handlers, and startup code run outside any
// request — they must import `serviceClient` from lib/prisma.ts instead of
// `prisma`. `serviceClient` skips the extension and (once RLS rolls out)
// will connect as a BYPASSRLS Postgres role so jobs see everything.

import { AsyncLocalStorage } from 'node:async_hooks'

export interface RlsContext {
  /**
   * The tenants this request is allowed to touch. Single-tenant staff: one
   * element. Staff in portfolio mode: every tenant they're a member of.
   * Customers + workers: empty array — they're scoped by other means.
   */
  tenantIds?:   string[]
  customerId?:  string | null
  staffUserId?: string | null
}

const storage = new AsyncLocalStorage<RlsContext>()

/**
 * Run `fn` inside a fresh RLS context. The context object is mutable, so
 * downstream auth middleware can fill in `tenantId` / `customerId` once
 * the JWT has been verified — without having to wrap the rest of the
 * lifecycle in another `.run()` call.
 */
export function runWithRlsContext<T>(seed: RlsContext, fn: () => T): T {
  return storage.run({ ...seed }, fn)
}

/** Returns the current context, or undefined when called outside a request. */
export function getRlsContext(): RlsContext | undefined {
  return storage.getStore()
}

/**
 * Patch the active context in place. No-op when there is no active context
 * (workers, startup), so this is safe to call from shared middleware that
 * also runs in non-request settings.
 */
export function setRlsContext(patch: Partial<RlsContext>): void {
  const ctx = storage.getStore()
  if (!ctx) return
  Object.assign(ctx, patch)
}
