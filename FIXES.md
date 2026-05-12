# servd — Fix Plan for Claude Code

**How to use this file.** Each fix is self-contained: it states the file, the problem in one sentence, the concrete change, and a verification step. Work through them in order — they are grouped by phase and sequenced so earlier fixes do not invalidate later ones. Where a fix needs a schema change, the migration name is suggested in `snake_case`.

**Conventions.**
- File paths are repo-relative from `C:\Dev\servd`.
- `BEFORE` / `AFTER` blocks show the literal edit. Treat them as source-of-truth — when comments differ from the existing code, preserve the existing comment style.
- Lines marked `VERIFY:` are the acceptance check. Run them before marking the fix done.
- Where a fix says "decide first," do not execute until the human has answered the linked question.

---

## Phase 0 — Strategic decision (BLOCKING for some fixes)

### D01 · Decide multi-tenancy direction (blocks B10, F-IA work, KILL list)
**Question for the human:** Is servd SaaS or single-tenant for v1?
- **A (single-tenant, kill SaaS):** Execute D01-A actions below.
- **B (multi-tenant, embrace SaaS):** Skip D01-A, treat the tenant module as canonical, rewrite the spec doc.
- **C (fence SaaS as latent):** Worst outcome — do not pick.

Until this is answered, do not execute KILL items in §K or the `tenants` simplification in B10.

**D01-A actions if the answer is single-tenant:**
1. Stop accepting new tenants: comment out `POST /tenants/signup` in `backend/src/modules/tenants/routes.ts:181-299` with a `// SINGLE_TENANT_DECISION: ...` comment.
2. Hide `/welcome` and admin `/signup` from the router via a feature flag (`process.env.SAAS_MODE === 'true'`).
3. After all other fixes ship, return to §K KILL list.

---

## Phase 1 — Stop the bleeding (Week 1)

### B01 · Token-type checks in `requireAuth` and split PIN/refresh verifiers
**File:** `backend/src/modules/auth/service.ts`, `backend/src/modules/auth/middleware.ts`
**Problem:** `verifyStaffToken` returns success for `access | refresh | pin` and `requireAuth` does not filter by type.

**Steps:**
1. In `service.ts:292-303`, change `verifyStaffToken` signature to accept an `expected: 'access'|'refresh'|'pin'` parameter and `throw new ApiError('INVALID_TOKEN_TYPE', 401)` when the JWT `type` claim does not match.
2. In `middleware.ts`, replace the single `requireAuth` with three functions:
   ```ts
   export async function requireAuth(req: FastifyRequest)      { await verifyStaffToken(token, 'access'); ... }
   export async function requirePinSession(req: FastifyRequest){ await verifyStaffToken(token, 'pin');    ... }
   export async function requireRefresh(req: FastifyRequest)   { await verifyStaffToken(token, 'refresh'); ... }
   ```
3. Wire `requirePinSession` on `kds/*` PIN-only endpoints (`backend/src/modules/kds/routes.ts`).
4. Use `requireRefresh` only on the `/auth/refresh` route.

**VERIFY:** Sign a `type:'pin'` token, hit `GET /api/v1/orders` — expect 401 `INVALID_TOKEN_TYPE`. Sign a `type:'access'` token, hit the same endpoint — expect 200.

---

### B16 · `verifyCustomerToken` enforces `type:'customer'`
**File:** `backend/src/modules/auth/service.ts:305-311` and the JWT signing sites for customers (search `jwt.sign` in `auth/service.ts` and `storefront/routes.ts`).

**Steps:**
1. At every customer-token signing site, add `type: 'customer'` to the payload.
2. In `verifyCustomerToken`, after `jwt.verify`, check `payload.type === 'customer'`; throw `INVALID_TOKEN_TYPE` otherwise.
3. Existing customer tokens will fail validation on rollout — accept this; customers will re-login.

**VERIFY:** Old staff-access JWT must not authenticate `GET /api/v1/customer/me`.

---

### B05 · Require JWT on WebSocket connect; drop global `io.emit`
**File:** `backend/src/lib/ws.ts:39-58, 65-96, 215`

**Steps:**
1. Wrap the existing token check in a strict block:
   ```ts
   io.use(async (socket, next) => {
     const token = socket.handshake.auth?.token || socket.handshake.query?.token;
     if (!token) return next(new Error('UNAUTHORIZED'));
     try {
       const payload = await verifyStaffToken(token as string, 'access');
       socket.data.user = payload;
       return next();
     } catch (err) {
       return next(new Error('UNAUTHORIZED'));
     }
   });
   ```
2. Remove the `if (token) { ... }` permissive branch in the connection handler — `io.use` has already validated.
3. Search for `io.emit(` across `backend/src` — for each call, replace with a room-targeted broadcast (e.g. `io.to('concept:' + conceptId).emit(...)`).
4. Add `socket.data.user` tenant scoping when handling `subscribe`/room-join events.

**VERIFY:** Connect a socket without auth — connection refused. Connect with valid token, subscribe to a station from a different tenant — refused.

---

### B15 · KDS device auto-registration gated by auth + role
**File:** `backend/src/lib/ws.ts:65-96`

**Steps:**
1. After B05's `io.use`, the connection handler has `socket.data.user`. Verify role:
   ```ts
   const allowed: UserRole[] = ['kitchen', 'expediter', 'admin', 'manager'];
   if (!allowed.includes(socket.data.user.role)) return socket.disconnect(true);
   ```
2. When upserting `KdsDevice`, scope by `tenantId: socket.data.user.tenantId`.
3. Add a 1-per-second rate limit on the upsert call (in-memory Map keyed on `userId+stationId`).

**VERIFY:** A `cashier`-role token cannot upsert a KDS device.

---

### B04 · HMAC verification fix (strip prefix, hex decode, lowercase)
**File:** `backend/src/modules/webhooks/routes.ts:28-35`

**Steps:**
1. Replace `verifyHmac` body:
   ```ts
   function verifyHmac(rawBody: Buffer, signature: string | undefined, secret: string): boolean {
     if (!signature || !secret) return false;
     const cleaned = signature.toLowerCase().replace(/^sha256=/, '').replace(/^hmac-sha256=/, '').trim();
     if (!/^[0-9a-f]+$/.test(cleaned)) return false;
     const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
     try {
       const a = Buffer.from(cleaned, 'hex');
       const b = Buffer.from(expected, 'hex');
       return a.length === b.length && crypto.timingSafeEqual(a, b);
     } catch { return false; }
   }
   ```
2. Confirm every webhook call site passes the **raw body buffer**, not the parsed JSON. Add `config: { rawBody: true }` on each `fastify.post('/webhooks/...')` if not already set.

**VERIFY:** Add `backend/test/webhooks-hmac.test.ts` with known-good `payload + secret → sig` pairs for Foodpanda, Careem, Keenu sandbox samples; assert `true`. Also assert prefix `sha256=<hex>` variant verifies.

---

### B13 · `verifyHmac` Buffer encoding
**Already addressed in B04.** Skip.

---

### B02 · Load `concept.foodpandaCommissionRate` in commission write paths
**File:** `backend/src/modules/orders/service.ts:638`, `backend/src/modules/pos/service.ts:271`

**Steps:**
1. In `orders/service.ts:638`, replace:
   ```ts
   const commissionRate = order.source === 'foodpanda' ? 0.25 : 0
   ```
   with:
   ```ts
   const commissionRate = order.source === 'foodpanda'
     ? (concept.foodpandaCommissionRate ?? 0.25)
     : 0;
   ```
   Where `concept` is loaded earlier in the function. If not loaded, prepend `const concept = await tx.concept.findUnique({ where: { id: order.conceptId } });`.
2. Same pattern in `pos/service.ts:271`.
3. Grep `0.25` across `backend/src/modules` to confirm no other hardcoded copies remain.

**VERIFY:** `grep -nR "0\.25\|0,25" backend/src/modules` returns only test fixtures.

---

### B08 · Tighten Zod schemas for FK fields
**File:** `backend/src/modules/pos/routes.ts:11` and all other route files

**Steps:**
1. Change `tableId: z.string().nullable().optional()` to `z.string().uuid().nullable().optional()`.
2. Run `grep -nR "z\.string()\.nullable\.optional\|z\.string()\.optional" backend/src/modules/*/routes.ts` and audit every match — if the field is a FK, add `.uuid()`.

**VERIFY:** `curl -X POST .../pos/orders -d '{"tableId":"not-a-uuid",...}'` returns 400 with a Zod error, not 500.

---

### F19 · Decide and ship one signup path
**Files:** `frontend/storefront/src/app/signup/page.tsx`, `frontend/storefront/src/app/auth/verify/page.tsx`, `backend/src/modules/auth/*` (customer routes)

**Question for the human (BLOCKING):** Phone+OTP per spec, or email+password as shipped?

**If phone+OTP (spec):**
1. Rewrite `signup/page.tsx` form to `{name, email, phone}` — drop password fields and submit handler that calls `POST /auth/customer/signup`.
2. New handler `POST /auth/customer/request-otp` (backend) — generate 6-digit OTP, store in `magic_links` with `expiresAt = now + 5min`, send via Twilio SMS.
3. New page `frontend/storefront/src/app/auth/verify-otp/page.tsx` — 6 input boxes, submit to `POST /auth/customer/verify-otp` which returns a customer JWT.
4. Delete `auth/verify/page.tsx` if it is now unreachable.

**If email+password (shipped):**
1. Update `_legacy/docs/servd_spec_v4.docx` and the source-of-truth spec doc accordingly.
2. Delete `auth/verify/page.tsx` (dead code; signup returns a token immediately).
3. Remove magic-link infrastructure if unused elsewhere.

**VERIFY:** A new customer can sign up end-to-end through one path; no dead routes.

---

### F05 · WS-connected indicator on KDS header
**File:** `frontend/admin/src/components/kds/KdsHeader.tsx`, `frontend/admin/src/hooks/useKdsSocket.ts`

**Steps:**
1. In `useKdsSocket.ts`, expose `connected: boolean` and `lastOrderAt: Date | null` from the hook:
   ```ts
   const [connected, setConnected] = useState(socket.connected);
   useEffect(() => {
     const onC = () => setConnected(true);
     const onD = () => setConnected(false);
     socket.on('connect', onC); socket.on('disconnect', onD);
     socket.io.on('reconnect_attempt', onD);
     return () => { socket.off('connect', onC); socket.off('disconnect', onD); socket.io.off('reconnect_attempt', onD); };
   }, [socket]);
   ```
2. Track `lastOrderAt` in the same hook, updated on `order:new`.
3. In `KdsHeader.tsx`, add to the header bar:
   ```tsx
   <div className="flex items-center gap-2 text-sm">
     <span className={`h-2.5 w-2.5 rounded-full ${connected ? 'bg-green-500' : 'bg-red-500 animate-pulse'}`} />
     <span className="text-kds-subtext">{connected ? 'Live' : 'Reconnecting…'}</span>
     {lastOrderAt && <span className="text-kds-subtext">· last order {format(lastOrderAt, 'HH:mm')}</span>}
   </div>
   ```

**VERIFY:** Kill the backend mid-shift, watch the indicator flip red within 5s; restart, watch it flip green.

---

## Phase 2 — Money & races (Weeks 2–4)

### B03 · Atomic order completion + unique constraint on FinancialEntry.orderId
**Files:** `backend/src/modules/orders/service.ts:528-577`, `backend/src/modules/kds/routes.ts:200-219`, `backend/prisma/schema.prisma`

**Steps:**
1. New migration `prisma/migrations/20260520000000_unique_financial_entry_order/migration.sql`:
   ```sql
   -- Dedupe existing duplicates first (keep oldest)
   DELETE FROM financial_entries fe USING financial_entries fe2
     WHERE fe.id > fe2.id AND fe.order_id = fe2.order_id AND fe.order_id IS NOT NULL;
   CREATE UNIQUE INDEX financial_entries_order_id_key ON financial_entries(order_id) WHERE order_id IS NOT NULL;
   ```
2. In `schema.prisma`, add `@unique` on `FinancialEntry.orderId` (matching the partial index above with `Prisma`'s `@@index` is not perfectly expressive — use the SQL above and add `@@unique([orderId])` on the model so Prisma sees it).
3. Rewrite `updateItemStatus` (`orders/service.ts:528-577`) to do everything inside one transaction:
   ```ts
   await prisma.$transaction(async (tx) => {
     await tx.orderItem.update({ where: { id }, data: { status: nextStatus, bumpedAt: ... } });
     const items = await tx.orderItem.findMany({ where: { orderId } });
     const allDone = items.every(i => i.status === 'bumped' || i.status === 'voided');
     if (!allDone) return;
     const result = await tx.order.updateMany({
       where: { id: orderId, status: { not: 'completed' } },
       data: { status: 'completed', completedAt: new Date() },
     });
     if (result.count === 0) return; // someone else completed it first
     // side-effects use tx
     await postOrderCompletion(tx, orderId);  // loyalty, financial, FBR — all in tx
   });
   ```
4. Replace the `findFirst` guard in `createFinancialEntry` with `try { tx.financialEntry.create(...) } catch (e) { if (e.code === 'P2002') return; throw e; }`.
5. Delete the redundant allDone check in `kds/routes.ts:200-219` — it must call the same `updateItemStatus` path.

**VERIFY:** Add `backend/test/order-completion-race.test.ts` that spawns two parallel `bump` calls on the last two items of a 2-item order. Assert exactly one `FinancialEntry`, one loyalty `earn` transaction, one `completed` audit row.

---

### B06 · Move inventory deduction into the order transaction (outbox pattern)
**File:** `backend/src/modules/orders/service.ts:13-116, 237-251`

**Steps:**
1. New table via migration `20260521000000_order_outbox/migration.sql`:
   ```sql
   CREATE TABLE order_outbox (
     id            BIGSERIAL PRIMARY KEY,
     order_id      UUID NOT NULL,
     job_type      TEXT NOT NULL,
     payload       JSONB NOT NULL,
     created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
     processed_at  TIMESTAMPTZ NULL
   );
   CREATE INDEX order_outbox_pending_idx ON order_outbox(created_at) WHERE processed_at IS NULL;
   ```
2. In `ingestOrder`, inside the existing transaction, insert one outbox row per job type (`deduct_inventory`, `notify_new_order`, `customer_rollup`, `course_pacing_schedule`).
3. New worker `backend/src/workers/orderOutboxWorker.ts` that selects pending rows in batches, dispatches to the right service, sets `processed_at` on success. Run every 2s.
4. Inside `deductInventoryForOrder`, wrap the decrement in a row-level lock:
   ```ts
   await tx.$executeRaw`SELECT * FROM inventory_items WHERE id = ${itemId} FOR UPDATE`;
   ```
   And do the auto-86 check on the same locked row inside the same transaction.
5. Drop the existing `.catch()` fire-and-forget calls — outbox now owns them.

**VERIFY:** Kill the backend between order creation and outbox processing; restart; confirm inventory deducts on the next worker tick. Run two parallel orders on the last unit of an ingredient — exactly one succeeds, one fails the auto-86 emit.

---

### B14 · Webhook idempotency to Postgres
**Files:** `backend/src/modules/webhooks/routes.ts:44-51`, new migration

**Steps:**
1. Migration `20260522000000_webhook_event_log/migration.sql`:
   ```sql
   CREATE TABLE webhook_events (
     source       TEXT NOT NULL,
     event_id     TEXT NOT NULL,
     received_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
     payload_hash TEXT,
     PRIMARY KEY (source, event_id)
   );
   ```
2. Replace `claimIdempotency` (currently Redis SETNX) with:
   ```ts
   async function claimIdempotency(source: string, eventId: string): Promise<boolean> {
     try {
       await prisma.webhookEvent.create({ data: { source, eventId } });
       return true;
     } catch (e: any) {
       if (e.code === 'P2002') return false;
       throw e;
     }
   }
   ```
3. Keep Redis as an optional fast-path: check Redis first, on miss check Postgres. If Redis is down, fall through to Postgres (and log a warning).

**VERIFY:** Replay a Foodpanda webhook twice in quick succession with Redis down — second call returns 200 with `dedup: true` and creates no new order.

---

### B19 · Order/item state machine
**File:** `backend/src/modules/orders/service.ts:422-524`, `backend/src/modules/kds/routes.ts:131-258`

**Steps:**
1. Define allowed transitions in `backend/src/lib/orderStateMachine.ts`:
   ```ts
   export const ORDER_TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
     received:  ['confirmed', 'cancelled', 'rejected'],
     confirmed: ['preparing', 'cancelled', 'rejected'],
     preparing: ['ready', 'cancelled'],
     ready:     ['completed', 'cancelled'],
     completed: ['refunded'],
     cancelled: [],
     rejected:  [],
     refunded:  [],
   };
   export const ITEM_TRANSITIONS: Record<ItemStatus, ItemStatus[]> = { ... };
   ```
2. In `updateOrderStatus`, before the update:
   ```ts
   const cur = await tx.order.findUnique({ where: { id }, select: { status: true } });
   if (!cur || !ORDER_TRANSITIONS[cur.status].includes(next)) {
     throw new ApiError('INVALID_TRANSITION', 409);
   }
   ```
3. Make the update atomic-conditional: `tx.order.updateMany({ where: { id, status: cur.status }, data: { status: next } })` and check `result.count === 1`.
4. Same pattern in `updateItemStatus`.

**VERIFY:** Attempt to move a `completed` order back to `received` via API — 409.

---

### B11 · Migrate `currentStock` to Decimal
**File:** `backend/prisma/schema.prisma:1548`, new migration

**Steps:**
1. Migration `20260523000000_inventory_decimal/migration.sql`:
   ```sql
   ALTER TABLE inventory_items
     ALTER COLUMN current_stock TYPE numeric(14,4) USING current_stock::numeric(14,4);
   ALTER TABLE inventory_items
     ALTER COLUMN par_level TYPE numeric(14,4) USING par_level::numeric(14,4);
   ALTER TABLE inventory_items
     ALTER COLUMN reorder_point TYPE numeric(14,4) USING reorder_point::numeric(14,4);
   ```
2. In `schema.prisma`, change `currentStock Float` → `currentStock Decimal @db.Decimal(14, 4)`.
3. Search call sites — wherever `currentStock` is read, it's now `Prisma.Decimal`; use `.toNumber()` or `.toFixed()` for display, `Prisma.Decimal` arithmetic for math.
4. Update the raw SQL decrement to use numeric arithmetic (already safe since Postgres handles it).

**VERIFY:** Decrement an ingredient 10,000 times by 0.0001; final balance is exact, not drifted.

---

### F14 · Enforce required modifier groups in POS
**File:** `frontend/admin/src/app/pos/page.tsx:242-303`

**Steps:**
1. Add state: `const [selectedByGroup, setSelectedByGroup] = useState<Record<string, Set<string>>>({});`
2. On modifier toggle, mutate `selectedByGroup[groupId]` accordingly.
3. Compute `canConfirm`:
   ```ts
   const canConfirm = (item.modifierGroups || []).every(g => {
     const sel = selectedByGroup[g.id]?.size ?? 0;
     return sel >= (g.minSelect ?? 0) && sel <= (g.maxSelect ?? Infinity);
   });
   ```
4. Bind to the confirm button: `<button disabled={!canConfirm}>Add</button>`.
5. Show inline error under each group when `sel < minSelect`.

**VERIFY:** Open a menu item with `minSelect: 1` on the protein group. Try to confirm without choosing — button is disabled and group shows "Choose at least 1".

---

### F13 · POS qty buttons sized + aria-labelled
**File:** `frontend/admin/src/components/pos/PosCart.tsx:53, 59, 73`

**Steps:**
1. Replace `h-8 w-8` with `h-11 w-11` on the +/- buttons.
2. Add `aria-label="Increase quantity"` / `"Decrease quantity"` / `"Remove line"`.
3. Bump button text size to `text-base` for readability.

**VERIFY:** Touch-test on iPad — adjacent buttons no longer mistaps. Screen reader reads each button's purpose.

---

### F09 · Bump KDS subtext contrast
**File:** `frontend/admin/src/app/globals.css` and `frontend/admin/tailwind.config.ts`

**Steps:**
1. In `tailwind.config.ts`, change `kds-subtext: '#999999'` → `'#C9C9C9'`.
2. In `globals.css`, ensure no overrides clamp it back. Add a stronger override for the hot state:
   ```css
   .ticket-card.age-hot .kds-subtext { color: #EAEAEA; }
   .ticket-card.age-warm .kds-subtext { color: #E4E4E4; }
   ```

**VERIFY:** Use a contrast-checker (axe DevTools) on a ticket aged > hot threshold — subtext passes WCAG AA.

---

### F36 · Global focus-visible ring on admin
**File:** `frontend/admin/src/app/globals.css`

**Steps:**
1. At the top of `globals.css`, after Tailwind directives, add:
   ```css
   @layer base {
     *:focus-visible {
       outline: 2px solid #00D4B1;
       outline-offset: 2px;
       border-radius: 4px;
     }
   }
   ```

**VERIFY:** Tab through `/dashboard` — every interactive element shows a teal ring.

---

### F35 · `htmlFor` codemod across both apps
**Files:** all `frontend/admin/src/app/**/*.tsx` and `frontend/storefront/src/app/**/*.tsx`

**Steps:**
1. Write a node script `scripts/label-codemod.mjs` that walks `<label>` JSX siblings of `<input id="...">` and adds `htmlFor={id}`. If the input has no `id`, generate one from the label text.
2. Run the codemod, commit; manual review for missed cases (textarea, select).
3. Add an eslint rule `jsx-a11y/label-has-associated-control` and fail CI on violation.

**VERIFY:** Run `npx eslint --rule '{"jsx-a11y/label-has-associated-control":"error"}' frontend/**/*.tsx` — clean.

---

### F43 · Single source of truth for the auth token
**File:** `frontend/admin/src/store/auth.ts`, `frontend/admin/src/lib/api.ts`, `frontend/admin/src/lib/socket.ts`, `frontend/admin/src/components/kds/TicketCard.tsx:72`

**Steps:**
1. In `store/auth.ts`, delete the `localStorage.setItem('servd_token', ...)` mirror.
2. Replace all `localStorage.getItem('servd_token')` reads with `useAuthStore.getState().token`.
3. In `lib/socket.ts`, refactor `getSocket()` to a factory that subscribes to the auth store; on token change, `disconnect()` and reconnect with the new token (via `socket.auth = { token }; socket.connect()` pattern).
4. In `lib/api.ts`, the axios interceptor already reads from the store via `getToken()` — confirm and remove any direct `localStorage` reads.

**VERIFY:** Log out — `localStorage` has no `servd_token` key after. Token refresh during a long shift — WS reconnects automatically with the new token.

---

## Phase 3 — Finish the spec promises (Weeks 5–8)

### F-FP01 · Foodpanda outbound: status push
**File:** new `backend/src/adapters/foodpanda/outbound.ts`, hook into `orders/service.ts` order-status side-effects

**Steps:**
1. Implement `pushOrderStatus(externalOrderId, status: 'accepted'|'preparing'|'ready'|'completed')` per Foodpanda's Vendor API spec (https://developers.foodpanda.com). Get the API key from `setting.foodpanda_api_key`.
2. In the order completion side-effects (the `postOrderCompletion` function added in B03), call `pushOrderStatus` when `order.source === 'foodpanda'`.
3. Retry on 5xx with exponential backoff via BullMQ.

**VERIFY:** Place a sandbox Foodpanda order, complete it on KDS — Foodpanda dashboard reflects the status within 10s.

---

### F-FP02 · Foodpanda outbound: availability + menu sync
**File:** `backend/src/workers/inventorySync.ts:79`, new helpers in `adapters/foodpanda/outbound.ts`

**Steps:**
1. Implement `setItemAvailability(menuItemId, available: boolean)` calling `PATCH /menus/{menuId}/items/{itemId}` per Foodpanda docs.
2. Replace the TODO comment with a real call:
   ```ts
   if (item.foodpandaItemId) await foodpanda.setItemAvailability(item.foodpandaItemId, false);
   ```
3. Add a nightly `syncMenu` job that pushes full menu state to Foodpanda (handles ad-hoc drift).
4. Same pattern for Careem.

**VERIFY:** Auto-86 a menu item — Foodpanda customers see it as unavailable within 30s.

---

### F-POS01 · POS loyalty redeem (and parity for wallet, promo, gift card)
**Files:** `frontend/admin/src/components/pos/PaymentModal.tsx`, `backend/src/modules/pos/{routes,service}.ts`

**Steps:**
1. In `PaymentModal.tsx`, add four optional sections above the tender selection:
   - Loyalty redemption (input: points to redeem, validates against customer balance)
   - Promo code (input + apply button)
   - Wallet (toggle: use wallet balance, shows current balance)
   - Gift card (input: code, apply)
2. Add a "Link customer" step at the start of POS sale (search by phone or scan loyalty barcode).
3. Backend: extend `POST /pos/orders` body to accept `loyaltyRedeemPts`, `promoCode`, `useWallet`, `giftCardCode`. Reuse the atomic apply logic from `storefront/routes.ts:482-628` — extract to `backend/src/lib/orderDiscounts.ts` and call from both POS and storefront.
4. Update `PaymentModal` totals math to subtract these discounts before showing tender amount.

**VERIFY:** A regular customer pays at POS using 200 loyalty points + 500 wallet + 100 PKR promo — balances decrement atomically, journal entry shows three discount lines.

---

### F-PAY01 · Keenu sandbox round-trip
**File:** `backend/src/adapters/payment/keenu.ts`

**Steps:**
1. Get the real Keenu sandbox credentials and API spec (escalate to vendor; the existing adapter comment admits the field names are placeholders).
2. Rewrite the adapter against the real spec — `initiatePayment`, `verifyPayment`, `refundPayment`.
3. Add `POST /webhooks/keenu` route using the HMAC verifier from B04.
4. End-to-end test: place a storefront order, pay with Keenu sandbox, complete → financial entry posts.

**VERIFY:** Successful sandbox payment reflects in `payments` table with `status:'paid'` and `gateway:'keenu'`.

---

### F-PAY02 · JazzCash + Easypaisa adapters (or remove enum values)
**Files:** `backend/src/adapters/payment/jazzcash.ts`, new `backend/src/adapters/payment/easypaisa.ts`, `backend/prisma/schema.prisma`

**Steps:**
- **If shipping:** implement against JazzCash Merchant API and Easypaisa Open API; add `POST /webhooks/{jazzcash,easypaisa}` routes; end-to-end sandbox test like Keenu.
- **If deferring:** migration that removes `jazzcash_wallet` and `easypaisa_wallet` from `PaymentMethod` enum; backfill any existing rows to `card` or null; reject these values at the Zod layer (`paymentMethodSchema`).

**VERIFY:** No `PaymentMethod` value can be accepted that has no live adapter.

---

### B23 · Clean up orphan adapter directories
**Files:** `backend/src/adapters/{keenu,jazzcash,easypaisa}/` (empty/README-only)

**Steps:**
1. Decide: keep the canonical pattern `backend/src/adapters/payment/{keenu,jazzcash}.ts` OR move to per-folder `backend/src/adapters/keenu/index.ts`.
2. Delete the empty directories OR move the real adapters into them and update imports.

**VERIFY:** No directory under `adapters/` has only a README.

---

### B22 follow-up (covered by F-PAY02). Skip.

---

### Tax & Loyalty configuration UIs (replaces `_StubPage` for these two)
**Files:** `frontend/admin/src/app/configuration/tax/page.tsx`, `frontend/admin/src/app/configuration/loyalty/page.tsx`

**Tax UI steps:**
1. Replace the `ConfigStubPage` with a real form: per-concept tax rate, per-tax-class line, FBR PRAL credentials, FBR submission toggle.
2. POST to `PATCH /api/v1/concepts/:id/tax-config` (new route).
3. Render menu-item tax-class assignment in a table that mirrors `MenuItemTaxClass`.

**Loyalty UI steps:**
1. Real form: earn rate (points per PKR), expiry months, tier thresholds (Silver/Gold/Platinum), birthday bonus points, stamp-card config per concept.
2. POST to `PATCH /api/v1/concepts/:id/loyalty-config`.
3. Surface tier-perks editor binding to `lib/tierPerks.ts` config.

**VERIFY:** Change earn rate to 2pts/PKR; place an order — loyalty earn doubles.

---

### Stamp cards (Cart concept)
**Files:** new migration, `backend/src/modules/loyalty/*`, storefront cart page

**Steps:**
1. Migration adds `stamp_cards` table: `customerId, conceptId, stamps int, redeemedAt timestamptz null`.
2. On completed cart order (`source: 'cart'` AND concept is the cart concept), increment stamp count; at 9, allow a free-item redemption flag.
3. Surface stamp progress on storefront `/account` and on the cart concept's storefront page.

**VERIFY:** 9 cart orders → 10th order allows free-item redemption.

---

### F20 · Google Places autocomplete on checkout address
**File:** `frontend/storefront/src/app/[concept]/checkout/page.tsx:474-479`

**Steps:**
1. Install `use-places-autocomplete` and `@googlemaps/js-api-loader`.
2. Add `NEXT_PUBLIC_GOOGLE_PLACES_API_KEY` to `.env.example` and Render env.
3. Replace the plain `<input>` with a Combobox component bound to `usePlacesAutocomplete({ requestOptions: { componentRestrictions: { country: 'pk' } } })`.
4. On select, `getGeocode` → `getLatLng` → save `{formatted_address, lat, lng}` to the address form state and post to `POST /customer/addresses`.
5. Display selected address as a non-editable chip with edit/change buttons.

**VERIFY:** Type "Defence" in Karachi — autocomplete suggests Pakistan-only options; selecting one populates lat/lng.

---

### F21 · ETA on order tracking and checkout CTA
**Files:** `frontend/storefront/src/app/[concept]/order/[id]/page.tsx`, `frontend/storefront/src/app/[concept]/checkout/page.tsx`, `backend/src/modules/storefront/routes.ts`

**Steps:**
1. Backend: ensure `GET /storefront/orders/:id` returns `estimatedReadyAt` (compute from `concept.prepTimeMinutes + queueDepth * avgPerOrder`).
2. On checkout page: show `"ready ~ {prepTime} min"` next to the Place Order CTA.
3. On tracking page: prominent ETA badge `"Ready in ~{n} min · {estimatedReadyAt | format 'HH:mm'}"`.
4. Update ETA in real-time via WS or polling.

**VERIFY:** Place an order — customer sees a concrete ETA on every screen.

---

### F22 · Loyalty points pill in storefront header
**File:** `frontend/storefront/src/components/StorefrontNav.tsx` (or wherever the header lives)

**Steps:**
1. Add a points pill: when logged in, fetch `GET /storefront/loyalty/me` once on mount; display `"{pts} pts"` chip next to the account link.
2. On menu cards (`[concept]/page.tsx`), add a "+{earnEstimate} pts" badge derived from item price × earn rate.

**VERIFY:** Logged-in customer sees points balance from any storefront page.

---

### F23 · One-click reorder banner for returning customers
**Files:** `frontend/storefront/src/app/[concept]/page.tsx`, `frontend/storefront/src/store/customerAuth.ts`

**Steps:**
1. On menu page mount for a logged-in customer, fetch `GET /storefront/orders?limit=1`.
2. If a recent order exists, show a sticky banner at top: `"Reorder last meal — {summary}, {fulfilment}, {payment} · {total}"` with a single `Reorder` CTA.
3. CTA POST's a duplicate order with the same items + saved address + last-used payment.
4. Persist last-used payment method in `customerAuth` store (or backend `Customer.preferredPaymentMethod`).

**VERIFY:** Returning customer can place an identical order in one click.

---

### F24 · Cart-line key includes modifiers
**File:** `frontend/storefront/src/store/cart.ts:55-66`

**Steps:**
1. Replace the `menuItemId` match with:
   ```ts
   const lineKey = `${menuItemId}::${[...modifiers].sort().join('|')}`;
   const existing = state.lines.find(l => l.lineKey === lineKey);
   ```
2. Store `lineKey` on each line for stable matching.

**VERIFY:** Add two same-id items with different modifiers — cart shows two lines, not qty 2.

---

### F25 · Storefront item modal renders modifier groups
**File:** `frontend/storefront/src/app/[concept]/page.tsx:404-493`

**Steps:**
1. Port the modifier UI from admin POS (`app/pos/page.tsx:233-303`).
2. Reuse the F14 validation logic (required groups enforcement).
3. Submit modifiers along with the line to `addItem`.

**VERIFY:** A menu item with "size: S/M/L" and "extras: pickle/onion" shows both group rows in the modal.

---

### F-RES01 · Reservation → POS table auto-link
**Files:** `backend/src/modules/reservations/routes.ts`, `backend/src/modules/pos/service.ts`

**Steps:**
1. When a reservation transitions to `seated`, the route handler should mark the linked `Table` as `seated` and write `Table.currentReservationId`.
2. In POS, when the cashier creates an order for that table, prefill the customer from the linked reservation.
3. On order completion or reservation `completed` status, clear `Table.currentReservationId`.

**VERIFY:** Seat a reservation → open POS, pick that table → customer is auto-filled.

---

## Phase 4 — Cut scope, harden, prep launch (Weeks 9–12)

### K · KILL list (delete after D01 = single-tenant)

For each module below: remove the route registration in `backend/src/index.ts`, delete the module directory, delete frontend pages, remove from sidebar, delete schema models, drop the related migrations (write a single drop migration if data exists).

1. **`backend/src/modules/tenants/`** — delete; remove `tenantId` from all FK relationships (large refactor — see §B10).
2. **`backend/src/modules/domains/`** — delete.
3. **`backend/src/modules/apiTokens/`** — delete (also closes B07).
4. **`mobile/`** — delete the whole directory.
5. **`tablet/`** — delete.
6. **`frontend/admin/src/app/welcome/`** — delete.
7. **`frontend/admin/src/app/signup/`** — delete (admin signup).
8. **`frontend/admin/src/app/setup/`** — delete the SaaS-style wizard. Keep first-run config in `/configuration` only.
9. **`backend/src/modules/financePlanning/`** — delete; drop the related schema models (`CapexProject`, `CapitalLedgerEntry`, `Projection`).
10. **`backend/src/modules/groupOrders/`** — delete.
11. **`backend/src/modules/components/`** — delete; merge any useful function into `recipes`.
12. **`frontend/admin/src/app/onboarding/`** — delete if `/configuration` covers it.

**VERIFY after each:** `pnpm typecheck` passes; `pnpm build` passes for both backend and frontend; no broken nav links.

---

### C · CUT list (reduce to spec scope)

**C1 · Procurement reduction.** Keep `Supplier`, `StockCount`, `WasteLog` tables and routes. Delete `PurchaseOrder*`, `GoodsReceipt`, `SupplierInvoice`, `ThreeWayMatch`, `APAging`. Delete corresponding admin pages (`procurement/chat`, `procurement/monitor`, `procurement/receiving`, `accounting/ap-aging`).

**C2 · Reservation reduction.** Keep host-managed reservation list. Delete public `/reserve/[slug]`, `/reserve/claim/[token]`, `/reserve/confirm/[token]` storefront pages. Delete deposit logic, waitlist promotion, claim tokens. Keep the no-overlap exclusion constraint (it's good).

**C3 · Locations/StockTransfers (per D01).** If single-tenant single-location: delete `locations`, `stockTransfers`, `/chain` page. If multi-location: keep them and write tests.

**C4 · Staff reduction.** Delete `payroll`, `scheduling`, `kitchen-staff/[id]`, `kitchen-staff/attendance`, `kitchen-staff/schedule`, `kitchen-staff/new`. Keep `auth`, `permissions`, and a minimal user list. Tip pool stays but uses a static role-weight constant (delete the hours-driven distribution).

**C5 · Crosschecks.** Delete only after C1 is done (depends on procurement).

**C6 · `/browse` storefront page.** Decide: kill if not intended as a discovery surface; keep if multi-brand discovery on one domain is a deliberate choice.

**VERIFY after each:** typecheck + build pass; smoke tests still green.

---

### F-IA01 · Collapse audit-log routes (F27)
**File:** `frontend/admin/src/app/configuration/audit-log/page.tsx`

**Steps:**
1. Replace the stub body with a redirect: `redirect('/accounting/audit-log')` (server component).
2. Remove the `/configuration/audit-log` tile from the Configuration Hub.

**VERIFY:** Clicking the tile lands on the real page.

---

### F-IA02 · Collapse storefront design routes (F28)
**Files:** `frontend/admin/src/app/storefront/page.tsx`, `frontend/admin/src/app/marketing/storefront/page.tsx`, `frontend/admin/src/app/content/[slug]/page.tsx`

**Steps:**
1. Pick `/content/[slug]` as the canonical editor (most complete).
2. Redirect the other two to `/content`.
3. Update nav in `AppShell.tsx:107-110`.

**VERIFY:** All three URLs reach the same editor.

---

### F-IA03 · One settings hub (F29)
**Files:** `frontend/admin/src/app/{settings,setup,onboarding,welcome}/`

**Steps:**
1. After §K kills `setup`, `welcome`, and `signup`, redirect `/settings` to `/configuration`.
2. `/onboarding` becomes a tile inside `/configuration` (first-run checklist).
3. Sidebar shows only `/configuration`.

**VERIFY:** Only one "setup" entry point in the sidebar.

---

### F-IA04 · Single P&L route (F30)
**Files:** `frontend/admin/src/app/finance/page.tsx`, `frontend/admin/src/app/accounting/pl-ledger/page.tsx`

**Steps:**
1. Pick `/accounting/pl-ledger` as canonical.
2. Redirect `/finance` → `/accounting`.
3. Rename `/finance/revenue` only if it adds value not in `/accounting`; otherwise delete.

**VERIFY:** Sidebar has one "P&L" link.

---

### F-IA05 · Stub-page hygiene (F31)
**Files:** `frontend/admin/src/app/configuration/*/page.tsx` (33 stubs)

**Steps:**
1. Audit each stub: does the feature ship or not?
2. If shipping: replace stub with real form (see Tax/Loyalty examples above).
3. If not shipping in v1: remove the stub file AND remove the tile from the Configuration Hub. No "Ready" status for unimplemented features.

**VERIFY:** Configuration Hub tile count matches working features count.

---

### F-IA06 · Consolidate overview pages (F32)
**Files:** `/mobile`, `/dashboard`, `/ops`, `/live`, `/chain`

**Steps:**
1. Keep `/dashboard` (single location) and `/chain` (multi-location, if D01 keeps it).
2. Move `/ops` and `/live` widgets into dashboard tabs.
3. Delete `/mobile` (owner-mobile view).

**VERIFY:** Two top-level overview routes max.

---

### B07 · Ship or remove API token validation
**File:** `backend/src/modules/apiTokens/`

**Decision required**: Are there third-party integrations that need API tokens?

**If yes (rare for v1):** implement `requireApiToken(scope)` middleware that resolves `Authorization: Bearer svrd_*` to a principal, scopes by `tenantId`, gates by scope. Wire on `/webhooks/*` outbound subscriptions and any public read endpoints.

**If no (likely):** see §K KILL list — delete the module.

**VERIFY:** Either every `svrd_*` token authenticates somewhere, or the module is gone.

---

### B10 · Multi-tenant simplification (per D01)
**Files:** `backend/src/index.ts:411-437`, every route file with `tenantId` filtering

**If single-tenant per D01-A:**
1. Seed one `Tenant` row in a migration. Hardcode its ID in `lib/constants.ts: SINGLE_TENANT_ID`.
2. Remove `tenantId` from all route filters — replace with the constant or drop entirely.
3. Migration to drop `tenantId` columns from FK tables (BIG migration — write carefully, backfill first).
4. Delete `tenants/` module.

**If multi-tenant:**
1. Extract a `tenantGuard` Fastify preHandler that sets `req.tenantId = req.staffUser.tenantId`.
2. Replace per-route `concept: { tenantId: req.staffUser.tenantId }` with a centralized helper.
3. Add `tenantId` to entities currently missing it (Customer, LoyaltyAccount, Reservation — see B33).
4. Add cross-tenant tests for every route.

**VERIFY:** Choose path; ship one.

---

### Accessibility pass (F34, F37, F38, F39)

**F34 · Admin skip link** — Add to `frontend/admin/src/app/layout.tsx`:
```tsx
<a href="#main" className="sr-only focus:not-sr-only ...">Skip to content</a>
...
<main id="main">{children}</main>
```

**F37 · Role/aria-modal on modals** — Audit `checkout/page.tsx`, `PaymentModal.tsx`, POS `ModifierModal`. For each:
```tsx
<div role="dialog" aria-modal="true" aria-labelledby="...">
```
Wrap with a focus-trap (e.g. `radix-ui Dialog` or `focus-trap-react`).

**F38 · Muted text contrast** — In `frontend/admin/src/app/globals.css`, change `--muted` from `#6B7280` to `#8B95A1`.

**F39 · Replace emoji icons** — Install `lucide-react`, replace functional emoji in `AppShell.tsx`, KDS controls, payment-method labels. Wrap decorative emoji in `<span aria-hidden="true">`.

**VERIFY:** Run axe DevTools on `/dashboard`, `/pos`, `/kds/all`, `/configuration`, storefront `/[concept]`, `/checkout` — no AA violations.

---

### Operational hardening

**B32 · Health endpoint timeout** — `backend/src/index.ts:328-386`:
```ts
const dbOk = await Promise.race([
  prisma.$queryRaw`SELECT 1`.then(() => true).catch(() => false),
  new Promise<boolean>(r => setTimeout(() => r(false), 1000)),
]);
return reply.send({ status: dbOk ? 'ok' : 'degraded', db: dbOk });
```

**B40 · Worker watchdog** — Add `backend/src/workers/watchdog.ts` that pings each worker's heartbeat key in Redis every 30s; on miss, restarts the worker. Or document the supervisor (PM2, systemd) requirement.

**B30 · Replace fire-and-forget with outbox** — Already covered by B06's outbox table. Migrate `notifyNewOrder`, `customerRollups`, etc. to use it.

**B31 · OperationsConfig tunable cancel windows** — In `backend/src/workers/orderAutoCancel.ts`, read `received` and `confirmed` timeouts from `OperationsConfig`. Add UI fields in `/configuration/operations`.

**B33 · tenantId on Customer/Loyalty/Reservation** — If multi-tenant per B10: migration that adds `tenantId` columns, backfills from order history, indexes.

**B12 · PIN login refactor** — `pos/service.ts:540-545`:
1. Add a `staffId` (or PIN-prefix) requirement to login UX: cashier first picks identity from a list, then enters PIN.
2. Replace fan-out with `bcrypt.compare(pin, user.pinHash)` against the single user.
3. Or migrate to argon2id with a Redis-cached map of `pin_prefix_hash → candidate user ids`.

**B17 · Redis TLS strict** — `backend/src/lib/redis.ts:5-7`:
```ts
tls: process.env.NODE_ENV === 'production'
  ? { rejectUnauthorized: true }
  : { rejectUnauthorized: false }
```

**B18 · concept-access cache** — `backend/src/lib/conceptAccess.ts:7-26`:
- Option A: remove the cache entirely (simpler).
- Option B: publish invalidations on a Redis channel; each instance subscribes and clears.

**B20 · Cryptographic OTP** — `backend/src/modules/orders/service.ts:163`:
```ts
import crypto from 'crypto';
const otp = crypto.randomInt(1000, 10000).toString();
```
And enforce `deliveryOtpAttempts < 5` before checking the entered OTP; lock further attempts for 15 min.

**B24 · Restrict manual order creation** — `backend/src/modules/orders/routes.ts:11-12`:
```ts
{ preHandler: requireRole(['manager', 'admin']) }
```
Or remove `POST /orders` entirely and force through `/pos/orders`.

**B25 · Postmark sender disambiguation** — `backend/src/modules/webhooks/routes.ts:298-301, 316-319, 328`:
- Maintain a `email → senderType` index that explicitly distinguishes Supplier from Customer.
- On collision (same email maps to both), route to a "manual review" inbox.

**B26 · Domain events layer** — New `backend/src/lib/events.ts` with a typed event emitter:
```ts
export type OrderCompletedEvent = { orderId: string; conceptId: string; total: number; ... };
export const events = new TypedEventEmitter<{ 'order.completed': OrderCompletedEvent; ... }>();
```
Refactor `orders/service.ts:postOrderCompletion` to emit `events.emit('order.completed', ...)`. Each finance/loyalty/CRM module subscribes in its own bootstrap.

**B27 · `/finance` prefix collision** — `backend/src/index.ts:249, 288`:
- Rename `financePlanning` to register at `/finance-planning/*` (or kill it via §K).

**B28 · OrderItem indexes** — Migration `20260525000000_order_item_indexes`:
```sql
CREATE INDEX order_items_menu_item_id_idx ON order_items(menu_item_id);
CREATE INDEX order_items_pending_fire_idx ON order_items(scheduled_fire_at) WHERE status = 'pending';
```

**B29 · FinancialEntry.orderId unique** — Already part of B03.

**B34 · Bulk update course pacing** — `backend/src/modules/orders/service.ts:289-296`:
Replace `Promise.all(items.map(i => tx.orderItem.update(...)))` with `tx.orderItem.updateMany({ where: { id: { in: ids } }, data: {...} })` OR a raw `UPDATE … CASE WHEN id=$1 THEN $val1 …` if per-row values differ.

**B35 · MagicLink cleanup** — New cron worker in `backend/src/workers/magicLinkCleanup.ts`:
```ts
cron.schedule('0 3 * * *', async () => {
  await prisma.magicLink.deleteMany({ where: { expiresAt: { lt: subDays(new Date(), 30) } } });
});
```

**B36 · Move startup migrations into Prisma migrations** — `backend/src/index.ts:411-459`:
- Convert the orphan-concept/user/location backfill into a one-off migration `20260526000000_orphan_backfill`.
- Replace the boot code with `assert` checks that fail-fast if invariants are violated.

**B37 · Swagger explicit gate** — `backend/src/index.ts:194-210`:
```ts
if (process.env.ENABLE_SWAGGER === 'true') { ... register swagger ... }
```

**B38 · Commission outside transaction** — `backend/src/modules/pos/service.ts:271`:
Move `const commission = Math.round(total * rate)` to before `prisma.$transaction(...)`. Pass the precomputed value in.

**B39 · KDS heartbeat coalescing** — `backend/src/lib/ws.ts:86-91`:
Use a Redis `SET kds:heartbeat:{deviceId} EX 60` instead of writing DB on every connection. Background worker every 60s flushes Redis to DB.

**B41 · Email case-insensitive lookups** — In `backend/src/modules/webhooks/routes.ts:289, 310, 328`:
```ts
const customer = await prisma.customer.findFirst({
  where: { email: { equals: email.toLowerCase(), mode: 'insensitive' } }
});
```

---

### B43–B50 · Polish

**B43 · Redact `req.query`/`req.params`** — `backend/src/index.ts:120-138`:
```ts
redact: { paths: ['req.headers.authorization', 'req.headers.cookie', 'req.query.secret', 'req.query.token', 'req.body.password', 'req.body.pin'], remove: true }
```

**B44 · Use `staffId` in `updateItemStatus`** — `backend/src/modules/orders/service.ts:528`:
Write an audit row on each item status change including `staffId`.

**B45 · Standardise audit calls** — Wrap mutations in `withAudit(fn, { entity, action, before, after, staffId })`. Apply consistently across orders, pos, discounts, payroll, financial.

**B46 · `Concept.taxRate` to Decimal** — Migration:
```sql
ALTER TABLE concepts ALTER COLUMN tax_rate TYPE numeric(6,4) USING tax_rate::numeric(6,4);
```
Update Prisma `Float` → `Decimal @db.Decimal(6,4)`. Refactor consumers: `concept.taxRate.toNumber() / 100` for display.

**B47 · Consolidate JWT secret validation** — `backend/src/index.ts:519-525, 538-544`:
Extract `validateSecretStrength(name, value, minLen)` helper; call once per secret.

**B48 · Request ID + error correlation** — Add `@fastify/request-id` (or set `req.id` manually with `nanoid`). Include `requestId` in every error response body and log entry.

**B49 · Customer JWT lifetime** — `backend/src/modules/auth/service.ts:277`:
Change `'30d'` to `'7d'`. Add a customer refresh-token flow (mirror staff).

**B50 · Consistent cross-tenant error codes** — Pick `403 CROSS_TENANT`. Update `backend/src/modules/orders/routes.ts:117, 198` and grep for other variants.

**B21 · Soft-delete policy** — Write `docs/SOFT_DELETE.md` listing which entities have `deletedAt` and the policy. Add `deletedAt` to entities that should soft-delete but don't (suggested: `Customer`, `MenuItem`, `Concept`, `Recipe`).

**B42 / B27 dup** — covered.

---

### Frontend polish

**F01 · Storefront design tokens** — Move `SERVD_TOKENS` from `src/lib/tokens.ts` into `frontend/storefront/tailwind.config.ts theme.extend.colors`. Drop the unused `tokens.ts` exports. Remove `--servd-*` CSS vars from `globals.css` (or keep but generated from the same source).

**F02 · Shared design package** —
1. New workspace `packages/design-tokens/` with one TS file exporting colors/spacing/type.
2. New workspace `packages/ui/` exporting `<ServdLogo>`, `<Numpad>`, `<Panel>`, `<Modal>`, `<Button>` variants.
3. Both apps import from these packages. Update `pnpm-workspace.yaml`.

**F03 · Admin money formatter** — Create `frontend/admin/src/lib/ui.ts` exporting `fmtMoney(cents, ccy='PKR')`. Codemod the 8+ inline copies.

**F04 · Extract storefront components** — Pull `<Panel>`, `<PriceLine>`, `<PremiumInput>` from the bottom of `[concept]/checkout/page.tsx` into `frontend/storefront/src/components/`. Replace inline styles with class-based styling.

**F06 · Socket auth callback form** — `frontend/admin/src/lib/socket.ts:6-27`:
```ts
socket = io(URL, {
  auth: (cb) => cb({ token: useAuthStore.getState().token })
});
```

**F07 · KDS active-state geometry** — `frontend/admin/src/app/globals.css:158-163`:
Replace `active:scale-95` with `active:bg-kds-accent-dark` (color flash). Audit all `.kds-btn*` variants.

**F08 · Strip hover from KDS** — Grep `hover:` in `frontend/admin/src/app/kds/**` and `frontend/admin/src/components/kds/**`. Remove or wrap in `@media (hover:hover)` via Tailwind's `[@media(hover:hover)]:` variant.

**F10 · Source palette match** — `frontend/admin/src/components/kds/TicketCard.tsx:10-18` and `kds/all/page.tsx:44`:
```ts
const SOURCE_COLORS = { servd:'...', foodpanda:'...', careem:'...', pos:'...', cart:'...', manual:'...' };
const SOURCE_COLUMNS = ['pos','servd','foodpanda','careem','cart','manual'];
```
Remove `ubereats`/`doordash`/`deliveroo`.

**F11 · KDS ticket layout to grid** — `frontend/admin/src/app/kds/[station]/page.tsx:47`:
Replace `lg:columns-3 xl:columns-4` with `grid grid-cols-1 lg:grid-cols-3 xl:grid-cols-4 auto-rows-min gap-3`.

**F12 · Urdu font** — `frontend/admin/src/app/layout.tsx`:
```ts
import { Noto_Nastaliq_Urdu } from 'next/font/google';
const urdu = Noto_Nastaliq_Urdu({ subsets: ['arabic'], variable: '--font-urdu' });
```
Update `tailwind.config.ts: fontFamily.urdu = ['var(--font-urdu)', 'sans-serif']`. In ticket card, swap `style={{ fontFamily: 'sans-serif' }}` for `className="font-urdu"`.

**F15 · Inline split-bill from PaymentModal** — `frontend/admin/src/components/pos/PaymentModal.tsx`:
Add a `"Split Payment"` button that opens an inline split-builder before order finalization (don't navigate away).

**F16 · Single useShallow selector in POS** — `frontend/admin/src/app/pos/page.tsx:51-54`:
```ts
const { shiftId, conceptId, cart, ... } = usePosStore(useShallow(s => ({ ... })));
```
Remove imperative `usePosStore.getState().setX(...)` patterns; use the setter from the hook.

**F17 · Persist POS cart** — `frontend/admin/src/store/pos.ts:128-131`:
```ts
partialize: (s) => ({ shiftId: s.shiftId, conceptId: s.conceptId, cart: s.cart, tableId: s.tableId, customerId: s.customerId })
```
Add a 4h TTL guard: if `cartUpdatedAt < now - 4h`, clear on load.

**F18 · Disable Charge when no shift** — `frontend/admin/src/components/pos/PosCart.tsx:109-114`:
```tsx
<button disabled={!shiftId} ...>{!shiftId ? 'Open shift first' : 'Charge'}</button>
```
With a link `→ /pos/shift` adjacent.

**F26 · Brand-domain cart handoff** — `frontend/storefront/src/app/[concept]/page.tsx:308-313`:
Replace base64-in-URL with `sessionStorage.setItem('servd_cart_handoff', JSON.stringify(cart))` + a short-lived `?h={nanoid}` token that the receiving page reads sessionStorage by. Or `postMessage` between the two windows.

**F40 · Shared `<Numpad>` component** — Extract to `packages/ui/src/Numpad.tsx`. Both `kds/login/page.tsx:99-131` and `login/page.tsx:66` consume it.

**F41 · POS breakpoint to 1024px** — `frontend/admin/src/app/globals.css:307-342`:
Change `@media (max-width: 768px)` to `@media (max-width: 1024px)`. Test on iPad Pro portrait.

**F42 · KDS lock viewport** — `frontend/admin/src/app/kds/layout.tsx` (new file):
```ts
export const viewport = { width: 'device-width', initialScale: 1, maximumScale: 1, userScalable: false };
```

**F44 · Refresh-fail redirect** — Audit `frontend/admin/src/lib/api.ts` (read the full file beyond line 120). Confirm the 401-after-refresh path calls `useAuthStore.getState().clearAuth()` and `router.push('/login')`.

**F45 · Storefront customerAuth refresh** — `frontend/storefront/src/store/customerAuth.ts:1-23`:
Mirror admin's `_refreshing` promise pattern. Or switch storefront customer auth to httpOnly cookies + server-side refresh.

**F46 · KDS prefs via persist middleware** — `frontend/admin/src/store/kds.ts:28-38`:
```ts
export const useKdsStore = create<KdsState>()(persist((set) => ({ ... }), { name: 'servd-kds-prefs' }));
```
Add `clearOnPinSwitch()` that calls `useKdsStore.persist.clearStorage()`.

**F47 · Loading/error states on KDS queries** — `frontend/admin/src/app/kds/[station]/page.tsx`, `kds/all/page.tsx`:
```tsx
if (isLoading) return <KdsSkeleton />;
if (isError) return <ApiOfflineBanner onRetry={refetch} />;
```

**F49 · Customer-facing error copy** — `frontend/storefront/src/app/signup/page.tsx:76`, `login/page.tsx:52`:
Replace `"Could not reach the server..."` with `"We can't connect right now. Please check your connection and try again."`.

**F50 · Unify PIN error copy** — Pick one phrasing and apply to `kds/login/page.tsx:36, 42` and `admin/login/page.tsx:43, 50`. Recommend: `"Try again — that PIN didn't match."`.

**F51 · Better empty states** — `frontend/admin/src/components/pos/PosCart.tsx:30-32` (empty cart), `kds/[station]/page.tsx:57` (empty kitchen). Use the storefront-checkout empty-state shape (heading + illustration + sub-line + action).

**F52 · Source-list consistency** — Find every reference to `ubereats|doordash|deliveroo` and replace with `foodpanda|careem`. Includes `welcome/page.tsx:8`, `kds/all/page.tsx:44`, marketing copy.

**F53 · Replace emoji panel icons** — `frontend/storefront/src/app/[concept]/checkout/page.tsx`:
Replace 🧾 🎟 ⭐ 📝 💳 👤 with Lucide icons (`Receipt`, `Ticket`, `Star`, `MessageSquare`, `CreditCard`, `User`).

**F48 · WS event hook primitive** — Extract `useSocketEvents(eventMap)` to `frontend/admin/src/hooks/useSocketEvents.ts`. Migrate `useKdsSocket.ts` and `useReservationSocket.ts` to use it. Handle stale-closure defense once.

**F54 · `dangerouslySetInnerHTML` audit** — `frontend/storefront/src/components/brand/layouts/StaxLayout.tsx:579`, `GenericBrandLayout.tsx:159`:
Replace with structured JSX. If operator-editable Markdown is needed, install `react-markdown` with an allowlist (`{ allowedElements: ['p','strong','em','a','ul','ol','li','h2','h3'] }`).

---

## Phase 5 — Test coverage

Add at minimum these Playwright smoke tests:

1. **`test/e2e/kds-bump.spec.ts`** — PIN login → station view → bump → completed status.
2. **`test/e2e/pos-cash-sale.spec.ts`** — Open shift → add items → modifier required → cash tender → receipt → close shift.
3. **`test/e2e/storefront-checkout-guest.spec.ts`** — Browse → cart → guest checkout → place order → tracking.
4. **`test/e2e/storefront-checkout-returning.spec.ts`** — Login → reorder banner → one-click → loyalty earn applied.
5. **`test/e2e/foodpanda-webhook.spec.ts`** — POST signed payload → order appears on KDS → bump → outbound status push observed.

Run in CI on every PR. Block merge on failure.

---

## How to execute this with Claude Code

Recommended invocation pattern:

```
@claude execute FIXES.md phase 1
```

Or per-fix:

```
@claude apply B01 from FIXES.md
```

After each fix:
1. Run `pnpm typecheck && pnpm build` (both backend and frontend).
2. Run the linked smoke test.
3. Commit with message `fix(servd): {ID} {short description}`.

When a fix requires the human's strategic decision (D01, F19, B07 ship-or-kill), pause and ask before executing.

---

*End of fix plan. ~110 actionable items across 5 phases.*
