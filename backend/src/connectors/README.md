# connectors/ — the POS connector

servd's only path to FBR/SRB filing and to the card machine. The vendor
contract is in `docs/pos-connector-api.md` and the design is in the
2026-10-10 spec.

**Never add a direct authority client.** FBR/SRB filing goes only through
the fiscal POS, using this folder's outbox. Every path that completes an
order goes through `completeOrder`, which inserts the sale document.

| File | What |
|---|---|
| `types.ts` | The frozen driver contract: `Outcome`, `ConnectorCtx`, `FiscalDriver`, `TerminalDriver`, payloads and settings |
| `registry.ts` | `FISCAL_DRIVERS` / `TERMINAL_DRIVERS`; `getConnector(tenantId, kind)` (lazy row, 30 s cache, decrypted), `buildCtx`, the injectable clock |
| `config.ts` | Zod settings (defaults and clamps), the SSRF guard, and `fiscalReportingRequired(tenantId)` (§17.7) |
| `util.ts` | `withTimeout`, backoff, HMAC sign and verify, message scrubbing, PKT time helpers |
| `drivers/test.ts` | The built-in deterministic test driver. It never contacts a network and never files a real invoice. |
| `drivers/http.ts` | The generic "servd connector API v1" driver |
| `fiscal/payload.ts` | Builds the payload from STORED order figures, with refunds pro rata, plus the ported SRB and FBR field mappings |
| `fiscal/outbox.ts` | `enqueueFiscalSaleTx` / `enqueueFiscalRefundTx` (inside the caller's transaction), `sendFiscalDocument` (DB lease, lookup before resubmit), `submitFiscalNow` / `submitFiscalAtTill`, `kickFiscal`, retry, manual filing, release of held documents, the sweeper |
| `fiscal/view.ts` | `FiscalView`, `fiscalViewForOrder`, `legacySrbAlias` |
| `fiscal/qr.ts` | `renderQrSvg` (synchronous inline SVG) |
| `terminal/service.ts` | Card-machine charges: start (re-quote), the forward-only `applyChargeState`, `recordApprovedCharge` (via processPayment / settlePayment / refundOrder), `reverseCharge`, cancel, resolve, refunds, the reconciler |
| `terminal/guard.ts` | `assertNoActiveTerminalChargeTx`, `assertShiftHasNoActiveCharges` |
| `alerts.ts` | ExceptionFlags (connector kinds) plus a best-effort WhatsApp message to the people who can fix the problem |
| `health.ts` | `connectorHealthChecks()` for `/health` (ok / warn / off, never fail) |
| `inbound.ts` | Parses webhook events and applies them to the connector's own company |
| `legacyDrain.ts` | One-off drain of the old `fbr-submission` / `srb-submission` queues. Remove it one release after the cutover. |

Routes are in `modules/connectors/` (`/connectors`, `/pos/terminal/*`,
`/pos/orders/:id/fiscal*`, `/webhooks/pos/:token`). The workers are
`workers/fiscalConnector.ts` and `workers/terminalConnector.ts`.

Rules:

- **One company per row.** Every query carries `tenantId`. Inbound webhooks
  touch only the token's company. A foreign id is ignored or gets a 404.
- **No operator skip.** `skipped` is automatic only: `prefiled_direct`,
  `zero_value`, `zero_value_unsupported` or `no_sale_document`. Held
  documents are released all at once, per company or per brand, and never
  by date range.
- **The payload is frozen** from the first attempt onward. Only a held
  document, or a waiting refund, that has never been attempted is rebuilt
  (a waiting refund from its sale's payload as filed, keeping its own time,
  amount, reason and tender).
- **A live fiscal connector is never re-pointed** from the settings PUT:
  changing its driver or base URL is `409 SWITCH_OFF_FIRST`.
- **BullMQ jobs are removed when they finish.** `attempts` can go down (a
  send that finds the connector off), so a kept job would swallow the next
  kick for the same `fiscal-<id>-<attempts>` slot. The sweeper re-drives any
  due row every 30 s regardless.
- **A card refund is checked before the machine is asked**: RefundPolicy
  reason / photo / the actor's own cap and the card-refundable amount, the
  same refusals refundOrder makes when it books it. There is no manager-PIN
  step on the machine flow. A refund is never reversed.
- **A reversing refund counts only when confirmed** (`vendorMeta.reversal`,
  polled on `<chargeId>-rev…`); a same-day void is final at once.
- **The test driver** produces `TEST-…` numbers with `isTest=true`, and
  receipts say `TEST — NOT A FISCAL INVOICE`.
