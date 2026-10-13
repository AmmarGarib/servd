## build-W1.json
1) backend/src/lib/exceptions.ts (the ExceptionKind union; owned by another agent). Add:
```ts
  | 'fiscal_failed'          // POS connector: a fiscal document gave up retrying
  | 'fiscal_rejected'        // the fiscal POS rejected a document
  | 'fiscal_auth'            // the fiscal POS refused servd's API key
  | 'fiscal_manual_refund'   // a refund must be filed by hand (sale filed directly pre-cutover, or POS cannot file refunds)
  | 'terminal_void_failed'   // card charged, servd refused it, automatic reversal failed
  | 'terminal_unreconciled'  // card outcome disagrees with what servd recorded, or unknown > 24 h
```
W1 writes these kinds as plain strings through `connectors/alerts.ts` `flagConnectorException` (`ExceptionFlag.kind` is a String column; no cast). The union only matters if other code wants to call `flagException` with them.

2) backend/src/modules/pos/service.ts (W4). W1 passes the extended inputs declared locally in terminal/service.ts (`TerminalProcessPaymentInput` / `TerminalSettleInput` / `TerminalRefundInput`). Make them real:

- **ProcessPaymentInput**:
  - Add `terminalChargeId?: string` at the top level.
  - On each tender add: `terminalChargeId?: string; manualReason?: 'unknown_outcome' | 'terminal_offline'; authCode?: string | null; cardBrand?: string | null; cardLast4?: string | null`.
  - In the tender loop, extend `meta` with `...(p.terminalChargeId && { terminalChargeId: p.terminalChargeId }), ...(p.authCode && { authCode: p.authCode }), ...(p.cardBrand && { cardBrand: p.cardBrand }), ...(p.cardLast4 && { cardLast4: p.cardLast4 }), ...(p.manualReason && { manualReason: p.manualReason })`.
  - Right after `lockOrderTx(tx, input.orderId)`: `await assertNoActiveTerminalChargeTx(tx, input.orderId, input.terminalChargeId)`.
- **SettleInput**:
  - Add `gateway?: PaymentGateway; terminalChargeId?: string`.
  - In the claim update: `...(input.gateway && { gateway: input.gateway }), ...(input.terminalChargeId && { gatewayMeta: { terminalChargeId: input.terminalChargeId } })`.
  - Inside the tx when `via === 'till'`: `await assertNoActiveTerminalChargeTx(tx, payment.order.id, input.terminalChargeId)`.
- **RefundInput**:
  - Add `gateway?: PaymentGateway; gatewayRef?: string; terminalChargeId?: string`.
  - In writeRefundTx: `gateway: r.gateway ?? 'none', gatewayRef: r.gatewayRef ?? null, gatewayMeta: { refund: {...}, ...(r.terminalChargeId && { terminalChargeId: r.terminalChargeId }) }`.
  - Inside refundOrder's tx after writeRefundTx: `await enqueueFiscalRefundTx(tx, { orderId: input.orderId, tenantId, refundPaymentId: refundPayment.id, amountCents: taxableRefundCents(order, alreadyRefunded, input.amountCents) /* or input.amountCents — see note */, reason: input.reason, method })`. After commit: `void kickFiscal(doc.id)` when `status === 'pending'`. Note: buildRefundPayload already splits out the tip share pro rata, so passing `input.amountCents` is correct and keeps lines + tax + tip + service = refund.
- **Guards**: compOrder, applyGiftCardTender and checkSplit call `assertNoActiveTerminalChargeTx(tx, orderId)` under the order lock. The shift close handler in pos/routes.ts calls `await assertShiftHasNoActiveCharges(shift.id)` before closeShift.

3) backend/src/modules/orders/service.ts completeOrder (W4):
- Inside the claim tx, after `tx.auditLog.create(...)`:
```ts
const fiscalDoc = row.tenantId ? await enqueueFiscalSaleTx(tx, { orderId, tenantId: row.tenantId }) : null
return { tenantId: row.tenantId, fiscalDoc }
```
  enqueueFiscalSaleTx checks `fiscalReportingRequired` itself (§17.7), so a separate check is not needed.
- After commit:
```ts
const fiscal = claim.fiscalDoc
  ? (opts.syncFiscal ? await submitFiscalAtTill(claim.fiscalDoc.id) : (claim.fiscalDoc.status === 'pending' && void kickFiscal(claim.fiscalDoc.id), await fiscalViewForOrder(orderId)))
  : null
```
- updateOrderStatus refunded/cancelled after completion:
```ts
await prisma.$transaction((tx) => enqueueFiscalRefundTx(tx, { orderId, tenantId, refundPaymentId: null, amountCents: saleTotal - priorRefundDocsTotal }))
```
  then kick if pending.

4) backend/src/index.ts (W4):
```ts
import { registerConnectorPlugins } from './modules/connectors/index.js'
import { drainLegacyTaxQueues } from './connectors/legacyDrain.js'
import { connectorHealthChecks } from './connectors/health.js'
import { startFiscalConnectorWorker } from './workers/fiscalConnector.js'
import { startTerminalConnectorWorker } from './workers/terminalConnector.js'
// inside the /api/v1 register scope:
await registerConnectorPlugins(api)
// worker start (ENABLE_WORKERS):
await drainLegacyTaxQueues(); startFiscalConnectorWorker(); startTerminalConnectorWorker()
// /health handler:
const conn = await connectorHealthChecks(); Object.assign(checks, conn.checks); Object.assign(details, conn.details)
```
The webhook route's per-token rate limit (120/min) relies on the global @fastify/rate-limit registration already in index.ts.

5) backend/src/lib/moduleAccess.ts (W2): `GATED_PREFIXES` += `{ prefix: '/connectors', anyOf: ['api_pos'] }`; the `it` defaults include `'api_pos'`. The /pos/terminal/* and /pos/orders/:id/fiscal* routes are not gated beyond their roles.

6) backend/src/modules/pos/receipt.ts (W4): use `fiscalViewForOrder(orderId, 'sale')` and `renderQrSvg(qrPayload ?? verifyUrl)`, which is synchronous. For card_terminal payments, read gatewayMeta `{ cardBrand, cardLast4, authCode }`.

7) Box env: SERVD_SECRET_KEY must be set (base64, 32 bytes) before any connector secret can be saved; otherwise PUT returns 503 SECRET_KEY_MISSING. The webhook/callback URL base comes from env `API_URL` (default https://api.servd.pk).

## fix-W1.json
1. **W4 (pos/service.ts), recommended to remove a duplicate.** The terminal refund pre-check copies `refundableOf`/`assertRefundable` and the refund part of `ensureCapOrManagerOverride`, because those are not exported and I may not edit pos/service.ts. To keep one source of truth (CLAUDE.md duplicate rule), please export a side-effect-free check and I (or the orchestrator) will switch `assertCardRefundPolicy`/`assertCardRefundable` in connectors/terminal/service.ts to call it:
```ts
export async function assertRefundAllowed(input: { orderId: string; amountCents: number; method: RefundMethod; reason: string; photoUrl?: string; actorRole: string; tenantId: string; extraInFlightCents?: number }): Promise<void> {
  const order = await prisma.order.findUniqueOrThrow({ where: { id: input.orderId }, include: { payments: true } })
  assertRefundableStatus(order.status)
  const state = refundableOf(order.payments, order.source)
  assertRefundable({ ...state, refundable: state.refundable - (input.extraInFlightCents ?? 0), byMethod: new Map([...state.byMethod].map(([m, v]) => [m, m === input.method ? v - (input.extraInFlightCents ?? 0) : v])) }, input.amountCents, input.method)
  const policy = await getRefundPolicy(input.tenantId)
  if (policy.requireReason && input.reason.trim().length === 0) throw new AppError('REASON_REQUIRED', 'Reason required by policy', 400)
  if (policy.requirePhotoEvidence && !input.photoUrl) throw new AppError('PHOTO_REQUIRED', 'Photo evidence required by policy', 400)
  const approver = isOverrideApprover(input.actorRole)
  const cap = approver ? policy.managerRefundLimitCents : policy.cashierRefundLimitCents
  if (input.amountCents > cap) throw approver ? new AppError('OVER_CAP', `Amount ${input.amountCents} exceeds the ${cap} cap for refund`, 403) : new AppError('MANAGER_OVERRIDE_REQUIRED', `Manager PIN required for refund above ${cap}`, 403)
}
```
   Optionally, add `preApprovedById?: string` to RefundInput, so a PIN verified when a card refund starts can be honoured at booking. This would let a cashier with a manager's PIN refund to card; today that refund must be started by an approver's own session.

2. **W3 (admin connector settings page).** While the fiscal connector is enabled, disable the driver and base URL fields (or surface 409 SWITCH_OFF_FIRST with its message: the CEO switches off, IT edits and tests, the CEO goes live).

3. **W3 (refund-to-card dialog).** Send an optional `photoUrl` when the company's RefundPolicy requires photo evidence. Show the 403 MANAGER_OVERRIDE_REQUIRED / OVER_CAP messages (no PIN prompt on this flow).

No schema.prisma changes are needed.

## build-W5.json
1. **backend/src/index.ts (W4).** Add `import { registerPreBillPlugins } from './modules/prebills/index.js'` and, inside the /api/v1 block after `await api.register(posRoutes, { prefix: '/pos' })`, add `await registerPreBillPlugins(api)`.

2. **backend/src/lib/workspaces.ts (W2).** Add module id `'voided_prebills'` to the Finance workspace's controls/reconciliation section.

3. **backend/src/lib/moduleAccess.ts (W2).**
   - Default roles: `voided_prebills: ['admin','owner','management','finance']`.
   - Add `{ prefix: '/pre-bills', anyOf: ['voided_prebills'] }` to GATED_PREFIXES.
   - Do NOT gate `/pos/pre-bills` or `/pos/orders/:id/pre-bill`; those are till routes, role-gated to CASHIERS.

4. **frontend/admin/src/lib/moduleCatalog.ts (W3).** Add the entry exactly as spec §17.5 gives it: `voided_prebills: [{ label: 'Voided pre bills', href: '/finance/voided-pre-bills', hint: 'Every pre-bill printed — flagged when it never became a full & final bill or the final bill came out lower' }]`.

5. **pos/service.ts completeOrder / orders/service.ts (W4).**
   - Inside the order.complete claim transaction: `await markPreBillsConvertedTx(tx, orderId, order.totalCents, completedAt)`.
   - In every cancel / void-whole-order / reject path, inside its tx: `await markPreBillsCancelledTx(tx, orderId, approverId, reason, new Date())`.
   - Import both from '../prebills/index.js'. Watch for a circular import: prebills/service.ts imports `quoteOrderForTender` and `lockOrderTx` from pos/service.ts. ESM handles this cycle because no top-level value is used at load, but if it bites, import the hooks from '../prebills/service.js' directly.

6. **voidOrderItem audit row (W4, manager-only voids).** Keep writing `action:'order_item_void', entity:'OrderItem', entityId:<orderItemId>, metadata.approverId`. The Finance list reads the approver from there and falls back to the audit userId.

7. **frontend/admin/src/app/finance/page.tsx (owner unknown).** Optionally add a link card to `/finance/voided-pre-bills`. The sidebar will reach it through moduleCatalog once W2/W3 land.

## fix-W5.json
None are required. Note for W4: the hooks now lock the order row themselves, so the cancel paths that update the order with a plain `order.updateMany` (orders/service.ts ~L998) do not need to lock it first. W4 still has to actually call `markPreBillsCancelledTx` / `markPreBillsConvertedTx` in those paths and in completeOrder; nothing calls them yet.

## wf_44a64251-build-W2.json
1) **backend/src/index.ts (W4/orchestrator): /health warning for the WhatsApp key at rest (spec §13).**
The handler builds `checks: Record<string,'ok'|'error'|'warn'>` and `details` inline, around lines 519-680.
- Change the import at line 122 to: `import { whatsappConfigured as isWhatsappConfigured, whatsappSecretHealth } from './lib/whatsapp.js'`
- After the staffCodeLogin try/catch block, add:
```ts
    // WhatsApp key at rest (lib/secretBox): warn when it is plaintext because
    // SERVD_SECRET_KEY is missing, or encrypted but unreadable here.
    try {
      const wa = await whatsappSecretHealth()
      if (wa.check !== 'off') { checks.whatsappKeyAtRest = wa.check; details.whatsappKeyAtRest = wa.detail }
    } catch {
      checks.whatsappKeyAtRest = 'warn'
      details.whatsappKeyAtRest = 'Could not check how the WhatsApp gateway key is stored.'
    }
```
W1's `connectorSecretKey` check already warns when any `enc:v1:` Setting exists without the key. This adds the plaintext case.

2) **backend/src/workers/deliveryWatch.ts (owner unknown): copy only.** The three `fix:` strings at lines 55, 63 and 71 say "admin → Configuration → WhatsApp". They should say "admin → Dev → API → WhatsApp connector", because the page moves to `/connectors/whatsapp` (W3).

3) **frontend/admin/src/lib/appRoles.ts (W3).**
- Add `| 'api_whatsapp' | 'api_pos' | 'voided_prebills'` to the `ModuleId` union.
- Add MODULES entries with labels: 'WhatsApp connector', 'POS connector' and 'Voided pre bills'.
- Without these, the CEO cannot toggle the new modules in /configuration/role-modules, and the sidebar type does not know them.

4) **frontend/admin WhatsApp page (W3).** GET `/auth/integrations/whatsapp` now also returns:
- `scope: 'platform'`;
- `keyAtRest: 'none'|'encrypted'|'plaintext'|'unreadable'`, which the page can show.

The hint is now first 4 + last 4 (it was first 6 + last 4). PUT can return 503 `SECRET_KEY_MISSING`; show its message.

5) **.env.docker.template (repo root, not in my list).** Delete lines 65-71 (the `# Tax authorities` block: `FBR_USERNAME`, `FBR_PASSWORD`, `FBR_ENV`, `SRB_USERNAME`, `SRB_PASSWORD`, `SRB_ENV`) and add:
```
# Secrets at rest — base64 32 bytes (openssl rand -base64 32); box only, never commit
SERVD_SECRET_KEY=
```

6) **Deploy note (orchestrator / owner).**
- If prod has `RoleModuleAccess` override rows for `it`, `management`, `owner` or `finance`, those rows replace the defaults and lack the new ids. IT would then get 403 on `/connectors`, and finance and the others on `/pre-bills`, until the CEO ticks the new modules in Module Access. Check with `SELECT role, modules FROM role_module_access`.
- `SERVD_SECRET_KEY` must be on the box before W2 deploys. Otherwise nobody can save a new WhatsApp key (503); the existing plaintext key keeps working.

## wf_44a64251-fix-W2.json
1) backend/src/index.ts (W2-R3). Run the grants at boot, next to the chart-of-accounts bootstrap, so GET /permissions/role-modules shows the new modules from the first request. The lazy run in roleOverrides() covers it if this is missing:
```ts
  try {
    const { applyModuleGrants } = await import('./lib/moduleAccess.js')
    const g = await applyModuleGrants()
    if (g.applied.length) fastify.log.info(`[access] module grants ${g.applied.join(', ')} applied to saved rows: ${g.roles.join(', ') || 'none'}`)
  } catch (err) {
    fastify.log.warn(`[access] module grants skipped: ${(err as Error).message}`)
  }
```
2) infra/staging.tfvars.example (W2-R4). Replace lines 35-38 (the `# FBR PRAL …` comment, `fbr_username = ""` and `fbr_password  = ""`) with:
```hcl
# ── Secrets at rest ──────────────────────────────────────────────────────────
# Encrypts stored integration secrets (POS connector keys, WhatsApp key).
# Generate with `openssl rand -base64 32`; keep it outside the repo. Leave it
# empty and connector / WhatsApp keys cannot be saved (503 SECRET_KEY_MISSING).
# There are no FBR / SRB credentials: the external fiscal POS files, set up per
# company in admin → Dev → API → POS connector.
servd_secret_key = ""
```
(infra/main.tf already declares `servd_secret_key`.)
3) .handoff/pos-connector-spec.md §12 Rollback (W2-R2). Append: "Rolling the API back to any image older than W2 also requires re-entering the WhatsApp key in the old /configuration/whatsapp page: a server with SERVD_SECRET_KEY re-encrypts the stored key on first read (§13 step 4), and the old image sends that ciphertext as x-api-key, so signup, staff code sign-in, reset and 2FA codes stop until the key is re-entered."

## wf_44a64251-build-W3a.json
1) frontend/admin/src/lib/api.ts (not mine). The API's error `details` (e.g. go-live 409 NOT_READY `{missing:[…]}`) are dropped by ApiError today. connectorsApi.missingFrom() already reads `err.details` defensively, so this is the only change needed:
```ts
export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message)
  }
}
// in request():
  if (!res.ok) {
    const data = (await res.json()) as { error: { code: string; message: string; details?: unknown } }
    throw new ApiError(res.status, data.error.code, data.error.message, data.error.details)
  }
```
Until then, the go-live dialog shows the server message plus the client-side readiness checklist.

2) W2, backend/src/lib/moduleAccess.ts and lib/workspaces.ts (not done yet). Until this lands the new pages work by URL but are not in the sidebar, because the sidebar only renders module ids the API returns.
- `MODULE_IDS += 'api_whatsapp', 'api_pos', 'voided_prebills'`.
- `it` defaults = `['api_whatsapp','api_pos','integrations','audit_log','notifications','help']`.
- `voided_prebills` defaults: admin, owner, management, finance.
- `GATED_PREFIXES += { prefix: '/connectors', anyOf: ['api_pos'] }, { prefix: '/pre-bills', anyOf: ['voided_prebills'] }`.
- Dev workspace: first section `{ key:'api', title:'API', modules:['api_whatsapp','api_pos'] }`.
- Finance controls section gets `'voided_prebills'`.

3) W2, backend/src/modules/auth/routes.ts. The WhatsApp GET/PUT/test routes and both delivery-status routes change from ADMIN_ONLY / MANAGERS to CONNECTOR_ADMINS (`requireAuth(...CONNECTOR_ADMINS)`), so IT can use /connectors/whatsapp. GET /integrations/delivery-status could be `[...MANAGERS, 'it']` if managers should keep seeing the watchdog. GET /integrations/whatsapp also adds `scope: 'platform'`; the type already has it as optional.

4) backend/src/workers/deliveryWatch.ts, HUMAN.unconfigured.fix. The old path still redirects, but the wording is stale:
```ts
fix: 'Open admin → Dev → API → WhatsApp connector and paste the endpoint and API key from the gateway’s API Info tab.',
```

5) Other W3 items that were not part of this W3a brief, so I left them to whoever owns them: PaymentModal.tsx / tillApi.ts (terminal step, fiscal line, pre-bill print, 409 PRE_BILL_REQUIRED, the manager-PIN void dialog), components/connectors/FiscalPanel.tsx plus app/orders/[id]/page.tsx, app/refunds/refundEngine.ts (fiscalRefund, refund on the card machine with optional photoUrl, MANAGER_OVERRIDE_REQUIRED / OVER_CAP messages), the configuration/refund-policy copy, and tablet/src/lib/printer.ts.

6) frontend/admin/src/app/settings/integrations/README.md (optional). It is a stale stub; adding a line noting that WhatsApp and the POS connector live in /connectors would help.

## wf_44a64251-fix-W3a.json
For the W1 owner, file backend/src/modules/connectors/routes.ts:

(1) R5: bind the two list routes to the active company, the same way GET /connectors already is, so the whole POS connector page shows one company:
- GET /fiscal/documents: replace `const scope = await scopeTenantWhere(req, 'read')` with `const tenantId = activeTenantId(req, 'the POS connector belongs to one company'); const scope = { tenantId }`. Change `conceptWhere(req, q.conceptId, 'read')` so a foreign conceptId still gives 404/empty, for example `...(q.conceptId && { conceptId: q.conceptId })` after `assertConceptOwned(req, q.conceptId, 'read')` plus the tenantId filter. Change `counts: await fiscalCounts(tenantIdsOf(scope))` to `fiscalCounts([tenantId])`.
- GET /terminal/charges: replace `...(await scopeTenantWhere(req, 'read'))` with `tenantId: activeTenantId(req, 'the POS connector belongs to one company')`.
- Also add tenantId to the select and items of both routes, so the client can tell companies apart without guessing from brand and machine ids.
- Two-company test: in portfolio view (x-servd-portfolio: 1), company A's operator gets no company B rows from either list.

(2) R7: in PUT /fiscal/brand-pos-ids change both `z.number().int().positive().nullable()` to `z.number().int().positive().max(2147483647).nullable()`, so an out-of-range ID gets a 422 instead of a Postgres INT overflow 500.

No other files are needed: the R1–R6 frontend fixes are complete within my files.

## wf_44a64251-build-W3b.json
W4 (orchestrator) changes the UI relies on. Until they land the UI degrades safely:

1) **backend/src/modules/orders/routes.ts, POST /orders/:id/cancel (spec §17.4).** Today it is `requireAuth(...MANAGERS)` and takes only `{reason}`. The admin now sends `managerOverridePin` for non-managers. Change it to:
```ts
const cancelOrderSchema = z.object({
  reason: z.string().trim().min(3, 'Reason is required').max(500),
  managerOverridePin: z.string().min(4).max(8).optional(),
})
// preHandler: requireAuth(...CASHIERS, 'foh' /* waiter roles that ring orders */)
// after the company-scoped lookup:
const actor = req.staffUser!
let approverId: string
if (isOverrideApprover(actor.role)) approverId = actor.id
else {
  if (!body.managerOverridePin) throw new AppError('MANAGER_OVERRIDE_REQUIRED', 'Cancelling an order needs a manager', 403)
  const mgr = await verifyManagerPin(body.managerOverridePin, order.concept.tenantId) // same-company manager only
  if (!mgr) throw new AppError('INVALID_MANAGER_PIN', 'That PIN does not belong to a manager of this company', 403)
  approverId = mgr.id
}
await cancelOrder(order.id, { reason, approverId, actor: {...}, metadata: { ip: req.ip, approverId } })   // cancelOrder calls markPreBillsCancelledTx(tx, orderId, approverId, reason)
```
Until then, a non-manager sees "Only a manager can cancel an order — ask a manager to do it" (403 FORBIDDEN).

2) **backend/src/modules/pos/routes.ts paymentSchema**, inside the per-tender object: add `manualReason: z.enum(['terminal_offline']).optional()` and pass it through to processPayment's tender meta (fix-W1 needsOtherFiles 2). The till sends it when the cashier keys the slip reference while the terminal connector is on. zod strips it today, so nothing breaks.

3) **backend/src/modules/pos/receipt.ts receipt-data (tablet).** Send `fiscal` (FiscalView, or `{status:'legacy', authority, fiscalNumber, qrPayload, verifyUrl}`), `heading: 'FULL & FINAL BILL'`, `servdRef`, `card: {brand, last4, authCode} | null`, and `notTaxInvoice: true` when `fiscalReportingRequired(tenantId)` is false. A non-final order returns 409 `{ error: { code: 'PRE_BILL_REQUIRED', message } }`; the tablet reads `body.error.code`. The tablet already falls back to the legacy fbr/srb fields when `fiscal` is absent.

4) **POST /pos/payments, comp and check-split settle** should return `fiscal: FiscalView | null` (spec §8.4). The modal reads `r.fiscal`. When `fiscal` is absent it polls GET /pos/orders/:id/fiscal; that route is registered by `registerConnectorPlugins` in index.ts (W4).

5) **index.ts:** `registerConnectorPlugins(api)` and `registerPreBillPlugins(api)`. Without them the pre-bill buttons show "Pre-bills are not on this server yet", and the card-machine UI falls back to the manual flow (404 feature detection).

6) **Optional, frontend/admin/src/lib/api.ts (outside the posApi additions I own):** keep `error.details` on ApiError, e.g. `throw new ApiError(res.status, data.error.code, data.error.message, data.error.details)`. The till could then read `{chargeId}` from 409 CHARGE_IN_PROGRESS / TERMINAL_CHARGE_ACTIVE and `{dueCents}` from AMOUNT_MISMATCH directly. Today it re-fetches with `GET /pos/terminal/charges?orderId=&active=1` and the bill instead.

## wf_44a64251-fix-W3b.json
1) Optional, for W1 (`backend/src/connectors/terminal/service.ts`, `chargeView`): add the refund's target payment to the view so the admin's in-flight check works per payment instead of per order. The admin already reads it as an optional field.
   In `interface TerminalChargeView`, add:
       targetPaymentId: string | null
   In the object `chargeView()` returns, add:
       targetPaymentId: c.targetPaymentId ?? null,
2) Optional, for W1 (`backend/src/modules/connectors/posRoutes.ts`): to show the fiscal panel to finance and management on /orders/[id] instead of hiding it on a 403, widen GET `/orders/:orderId/fiscal` from `requireAuth(...CASHIERS)` to `requireAuth(...CASHIERS, 'finance', 'management')` (de-duplicated, cast to `UserRole[]` as the retry route does). The route is still company-scoped through `scopeTenantWhere(req,'write')`, and `lastError` stays managers-only through `isManager`. Without this change the panel simply does not show for those roles; nothing breaks.

## wf_44a64251-build-LEFT.json
1) backend/src/modules/orders/service.ts (ingestOrder, around line 399). This would let the storefront drop its last post-insert tip write. Change the tip bound so it also counts the wallet share:
  const tipCents = dto.tip_cents ?? 0
  const tipCeiling = dto.payment.amountCents + (dto.wallet_amount_cents ?? 0)
  if (!Number.isInteger(tipCents) || tipCents < 0 || tipCents > tipCeiling) { throw new AppError('INVALID_TIP', ...) }
Then in storefront/routes.ts, delete `const tipInInsert = ...` and the line `if (body.tipCents > 0 && !tipInInsert) orderPatch.tipCents = body.tipCents`, and use `tip_cents: body.tipCents` in the DTO. I can make that storefront edit once the orders change is in.

2) backend/src/_types/order.ts (the backend's vendored copy of @servd/types, via the tsconfig path alias). Add the same field to OrderDTO after wallet_amount_cents:
  /** The part of the bill that is a tip, in cents — written to Order.tipCents in the same insert as the total. It is already inside payment.amountCents (never added on top); ingestOrder refuses a tip larger than that. Optional; absent means no tip. */
  tip_cents?: number
Optionally regenerate order.d.ts. After that, orders/service.ts IngestOrderDTO can become plain OrderDTO.

## wf_44a64251-fix-LEFT.json
None. Nothing outside groupOrders, the page and the test calls /group-orders/:code/lock (mobile, tablet and admin were grepped), so the stricter lock breaks no caller. The mobile app has no group-order client.

## wf_94e83c90-build-money-followups.json
Optional, not required for these fixes:
1. pos/service.ts applyGiftCardTender: the fallback branch (`if (giftCards.redeemGiftCardTx)`, the old own-transaction path and the `GiftCardEngine` optional type) can now be deleted, since the export always exists.
2. tests/auditTillGiftCard.test.ts: the vi.mock now returns the real module unchanged, so it can be removed along with its header comment.
3. orders/service cancelOrder could return refundDueCents so the till can prompt 'hand back PKR X'.
4. Admin till UI: add a 'Refund money taken' action on cancelled tickets that calls POST /pos/orders/:id/refund. New error codes to show: NOTHING_TO_REFUND, REFUND_EXCEEDS_DUE (422). The response now includes refundDueLeftCents.

## wf_94e83c90-fix-money-followups.json
1. orders/* (cancel path, owned by another agent): after a cancel or reject commits, call `postCancelledTicketUnwind(orderId)` from `pos/service.ts` (idempotent). Without that call, two cases keep wrong books: a ticket refunded in full before the cancel (R5-B), and a till bill whose home drawer booked the sale but which took no money (R5-C). Neither has a hand-back to trigger the unwind.
2. accounting/orderPosting.ts `postRefundPayment` (cancelled branch) still has the old 1110-only logic. Nothing in the refund engine uses it for cancelled tickets any more, but a future caller or backfill would repeat R5-A. It should either delegate to the same logic or refuse cancelled orders. Ideally the unwind and hand-back helpers move into accounting/ so there is one owner.
3. Known limits:
   - The unwind re-derives a pre-cancel close from the order's current figures, so an order edited between that close and the cancel would be unwound on the new figures.
   - Race: if a shift close posting reads the order as live while the cancel is committing, and the unwind is posted before that close entry exists, the close's sale booking is not unwound.

## wf_56ea9472-build-sf-quickfix.json
Optional follow-ups in files I was not allowed to edit:
(1) frontend/admin/src/lib/api.ts:193 should send Content-Type only when there is a body. The server now accepts it either way.
(2) backend/src/lib/storage.ts and the GET /media/upload-url route could refuse with 503 STORAGE_NOT_CONFIGURED when R2 isn't configured, instead of signing an upload URL for https://undefined.r2.cloudflarestorage.com. If that check were moved into a lib file, the /health check could be unit-tested.
Note: backend/src/modules/concepts/routes.ts and Providers.tsx already had other agents' uncommitted changes (FOH-01 till read access, UI-13 background meta). I kept them and built on them.

## wf_56ea9472-fix-sf-quickfix.json
Optional follow-up for RV-1: backend/src/modules/media/routes.ts (GET /media/upload-url) should refuse with 503 STORAGE_NOT_CONFIGURED when R2_ACCOUNT_ID, R2_ACCESS_KEY_ID or R2_SECRET_ACCESS_KEY is unset. The Library already handles that code. For a stricter RV-3 rule ('blocked only when submitted by someone else'), backend/src/modules/siteLayouts/routes.ts editShape() would need to return submittedById.

## review-fix-till.json
1) TILL-R2 (required; till side already wired), backend/src/modules/giftCards/service.ts: add `export async function redeemGiftCardTx(tx: Prisma.TransactionClient, input: RedeemGiftCardInput): Promise<RedeemGiftCardResult>`. Its body is the current body of redeemGiftCard's transaction, and its first statement must be `await tx.$queryRaw\`SELECT id FROM orders WHERE id = ${input.orderId} FOR UPDATE\``. Inline that SQL; do not import lockOrderTx from pos/service, which would be a circular import. The order's status, totalCents and paid payments must then be read after that lock. redeemGiftCard(input) becomes `prisma.$transaction((tx) => redeemGiftCardTx(tx, input))`. pos/service.applyGiftCardTender picks it up automatically: one transaction with lockOrderTx, then redeemGiftCardTx, then applyCoverageTx. tests/auditTillGiftCard.test.ts then runs against the real function, because its mock only fills in a missing export. The storefront caller (storefront/routes.ts:1062) gets the lock for free.
2) TILL-R4 FBR part, backend/src/adapters/fbr/index.ts buildFbrDataForOrder (~line 272): pass `totalCents: order.totalCents - (order.tipCents ?? 0)`, so that both TotalSaleValue (totalCents - taxCents) and TotalBillAmount leave the tip out. This matches the line items, which already exclude it. Also check any other refund path outside the till that calls submitSrbReturnForRefund or queues kind:'return' with a raw refund amount (e.g. the orders/refunds engine). It should pass `taxableRefundCents(order, alreadyRefunded, amount)` from pos/service.ts, not the raw tender refund.
3) F1, frontend/admin/src/app/orders/[id]/page.tsx voidLine.onSuccess (~line 258): read the void response `{ order: {totalCents, taxCents, serviceChargeCents, discountCents}, removedCents, splitCleared, refund: {amountCents, method} | null }`. Keep invalidating ['order-detail', id]. If `splitCleared`, tell the cashier ('The split was cleared because the bill changed. Re-split it') and link or route to `/orders/${id}/split`. If `refund`, show 'PKR x refunded by <method>'. Handle the new error codes ORDER_PARTLY_PAID / VOID_LAST_LINE / OPEN_DRAWER_REQUIRED with their messages. frontend/admin/src/app/refunds/page.tsx (method select ~line 191): offer only the methods present on the order's `payments` with status 'paid' and amountCents > 0. Default to that tender when only one exists, and hide the select's blank 'auto' option when there is a single tender.
4) Optional, frontend/admin/src/lib/api.ts: ApiError drops `error.details`. Keeping it (`throw new ApiError(res.status, data.error.code, data.error.message, data.error.details)`) would let UIs read 409 payloads directly. The till works around this today with GET /pos/shifts/:id/open-tickets. posApi.closeShift could also take `confirmOpenTickets`, though /pos/shift and /reconciliation now use tillApi.closeDrawer.

## review-fix-ledger.json
**LEDGER-R5 (backend/src/modules/pos/service.ts, refundOrder at ~2083 and assertRefundableStatus at ~2072)**
1. Import `refundDueCents` from `../accounting/orderPosting.js`.
2. At the top of refundOrder, check `order.status === 'cancelled' || order.status === 'rejected'`.
   - Let `due = refundDueCents(order)`. order.payments already carries method, status, amountCents, gatewayRef and shiftId.
   - If `due <= 0`, throw AppError('NOTHING_TO_REFUND', 'No money was taken on this ticket at the till', 422).
   - If `input.amountCents > due`, throw AppError('REFUND_EXCEEDS_DUE', ..., 422).
   - Keep the same cap/manager-PIN check and drawer resolution.
   - Inside the locked transaction, re-check `refundDueCents({ status: current.status, payments: current.payments })` instead of assertRefundableStatus/assertRefundable, then call writeRefundTx as today. Its postRefundPayment already books Dr 1110 / Cr 1015 (cash) or 1030 (card) for a cancelled ticket.
   - After the transaction, do NOT call updateOrderStatus('refunded'): the order stays cancelled. Do NOT queue an SRB sales-return; it was never a sale (unless order.srbInvoiceNumber is set — then still file the return). Do NOT call postOrderRefund: cancelOrder already restored points, wallet and cards.
   - Audit it as 'order_refund_due'.
3. Optional: cancelOrder could return `refundDueCents` so the till prompts "hand back PKR X".
4. The Z-report already shows refundDueCents (pos/service.ts:1149).
5. The till UI needs a "Refund money taken" action on cancelled tickets that calls the existing refund route.

**LEDGER-R6 (backend/src/modules/reports/service.ts, salesBuckets)**
1. Import `giftCardAppliedOf` from `../accounting/orderPosting.js`.
2. **Sale side, step 1:** after the aggregate, run `prisma.giftCardRedemption.findMany({ where: { amountCents: { gt: 0 }, order: where }, select: { amountCents: true, order: { select: { completedAt: true, placedAt: true, source: true } } } })`. For each row, `slot(keyAt(by, soldAt(r.order), r.order.source)).gross += r.amountCents`. The ledger credits revenue on the pre-card value (ONL-05).
3. **Refunds, step 4:** change `refundOrder.select` to add `giftCardRedemptions: { select: { amountCents: true } }`. In the loop, call `addRefund(at, { ...p.order, giftCardAppliedCents: giftCardAppliedOf(p.order.giftCardRedemptions) }, prior, amount)`. Do the same in step 5 (wallet restore).
4. **New step 6, gift-card restore:**
   - Find `giftCardRedemption` rows with `reversedAt` in [q.from, q.to] whose order matches `AND: [orderScope(q), { status: 'refunded' }]`.
   - Select id, amountCents, reversedAt, redeemedAt and order: { ...refundOrder.select, walletAmountCents, giftCardRedemptions: { orderBy: { redeemedAt: 'asc' }, select: { id, amountCents } } }.
   - For each, compute `prior = tender refunds (sum |payments|) + (walletAmountCents > 0 ? walletAmountCents : 0) + the amounts of the order's earlier redemptions`.
   - Call `addRefund(r.reversedAt, { ...order, giftCardAppliedCents: giftCardAppliedOf(order.giftCardRedemptions) }, prior, r.amountCents)`.
   - This mirrors orderPosting.postOrderRefund step 4.
5. Update the header formula comment ("order value = charged + wallet + gift card").
6. Test: an order of value 1150 (tax 150) with a 500 gift card. With no refund, register gross is 1150. A partial refund of 325 reverses 42 of tax. A full refund puts refunds at 1150 and tax at 0.

**LEDGER-R10 (backend/scripts/seed-live-state.ts:505 and backend/scripts/seed-customer-experience.ts:72)**
1. Change the `loyaltyAccount.upsert` to `where: { tenantId_customerId: { tenantId, customerId } }` and `create: { tenantId, customerId, ... }`, with tenantId taken from the seeded concept (`concept.tenantId`; skip if null).
2. Optional: add `scripts` to a separate tsconfig check so tsc covers them.
3. Anyone who already ran the broken seed-customer-experience must delete customer demo.power@servd.pk before rerunning.

**F5**
Nothing needed. Reservations already calls `creditPointsTx(tx, { customerId, tenantId, points, description })` and then `bookEarn(txId)`. The non-transactional form is `creditPoints(input)`.

## fix-orders.json
1) tablet/app/(staff)/kds/[stationId].tsx: change the QueueLegacy status type to 'pending'|'preparing'|'held'|'recalled' and show a REMAKE label on recalled lines. Held lines no longer reach this screen. 2) tablet/app/(staff)/kds/index.tsx: no change is needed now, because READY on a paid ticket works on the server. Optional: show a PAID chip from `paid` on /expo/queue. 3) backend/src/modules/storefront/routes.ts, around lines 975-998: add `tip_cents: body.tipCents` to the DTO passed to ingestOrder and remove the later `if (body.tipCents > 0) orderPatch.tipCents = body.tipCents`, so the tip is written in the same insert as the total. 4) packages/types OrderDTO: optionally add `tip_cents?: number`. IngestOrderDTO in orders/service.ts adds it locally for now. 5) The earlier report's items for pos/service.ts and adapters/whatsapp/conversation.ts are still open: pos-${Date.now()} should become a UUID, the early key lookup needs brand scoping, and the WhatsApp order source is wrong.

## fix-online.json
ONLINE-R6, in backend/src/modules/groupOrders/routes.ts (owned by the groupOrders/orders area). Add `import { assertOpenForOrders, assertItemsServedAt } from '../storefront/serviceHours.js'`.
(1) POST /:code/submit: just before calling ingestOrder (around line 325), add `const now = new Date(); await assertOpenForOrders(go.concept, now, false); await assertItemsServedAt(go.conceptId, <all member item menuItemIds>, now)`. The concept must be selected with { id, name }. This gives 409 BRAND_CLOSED and 400 ITEM_UNAVAILABLE, the same as checkout.
(2) POST /:code/items (add item, around lines 126-168): after the isAvailable/conceptId check, add `await assertItemsServedAt(go.conceptId, [menuItemId], new Date())`.
(3) Optionally, POST create: call assertOpenForOrders as well, so a group can't be started while the brand is closed.
Add a regression test to tests/groupOrderSubmit.test.ts with two cases: a brand whose ServiceHours exclude now gets 409 on submit, and a lunch-only (12:00-16:00) item added outside its window gets 400.
Frontend: group-order/[code]/page.tsx should refetch the menu before submitting, or show the 409/400 message.

## fix-auth.json
None. Optional, from the earlier report: hr/service.ts could warn when an HR employee's linked login is suspended (the payroll side of PPL-10). The auth middleware's memberTenantIds must keep counting users.tenantId as membership; the switch and backfill logic depend on it.

## fix-hr.json
1) HR-R7, the structural fix (schema.prisma plus a migration; I may edit neither):
- In TipPoolMember, make `userId String?` and add `employeeId String?` with `employee HrEmployee? @relation(fields:[employeeId], references:[id])` and `@@index([employeeId])`.
- Replace `@@unique([poolId, userId])` with two partial unique indexes in SQL: (poolId, userId) WHERE userId IS NOT NULL, and (poolId, employeeId) WHERE employeeId IS NOT NULL. Add a CHECK that userId or employeeId is not null.
- Consider adding tenantId to tip_pools: today the model carries no tenantId and is scoped only through conceptId, which breaks the CLAUDE.md rule for new tables.
- Once that lands, tipPools/routes.ts hoursAtBrand/computePool should build members from HrEmployee: kiosk-only staff become members with employeeId, and their weight comes from their designation (barista, or a new designation-to-weight map). The KIOSK_STAFF_NOT_IN_POOL block can then go.

2) HR-R8: in frontend/admin/src/app/accounting/page.tsx (around line 144), filter the card grid by the signed-in user's modules from GET /permissions/me. Show Tip pools only with 'payroll', Gift cards only with 'gift_cards', Payroll only with 'staff_hr' or 'payroll', and Audit log per its gate. Today fnb_manager, who holds 'accounting', sees cards whose APIs return 403.
