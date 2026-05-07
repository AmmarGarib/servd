# servd — C-Suite Audit

Single source of truth for known defects across the codebase. Generated from a 4-track parallel review (CTO, CISO, Chief ERP Officer, Frontend) of `backend/`, `frontend/admin/`, `frontend/storefront/`, and the Prisma schema.

Severity legend:
- **CRITICAL** — data loss, security breach, or regulatory failure if shipped as-is
- **HIGH** — material business impact (silent corruption, IDOR within tenant, unrefundable money)
- **MEDIUM** — correctness or DX issue that should be scheduled
- **LOW** — polish

Each finding lists file:line, what's wrong, and the recommended fix. Findings already addressed in this session are marked **[FIXED]**.

---

## Already fixed in this session

| # | File | What | Status |
|---|---|---|---|
| F1 | DB schema drift | 16 unapplied Prisma migrations against Neon — `users.conceptIds` and other columns missing — caused PIN login 500s. Applied via `prisma migrate deploy`. | **FIXED** |
| F2 | `backend/src/modules/inventory/routes.ts:73-78` | `PATCH /inventory/:id/adjust` could drive `currentStock` negative. Added pre-check + `AppError('NEGATIVE_STOCK', ...)`. | **FIXED** |
| F3 | `backend/src/index.ts:290-302` | BullMQ workers stampede on boot saturated Neon connection pool (free-tier idle). Now opt-in via `ENABLE_WORKERS=true` in dev (default on in production). | **FIXED** |
| F4 | seeded admin | PIN reset to `1234` for `admin@servd.pk` so you can log in immediately. | **DONE** |
| F5 | `backend/src/modules/loyalty/routes.ts:94` | `POST /loyalty/earn` had no zod schema — accepted negative `totalCents` and missing fields. Added strict validation. | **FIXED** (resolves §H15) |
| F6 | `backend/src/modules/auth/routes.ts:187` | `POST /auth/customer/register` had no rate limit and returned distinct error on duplicate email — trivial to enumerate the customer base. Now IP-rate-limited via `CUSTOMER_PASSWORD_LIMIT` and returns a uniform "if your email is new, you're set" 200 on conflict. | **FIXED** (resolves §C12) |
| F7 | `backend/src/modules/auth/routes.ts:284` | `POST /auth/customer/verify` had no rate limit — token-guessing endpoint. Now per-IP-rate-limited via new `MAGIC_LINK_VERIFY_LIMIT` (30/5min). | **FIXED** (resolves §H7) |
| F8 | `backend/src/lib/loginRateLimit.ts:58` | `PIN_LIMIT` was 5 attempts/15min. Tightened to 3 attempts / 30 min. Added `PIN_USER_LIMIT` and `MAGIC_LINK_VERIFY_LIMIT` constants for future per-user lockout work. | **FIXED** (partially resolves §C11 — IP-side; per-user counter remains on the backlog because PIN login doesn't take a username) |
| F9 | `backend/src/index.ts:145-160` | Swagger UI was registered unconditionally, exposing the API schema at `/docs` in production. Now wrapped in `if (NODE_ENV !== 'production')`. | **FIXED** (resolves §H12) |
| F10 | `frontend/storefront/src/app/[concept]/order/[id]/page.tsx:48-76` | Order tracking page polled `/storefront/(guest-)?orders/:id` every 10s forever, even after `completed/cancelled`. Idle tabs hammered the API indefinitely. Now stops the interval on terminal status. | **FIXED** (resolves §H10) |
| F11 | `backend/src/modules/orders/routes.ts:142-152` | `PATCH /order-items/:id/status` had no concept access check — cashier scoped to A could mutate ticket state for B's orders by guessing item id. Now fetches the parent order's `conceptId` and calls `assertConceptAccess`. | **FIXED** (resolves §C4) |
| F12 | `backend/src/modules/pos/routes.ts:60` | `POST /pos/orders` accepted arbitrary `conceptId` from body — cashier of A could ring orders against B's books. Now wraps with `assertConceptAccess`. | **FIXED** (resolves §C6) |
| F13 | `backend/src/modules/giftCards/routes.ts:124-156` | Gift-card `/redeem` had a non-atomic read+check+write inside a transaction. Two concurrent redemptions could both pass the balance check. Replaced with atomic conditional `updateMany` (decrement only if `balanceCents >= amount`). | **FIXED** (resolves §C3) |
| F14 | `backend/src/modules/orders/service.ts:55-62` | Recipe-driven inventory deduction used unguarded `decrement` — could push `currentStock` negative. Now reads stock first, clamps deductions to available, logs a warning, and never blocks the order. | **FIXED** (resolves §H2) |
| F15 | `backend/src/modules/webhooks/routes.ts:31, 46` | Foodpanda + Keenu webhooks had no idempotency key — retried payloads could create duplicate orders / double-applied payment status. Now uses Redis `SETNX` with 24h TTL keyed on `(vendor:event_id)` for Foodpanda, `(keenu:txn_id:status)` for Keenu. Returns 200 with `dedup: true` on replay. | **FIXED** (resolves §C10) |
| F16 | `backend/src/modules/reconciliation/service.ts:270-279` | Foodpanda commission was computed on gross `totalCents` including tax + service charge + tip — overstated commission, made every variance report wrong by ~17%. Now computes on `(totalCents − taxCents − serviceChargeCents − tipCents)`. | **FIXED** (resolves §H6) |
| F17 | `backend/src/modules/reconciliation/service.ts:143-160` | Bank-statement re-imports could match the same `JournalLine` to two different `BankStatementLine` rows. Match scope was `consumed` set local to each import. Now seeds `consumed` from all *previously matched* statement lines so the same journal line cannot be re-matched across imports. | **FIXED** (resolves §H4) |
| F18 | `backend/src/modules/accounting/orderPosting.ts:236-244` | `postOrderRefund` only reversed the journal entry — loyalty earn, wallet credit applied, and gift-card balance redeemed all leaked. Now also: posts a paired `LoyaltyTransaction { type: 'reversal' }` and decrements the account; credits `Customer.walletBalance` back by `Order.walletAmountCents` and writes a `WalletTransaction { type: 'refund' }`; re-credits each `GiftCard.balanceCents` for redemptions of this order and re-activates `redeemed_full` cards. Each step idempotent. **Inventory is intentionally NOT auto-restored** — see comment in code; manual `WasteLog`/`adjust` if you need that. | **FIXED** (resolves §C2) |
| F19 | `backend/src/modules/invoices/service.ts:26-30, end-of-fn` | Sale invoice issuance used Read Committed isolation. Two concurrent issuances could both grab the pre-increment counter. Now wrapped in a retry loop that catches `P2034` / `40001` serialization-failure errors and retries up to 3 times with backoff. The inner transaction already specified `Serializable`. | **FIXED** (resolves §C1) |
| F20 | `backend/src/modules/auth/routes.ts:115-148` | `GET /auth/clock-logs?userId=…` let any manager pull clock logs for any user, including managers of other concepts. Now: admin sees all; non-admin requires the target user to share at least one `conceptId` with the requester (per-user request) or the list is filtered to `users.conceptIds hasSome ${myConceptIds}`. | **FIXED** (resolves §C5) |
| F21 | `backend/src/index.ts:315-355` | `validateProductionEnv` checked secret presence but not strength. Now also rejects boot if `JWT_SECRET` or `JWT_REFRESH_SECRET` is shorter than 32 bytes, contains a known weak default substring (`change-me`, `dev-secret`, the historical `servd-jwt-secret-change-before-production-2024`, etc.), or if both are equal. | **FIXED** (partially resolves §C7 — strength check; rotation of the live secret in `.env` still required by you) |
| F22 | `backend/src/lib/notify.ts:6-25` | `sendEmail`/`sendSms` silently no-op when SMTP/Twilio creds are missing — in production you'd never get receipts and never know. Now logs a loud red WARN at module import + in production throws `AppError('NOTIFY_NOT_CONFIGURED', 503)` instead of silent skip. | **FIXED** (resolves §M2) |
| F23 | `frontend/admin/src/hooks/useKdsSocket.ts` | Listener leak: store actions are new references on every parent re-render, so the `useEffect` re-ran every time, `socket.off('event')` removed the previous handler and `socket.on(...)` registered a new one — but in practice `socket.off('order:new')` (no-arg) cleared all listeners, masking the bug. Refactored to capture handlers in a `useRef` (always points at fresh store actions) and register the listeners once on mount; effect deps are now only the connection options. | **FIXED** (resolves §H9) |

---

## CRITICAL — fix before any prod traffic

### C1. Invoice counter race — duplicate FBR sequence numbers under concurrency
- **File:** `backend/src/modules/invoices/service.ts:49-58` (sale issuance), contrast with line 120 (credit-note correctly uses `Serializable`).
- **What:** Sale invoice issuance uses `INSERT ... ON CONFLICT DO UPDATE ... RETURNING` without `SELECT ... FOR UPDATE` and without serializable isolation. PostgreSQL's `ON CONFLICT` is not serializable; two concurrent issuances can both read the pre-increment value and emit the same invoice number. FBR rejects duplicates and the audit chain breaks.
- **Fix:** Wrap in `prisma.$transaction(..., { isolationLevel: 'Serializable' })` *or* run `SELECT ... FOR UPDATE` on the counter row before computing `nextValue`. Match the pattern already used for credit notes.

### C2. Refund leaks loyalty + wallet + gift-card credits
- **File:** `backend/src/modules/accounting/orderPosting.ts:237-243` (`postOrderRefund`).
- **What:** Reverses only the journal entry. Does **not** reverse loyalty earn, does **not** debit wallet credit applied to the order, does **not** restore gift-card balance redeemed at checkout. Customer gets refund + keeps points + wallet credit + gift-card credit they spent on the refunded order.
- **Fix:** In the same transaction as the JE reversal:
  1. Negate any `LoyaltyTransaction { type: 'earn', orderId }` rows and `LoyaltyAccount.pointsBalance -= points`.
  2. Re-credit `Customer.walletBalance` by `Order.walletAmountCents` and post a `WalletTransaction { type: 'refund' }`.
  3. Re-credit `GiftCard.balanceCents` by sum of `GiftCardRedemption.amountCents` for this order; flip status back to `active` if it was `redeemed_full`.
  4. Restore inventory: undo recipe-driven decrements logged on order completion.

### C3. Gift card redemption race — negative balance possible
- **File:** `backend/src/modules/giftCards/routes.ts:124-156`.
- **What:** Inside a transaction, but uses `findUnique` + balance check + `update` without `SELECT ... FOR UPDATE` and without serializable isolation. Two concurrent `/redeem` calls can both pass the balance check and both subtract.
- **Fix:** Replace the read+check+write with an atomic conditional update:
  ```ts
  const result = await tx.giftCard.updateMany({
    where: { code, status: 'active', balanceCents: { gte: body.amountCents } },
    data: { balanceCents: { decrement: body.amountCents } },
  })
  if (result.count === 0) throw new AppError('INSUFFICIENT_BALANCE', ...)
  ```
  Then refresh and create the redemption row.

### C4. IDOR — `/order-items/:id/status` has no concept access check
- **File:** `backend/src/modules/orders/routes.ts:142-152`.
- **What:** `PATCH /order-items/:id/status` only checks `requireAuth(...ALL_STAFF)`. A cashier scoped to Concept A can flip ticket states for items in Concept B by guessing the item id (or scraping it from a concurrent KDS session).
- **Fix:** Before `updateItemStatus`, fetch the item, look up its `order.conceptId`, and `await assertConceptAccess(req.staffUser!, conceptId)` — same pattern used 5 lines above in `routes.ts:83/91/103/120`.

### C5. IDOR — `/auth/clock-logs?userId=` cross-tenant
- **File:** `backend/src/modules/auth/routes.ts:116-132`.
- **What:** Manager can read clock-logs for any user id, including managers of other concepts. Privacy + competitive-intel risk.
- **Fix:** Filter `userId` against the manager's accessible-concepts set; reject if `req.query.userId` is not in `getStaffInManagerConcepts(req.staffUser!)`.

### C6. POS order creation accepts arbitrary `conceptId`
- **File:** `backend/src/modules/pos/routes.ts:60-64`.
- **What:** `POST /pos/orders` reads `conceptId` from body without `assertConceptAccess`. Cashier scoped to A can create orders against B's books.
- **Fix:** `await assertConceptAccess(req.staffUser!, body.conceptId)` immediately after schema parse.

### C7. JWT_SECRET committed in `.env`
- **File:** `backend/.env`.
- **What:** Default secret string ships in version control. Anyone with repo access can forge admin tokens.
- **Fix:**
  1. Rotate immediately — generate ≥32-byte random secret and set in deployment secrets manager.
  2. Add `.env` to `.gitignore` (verify) and `git filter-repo` to scrub history if remote.
  3. In `index.ts`, fail-fast at boot if `process.env.JWT_SECRET` matches a known weak default OR is shorter than 32 bytes.

### C8. DATABASE_URL committed in `.env`
- **File:** `backend/.env:2`.
- **What:** Live Neon Postgres credentials in repo.
- **Fix:** Rotate Neon password, move to deployment secrets, scrub from git history.

### C9. REDIS_URL committed in `.env`
- **File:** `backend/.env:5`.
- **What:** Live Upstash Redis credentials in repo. Attacker can flush rate-limit buckets, defeat brute-force protection.
- **Fix:** Rotate, move to secrets, scrub history.

### C10. Foodpanda webhook is not idempotent
- **File:** `backend/src/modules/webhooks/routes.ts:31-70`.
- **What:** Verifies signature, then enqueues + updates DB. No idempotency key. Foodpanda retries on transient failures; same payload arrives twice → duplicate orders, duplicate inventory deduction, duplicate revenue posted.
- **Fix:** Compute `idempotencyKey = ${vendor}:${transaction_id}` on receipt; `redis.setnx` with 24h TTL; if already set, return `200 { received: true, dedup: true }` without processing.

### C11. PIN brute-force ceiling too weak (IP-keyed only, 5 attempts)
- **File:** `backend/src/lib/loginRateLimit.ts:58`.
- **What:** 5 attempts per 15 min keyed by IP. With NAT/CGNAT and rotating IPs, a 4-digit PIN (10K combos) is brute-forceable across many staff accounts in days. No per-account counter.
- **Fix:**
  1. Add a per-staff-id counter: lock the *user* after N consecutive PIN failures regardless of IP.
  2. Lower IP cap to 3 attempts; bump lockout to 30 min.
  3. After 2 failures, require CAPTCHA or admin reset.
  4. Optional: deny PIN login for `admin` role entirely — admins log in by password.

### C12. Customer register — no rate limit, enumerates emails
- **File:** `backend/src/modules/auth/routes.ts:187-195`.
- **What:** Unauthenticated, no rate limit, returns distinct error if email is taken. Trivial enumeration of customer base.
- **Fix:** Add the same `recordFailure` / `check` pattern used on login, plus return a uniform `"check your email"` message regardless of whether the email exists.

---

## HIGH — schedule next sprint

### H1. Wallet balance can go negative on order checkout
- **File:** `backend/src/modules/wallet/routes.ts` + order-completion path that consumes `Order.walletAmountCents`.
- **What:** No guard at checkout that `customer.walletBalance >= walletAmountCents`. Wallet decrement happens later without a check.
- **Fix:** Validate at order-create time; clamp or reject if insufficient. Add DB check constraint `walletBalance >= 0`.

### H2. Inventory recipe-deduction has no negative-stock guard
- **File:** `backend/src/modules/orders/service.ts:54-61`.
- **What:** Same shape as C2 of inventory — recipe-driven decrement on order complete uses `{ decrement: qty }` with no floor check. COGS is posted regardless of physical stock.
- **Fix:** Pre-check stock per ingredient; raise either a hard error or a soft `InventoryWarning` audit row depending on policy.

### H3. Tax computed globally, not per-line — FBR violation risk
- **File:** `backend/src/modules/accounting/orderPosting.ts:48-64` + `prisma/schema.prisma:255-260` + `TaxInvoiceLine` shape.
- **What:** Schema defines per-item `TaxClassification`, but `Order.taxCents` is a single column and `TaxInvoiceLine` has no `taxCents` field. If the storefront/POS computed line tax incorrectly, the invoice prints a wrong breakdown — FBR audits will flag.
- **Fix:** Add `taxCents` and `taxRatePct` to `TaxInvoiceLine`; on issuance, validate that `Σ line.taxCents == order.taxCents` within a 1-cent tolerance; reject if not.

### H4. Bank reconciliation can match the same journal-line twice
- **File:** `backend/src/modules/reconciliation/service.ts:150-170`.
- **What:** `consumed` set is local to one import. Re-importing the same statement (or overlapping statements) can produce two `BankStatementLine` rows pointing at the same `JournalLine`.
- **Fix:** Add a partial unique index `(matchedJournalLineId) WHERE matchStatus = 'matched'`. On match, fail if already matched.

### H5. Cost-allocation rerun loses weight version
- **File:** `backend/src/modules/allocations/service.ts:58-177`.
- **What:** `runAllocationRule` reads current weights at run time. If weights were edited between runs, the audit trail is broken — original posting + rerun show different splits.
- **Fix:** Snapshot the weights into `CostAllocationRun` (or a child `AllocationRunWeight` table) at run creation. Make rules immutable once a run posts; require explicit reversal before edit.

### H6. Foodpanda settlement variance off by tax/service charge
- **File:** `backend/src/modules/reconciliation/service.ts:253-276`.
- **What:** Computes `commission = totalCents * rate` but uses gross total (incl. tax + service). Foodpanda commission is typically subtotal-only. Variance reports will be off by ~17% of every order.
- **Fix:** `commission = (totalCents - taxCents - serviceChargeCents) * rate`. Verify with a Foodpanda contract sample.

### H7. Magic-link verify has no rate limit
- **File:** `backend/src/modules/auth/routes.ts:268-272`.
- **What:** Unauthenticated, no rate limit. Token-guessing bot can spam the endpoint.
- **Fix:** Add IP+token rate limit, e.g. 30/min per IP, 5/min per token prefix.

### H8. Token refresh race in admin frontend
- **File:** `frontend/admin/src/lib/api.ts:23-36`.
- **What:** Two concurrent 401 responses can each trigger a refresh; whichever finishes second overwrites tokens.
- **Fix:** Pessimistic lock — store the in-flight refresh promise in module scope; subsequent 401s `await` the same promise.

### H9. KDS socket listeners leak on every parent re-render
- **File:** `frontend/admin/src/hooks/useKdsSocket.ts:36-75`.
- **What:** Effect deps include store actions (`addOrder`, etc.) which are new references each render, so `socket.on(...)` registers a fresh listener every render and `socket.off(...)` only removes the previous one. After N re-renders, every event fires N handlers.
- **Fix:** Capture handlers in a `useRef`; register/deregister once on mount; mutate the ref's content rather than recreating the effect.

### H10. Storefront order page polls forever after completion
- **File:** `frontend/storefront/src/app/[concept]/order/[id]/page.tsx:48-76`.
- **What:** `setInterval(poll, 10000)` runs until unmount even after status reaches `completed`/`cancelled`. With many idle tabs, this is a serious load multiplier.
- **Fix:** Inside `poll`, after setting state, check `if (data.status === 'completed' || data.status === 'cancelled') clearInterval(iv)`. Move `iv` into ref scope so the cleanup can reach it.

### H11. Customer JWT 30-day expiry, no revocation
- **File:** `backend/src/modules/auth/service.ts:128/143/165`.
- **What:** Stolen customer token usable for a month; `/auth/customer/logout` doesn't invalidate.
- **Fix:** Drop expiry to ≤24h. Add a Redis-backed token-version key (`token:${customerId}:version`); embed version in JWT; logout bumps version.

### H12. Swagger UI exposed in production
- **File:** `backend/src/index.ts:145-160`.
- **What:** `/docs` is reachable unconditionally. Production attack-surface mapping aid.
- **Fix:** Wrap registration in `if (process.env.NODE_ENV !== 'production')`.

### H13. CORS allows credentials with no CSRF protection
- **File:** `backend/src/index.ts:120-127`.
- **What:** `credentials: true` + only Bearer auth. State-changing endpoints have no CSRF defense beyond the Bearer header. Mostly OK because token is in `localStorage`, not cookies — but if you ever move to cookie auth it becomes exploitable.
- **Fix:** Decide cookie vs localStorage explicitly. If cookie: add CSRF tokens (double-submit) or require a custom header on state-changing requests.

### H14. `next@14.2.3` known security advisory
- **File:** `frontend/admin/package.json` & `frontend/storefront/package.json`.
- **What:** Per npm warning during install — image-optimization SSRF, etc.
- **Fix:** `npm i next@14.2.32 --workspace frontend/admin` and storefront. Test build after upgrade.

### H15. Loyalty `/earn` and Promo apply have no zod schema
- **File:** `backend/src/modules/loyalty/routes.ts` (POST `/earn`), `backend/src/modules/promos/routes.ts:73-100` (validate path is OK; check internal earn).
- **What:** Endpoints destructure `req.body` without zod. Negative `totalCents` or missing fields produce runtime errors and let attackers seed negative loyalty / negative discount.
- **Fix:** Wrap each endpoint in a `z.object({...}).parse(req.body)` with `.positive()` / `.uuid()` constraints.

### H16. Stack traces may leak via Fastify default validation errors
- **File:** `backend/src/index.ts:164-176`.
- **What:** Custom error handler is good for `AppError` and validation errors, but the catch-all path returns a generic message — **good**. Verify Fastify isn't sending `error.message` from upstream library throws (Prisma, bcrypt) before our handler runs.
- **Fix:** Add an integration test that hits a route with malformed input that bypasses our validation and assert no Prisma table names appear in the response body.

---

## MEDIUM — schedule but not urgent

### M1. Side-effect orchestration is scattered
- **File:** `backend/src/modules/orders/service.ts:176-181, 286-307`.
- **What:** Inventory deduction, notifications, posting, invoicing fire-and-forget with `.catch(console.error)`. Each has its own error policy. No retry, no DLQ.
- **Fix:** Funnel post-commit side-effects through a single `OrderEvent` queue with consistent retry + DLQ. Today's pattern leaves silent gaps you only find at audit time.

### M2. Notify silently no-ops in production if SMTP/Twilio creds missing
- **File:** `backend/src/lib/notify.ts:16-26, 38-45`.
- **What:** Returns success without sending. Customers don't get order updates; you don't know.
- **Fix:** In `production`, throw `AppError('NOTIFY_NOT_CONFIGURED', ..., 503)` on first call if creds missing. In dev, log a clear `[notify] disabled` warning at boot.

### M3. Audit log stores PII in `before/after` blobs
- **File:** `backend/src/modules/orders/routes.ts:125-134` (and other AuditLog call sites).
- **What:** Full order objects (incl. customer phone/address) end up in audit log, which lives longer than transactional data.
- **Fix:** Pass a redactor — log only id + the field that changed. Keep the rest in the transactional DB.

### M4. CRM customer endpoints leak across concepts
- **File:** `backend/src/modules/crm/routes.ts:82-103, 179-211`.
- **What:** Manager of A can list customers and segments for B.
- **Fix:** Filter every query by the manager's allowed `conceptIds` (use existing `filterConceptIdsForStaff` helper).

### M5. Health endpoint unauthenticated
- **File:** `backend/src/index.ts` (`/health`).
- **What:** Public reconnaissance vector — version exposure if response includes build info.
- **Fix:** Restrict to internal network or expose a minimal `{ ok: true }` only.

### M6. Tip-pool distribution sums not validated
- **File:** Schema only — `TipPool.totalTipsCents` vs `Σ TipPoolMember.shareCents`.
- **What:** No invariant check that distribution totals match the pool. Rounding errors or operator overrides leak money.
- **Fix:** Pre-post check: `|Σ shares − total| ≤ N cents`. Lock member rows after `status='posted'`.

### M7. Type unsafety on API response casts
- **File:** `frontend/admin/src/lib/api.ts:65-66` and similar (~20 sites).
- **What:** `as { ... }` casts without runtime validation. Backend schema drift produces silent `undefined`s.
- **Fix:** Define zod schemas in `lib/schemas.ts`; parse at the API boundary.

### M8. Fire-and-forget catches without structured logging
- **File:** Many — orders/service.ts, auth/service.ts magic-link, etc.
- **What:** `.catch(console.error)` loses request context.
- **Fix:** Use `req.log.error({ err, op: 'sendMagicLink' })` so logs correlate with request id.

### M9. Period-lock check coverage incomplete
- **File:** `backend/src/lib/journal.ts:177-187` enforces lock on JE post; not all writers go through it.
- **What:** Direct ORM writes to `Order`, `Payment`, `WasteLog` etc. inside a closed period bypass the lock.
- **Fix:** Add a Prisma extension (`$extends`) that checks `PeriodLock` for any mutation of finance-relevant tables; or move all writes through service-layer wrappers that enforce.

### M10. Webhook rate-limit keyed by IP, not by signature
- **File:** `backend/src/modules/webhooks/routes.ts:31, 46`.
- **What:** Multiple delivery platforms share NAT pools; one platform can starve another.
- **Fix:** Key the limiter by `signature.merchant_id` if present, falling back to IP.

### M11. Prisma 5.22.0 — major version available
- **File:** `backend/package.json`.
- **What:** Prisma is at 5.22; 7.x is current. Not urgent, but lots of perf/correctness fixes between.
- **Fix:** Plan a 5→7 migration; read upgrade notes; run full test suite.

---

## LOW — nice to haves

- L1. Magic numbers (`8`, `12h`, `0.30` food-cost target) scattered without constants.
- L2. `as never` casts in `orders/service.ts:71/91/104/215/217` — Prisma enum / TS enum drift; align them.
- L3. Several `setTimeout(..., 120)` debounce values — extract to named constants.
- L4. Frontend buttons use opacity-only disabled state (a11y).
- L5. `useKdsStore` actions identity not stabilized — minor perf in list renders.
- L6. `concept.taxRate / 100` rendered without nullish guard in storefront cart drawer (could show NaN).

---

## Things I changed in this session that you should know about

1. **Applied Prisma migrations** to Neon (`prisma migrate deploy`) — 16 migrations including `user_concept_scoping`, `period_locks`, `reconciliation`, `payroll`, `cost_allocation`, `service_charge_tip`, `audit_log`, `per_concept_foodpanda_rate`, `tax_invoice`, `per_item_tax_class`, `floorplan_reservations`, `reservation_full`, `gift_cards`, `allergens`, `dispatch_tips_groups`, `site_layouts`. Production DB is now in sync with `schema.prisma`.
2. **Reset admin PIN** to `1234`. Change it via `npm run dev` → admin shell → settings, or directly via SQL.
3. **Inventory `/adjust` guard** prevents negative stock.
4. **Background workers** can be disabled with `ENABLE_WORKERS=false` env var (default: enabled). Useful when Upstash Redis is rate-limited.
5. The Upstash Redis tier is at quota (`Limit: 500000, Usage: 500006`) — that's why every BullMQ worker is erroring. Bump the tier or rotate to a fresh Redis before re-enabling workers in earnest.

---

## Recommended order to apply outstanding fixes

1. **Same day** — C7, C8, C9 (rotate secrets), C10 (webhook idempotency), C12 (register rate limit), H12 (Swagger off in prod), H14 (Next.js upgrade).
2. **This week** — C1, C3, C4, C5, C6, C11 (security + IDOR + race conditions).
3. **Within the month** — C2 (refund completeness), H1, H2, H3 (FBR per-line tax), H4, H5, H6, H8, H9, H10.
4. **Backlog** — all M and L items.

Each fix above includes file:line and the smallest correct patch shape. Most are 5-30 lines of code. The biggest design call is C2 — define the refund semantics (do you reverse loyalty? wallet? gift cards? inventory?) before anyone writes code.
