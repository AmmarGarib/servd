export const meta = {
  name: 'pos-connector-design',
  description: 'Map the current direct FBR/SRB path, then design a vendor-neutral POS (fiscal) + card-machine connector and the admin API section via two independent designs and a synthesis',
  phases: [{ title: 'Map' }, { title: 'Design' }, { title: 'Synthesize' }],
}

const ROOT = '/home/user/servd'
const SP = '/tmp/claude-0/-home-user-servd/33ef43a5-b49c-56f9-95d2-440e3a7d20b8/scratchpad'

const DECISIONS = `OWNER DECISIONS (2026-10-10, binding):
1. servd is the in-house software staff use to take orders. It must talk, through a POS API, to (a) an external POS that does FBR + SRB compliance (fiscal invoicing) and (b) a payment processor's card machine (card terminal at the till).
2. FBR/SRB reporting moves to the external POS ONLY. servd's own direct FBR PRAL + SRB ePOS submission (backend/src/adapters/fbr, backend/src/adapters/srb, backend/src/workers/fbrSubmission.ts, srbSubmission.ts and everything that enqueues/reads them) is switched off and REMOVED in the same piece of work (CLAUDE.md standing rule: when a replacement is agreed, the old one is removed — API, pages, sidebar links, catalogue entries — with anything it fed moved to the new one first; keep the old tables/columns, do not drop data). Never both reporting at once.
3. The POS and card-machine vendors are NOT chosen yet: build a vendor-neutral connector with a pluggable driver interface and a built-in TEST driver (simulates the fiscal POS and the terminal, deterministic, usable in dev and tests); a real vendor driver plugs in later.
4. Hasham's WhatsApp connector IS the existing gateway (backend/src/lib/whatsapp.ts, URL+key in Settings, admin /configuration/whatsapp, default https://whatsapp.garibsons.app/...). The admin needs an "API" section with exactly two things: the WhatsApp connector and the POS connector. Do not create a second WhatsApp settings page — reuse/move the existing one.
CONSTRAINTS (CLAUDE.md): every new model/route/worker is company-scoped from the first commit (tenantId on rows; lib/tenantScope.ts; per-company config; secrets per company, never returned in clear); workspaces.ts is the one definition of the admin sidebar (module ids must be placed in a workspace); a sale must never be blocked because fiscal reporting is down (queue + retry, show status); GST tender split cash 15% / card 8%; ledger rules; no aggregator code.`

const MAP_SCHEMA = { type: 'object', properties: {
  touchpoints: { type: 'array', items: { type: 'object', properties: { file: { type: 'string' }, what: { type: 'string' }, action: { type: 'string' } }, required: ['file', 'what', 'action'] } },
  dataModel: { type: 'string' }, receiptAndQr: { type: 'string' }, existingCardFlow: { type: 'string' }, whatsappToday: { type: 'string' }, adminPages: { type: 'string' }, risks: { type: 'string' } },
  required: ['touchpoints', 'dataModel', 'receiptAndQr', 'existingCardFlow', 'whatsappToday', 'adminPages', 'risks'] }

phase('Map')
const map = await agent(`${DECISIONS}

Read-only task (do not edit files). Map the CURRENT system in ${ROOT} so a replacement can be built without breaking anything:
1. Every touchpoint of servd's direct FBR/SRB path: adapters/fbr, adapters/srb, workers/fbrSubmission.ts, workers/srbSubmission.ts, lib/queue.ts, index.ts registration, where submissions are enqueued (orders/service.ts, pos/service.ts, refunds/credit notes), the invoices module (TaxInvoice model/routes/service), Concept fields (fbrPosId, srbPosId, ntn, invoiceLegalName…), receipts (pos/receipt.ts, tablet/src/lib/printer.ts — fiscal invoice number + QR), health checks (/health), admin pages (settings/integrations, configuration/tax, receipts, invoices, anything reading TaxInvoice), reports (sales-tax return), tests that cover them (backend/tests). For each: file, what it does, and the action needed (move to connector / remove / keep as-is).
2. The data model involved (TaxInvoice and related columns) — quote the schema.
3. How the fiscal invoice number and QR reach the receipt today (backend + tablet + admin print).
4. How card payments are taken at the till today (pos/service.ts processPayment tenders 'card' and 'keenu_qr', PaymentModal, tablet) — where a terminal 'charge' step would slot in.
5. How WhatsApp works today (lib/whatsapp.ts, the settings routes in auth/routes.ts /integrations/whatsapp, admin /configuration/whatsapp, inbound adapters/whatsapp/conversation.ts and its webhook route).
6. Current admin structure for this: backend/src/lib/workspaces.ts Dev workspace, frontend/admin/src/lib/moduleCatalog.ts 'integrations' pages.
7. Risks: what would break or double-report during the switch.
Note: other agents are editing pos/*, orders/*, auth/*, storefront/* right now (uncommitted); read the working tree as it is.`, { label: 'map:fbr-srb-whatsapp', phase: 'Map', schema: MAP_SCHEMA, effort: 'high' })

const DESIGN_SCHEMA = { type: 'object', properties: {
  summary: { type: 'string' },
  dataModel: { type: 'string', description: 'Prisma models/columns to add, with tenantId, indexes, uniques' },
  driverInterface: { type: 'string', description: 'TypeScript interface for fiscal + terminal drivers, incl. the test driver behaviour' },
  fiscalFlow: { type: 'string' }, terminalFlow: { type: 'string' },
  api: { type: 'string', description: 'routes (method, path, roles, body, response) incl. inbound vendor webhook auth' },
  workers: { type: 'string' }, adminUi: { type: 'string' }, receipt: { type: 'string' },
  removalPlan: { type: 'string', description: 'ordered steps to remove direct FBR/SRB and move what it fed' },
  migration: { type: 'string' }, tests: { type: 'string' }, files: { type: 'string', description: 'exact files to create/edit/delete' },
  risks: { type: 'string' } },
  required: ['summary', 'dataModel', 'driverInterface', 'fiscalFlow', 'terminalFlow', 'api', 'workers', 'adminUi', 'receipt', 'removalPlan', 'migration', 'tests', 'files', 'risks'] }

const ANGLES = [
  { key: 'reliability', text: 'RELIABILITY-FIRST: the till must never stall or double-charge, every sale must eventually reach the fiscal POS exactly once, every card charge must reconcile even if the network drops mid-transaction (unknown-state handling, idempotency keys, outbox pattern, retries with backoff, dead-letter + manager alerts, reconciliation job, offline till behaviour).' },
  { key: 'pluggable', text: 'VENDOR-PLUG-FIRST + SIMPLICITY: the smallest clean design that lets a real Pakistani fiscal-POS vendor and a card-terminal processor (e.g. via a cloud terminal API with push-payment + webhook/poll) be added later by writing one driver file and filling settings, with a generic HTTP/JSON driver that may already work for many vendors; minimal new tables; reuse existing models (TaxInvoice, Payment, Setting) where they fit.' },
]

phase('Design')
const designs = await parallel(ANGLES.map((ang) => () => agent(`${DECISIONS}

MAP OF THE CURRENT SYSTEM (from a previous agent):
${JSON.stringify(map, null, 1)}

Design (do not edit files) the replacement, angle: ${ang.text}
Cover: data model (per company), driver interface (fiscal: submitSale, submitRefund/creditNote, status; terminal: startCharge, getChargeStatus, cancelCharge, refund), the built-in TEST driver, the GENERIC HTTP driver (configurable base URL + API key + HMAC webhook secret), fiscal flow (when a sale is submitted — on completion; refunds; what the receipt shows when the fiscal number is not back yet; retries; never blocking the sale), terminal flow at the till (cashier taps 'Charge on card machine' -> amount pushed -> poll/webhook -> approved/declined -> Payment recorded through the existing processPayment with tender card at the 8% re-priced total; timeouts; cancel; refunds to card), API routes with roles (CEO/IT configure; cashiers charge; webhook auth), workers, the admin "API" section (Dev workspace: WhatsApp connector card = the existing gateway settings moved/linked, POS connector card = config + per-brand/outlet POS IDs + test button + live status + recent submissions/failures with retry), receipt changes (fiscal invoice number + QR from the POS, 'pending' line when not yet back), the removal plan for direct FBR/SRB (ordered, nothing it fed left dangling), migration, tests (two-company, idempotency, failure/retry, terminal timeout), exact file list, risks.`, { label: `design:${ang.key}`, phase: 'Design', schema: DESIGN_SCHEMA, effort: 'high' })))

phase('Synthesize')
const spec = await agent(`${DECISIONS}

MAP:
${JSON.stringify(map, null, 1)}

TWO INDEPENDENT DESIGNS:
${JSON.stringify(designs.filter(Boolean), null, 1)}

You are the lead architect. Produce ONE final build spec: pick the better base design, graft the strongest ideas from the other (especially reliability guarantees into the simpler design), resolve conflicts, and make it concrete enough that 3-4 agents with DISJOINT file sets can build it in parallel tonight. Write it as Markdown to ${SP}/pos-connector-spec.md (that is the only file you may write) with sections: Decisions recap; Data model (exact Prisma); Driver interface (exact TS); Test driver behaviour; Generic HTTP driver contract (request/response JSON, webhook signature); Fiscal flow; Card-terminal flow; API routes (method, path, roles, zod body, response, errors); Workers; Admin API section (pages, components, sidebar via workspaces.ts + moduleCatalog.ts); Receipt (backend receipt data + tablet printer + admin print); Removal of direct FBR/SRB (ordered steps, each touchpoint from the map with its fate); Migration; Tests; Build split — workstreams with disjoint file ownership and the order they must land in; Owner checklist (what the owner/vendor must provide later). Return the same content as your final message.`, { label: 'synthesize:spec', phase: 'Synthesize', effort: 'high' })

return { map, designs, spec }