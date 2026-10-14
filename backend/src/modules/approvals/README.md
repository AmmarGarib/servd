# Approvals inbox (owner decision D3, 2026-10-11)

One place that lists everything waiting on the signed-in person's approval,
with a count per type. Admin page: `/ceo/approvals` (CEO section → Approvals,
and "Approvals" under the personal pages for everyone else who approves
something). The old "My approvals" (`/hr/approvals`) redirects there.

## The rule: read-only, nothing copied

- **Items stay in their modules.** The module's own status column is the only
  record of an item's state. There is no approvals table and no second
  approval engine.
- **Reading goes through the module's own queue route**, as the signed-in
  user (`ctx.read` re-issues a GET inside the server with the same session and
  company headers). So the module's role guard, the CEO's Module Access switch
  and the module's company scope all apply unchanged: whatever the module
  would not show, the inbox does not either. A route that answers 401/403/404
  removes the type from that person's inbox.
- **Acting goes through the module's own route.** Each item carries its
  actions (method + path + body); the page calls them directly, and the
  module's existing guard decides (wrong role 403, other company 404,
  separation of duties, state checks).
- **Company-scoped**: items are kept only for the companies in view
  (`resolveTenantScope` — the active company, or every company the user
  belongs to in "All companies" view), so counts are per company. A row with
  no company is a module's own legacy case its route already chose to show
  (a company-less signup, an orphan supplier, a shared site page). A
  company-less login is listed with Reject only: Approve waits until it has a
  company on Workforce (that screen's own rule).
- **One exception: HR requests** (`spansMemberCompanies`). `/hr/approvals`
  spans every company the user belongs to on purpose, and `/hr/team`'s
  "waiting on you" count is that same list, so the inbox keeps every member
  company's HR steps whatever the view (labelled by company) and the two
  counts agree.
- Items of another type in the user's OTHER companies are counted, never
  listed (`elsewhere` per type and in total), so the page can say "switch to
  All companies".

## Types

| type | queue route (read) | act route (existing) | who (the route's roles) |
|---|---|---|---|
| `staff_login` | `GET /auth/staff/pending` | `PATCH /auth/staff/:id/approve`, `/reject` | admin |
| `storefront_publish` | `GET /site-layouts?status=pending` | `POST /site-layouts/:slug/approve`, `/reject` (note) | admin |
| `purchase_order` | `GET /procurement/approvals` | `POST /procurement/purchase-orders/:id/approve`, `/reject` (reason) | admin |
| `recipe` | `GET /recipes/pending-approval` | `POST /recipes/:id/approve`, `/reject` | admin, owner (never your own submission) |
| `hr_request` | `GET /hr/approvals` | `POST /hr/records/:section/:id/decide` | per record step: reporting manager, HR, management |
| `payroll_run` | `GET /hr/payroll/runs` (drafts) | `POST /hr/payroll/runs/:id/approve` | admin, owner, management (never whoever prepared it) |
| `tip_pool` | `GET /tip-pools` (window over, or posted) | opens /tip-pools (post / pay need review) | admin, owner |
| `stock_transfer` | `GET /stock-transfers?status=requested` | `PATCH /stock-transfers/:id/approve`, `/cancel` | managers |
| `cash_request_hod` | `GET /trustops/cash-vouchers?view=hod` (rows with `canSignHod`) | `POST /trustops/cash-vouchers/:id/sign-hod`, `/reject` (note) | per item: the holder's reporting manager or a cash keeper (the route decides; never the holder) |
| `cash_voucher` ("Cash requests") | `GET /trustops/cash-vouchers?status=hod_signed` | `POST /trustops/cash-vouchers/:id/approve`, `/reject` (note) | admin — the director (never the login that signed as HOD: Approve disabled, 409 SAME_SIGNER) |
| `fixed_asset_request` | `GET /accounting/fixed-assets/requests?status=pending` | `POST /accounting/fixed-assets/requests/:id/approve`, `/reject` (note) | admin (finance asks: disposal, scrap, write-down, capitalisation …) |
| `intercompany_transfer` | `GET /accounting/intercompany/transfers?status=submitted` | `POST /accounting/intercompany/transfers/:id/approve`, `/reject` (note) | admin who belongs to BOTH companies (otherwise listed with the buttons disabled); the item sits in whichever of its two companies is in view |
| `bad_debt` | `GET /accounting/receivables/write-offs?status=requested` | `POST /accounting/receivables/write-offs/:id/approve`, `/reject` (note) | admin — the CEO approves every write-off (G12 / H15); no requester-based disabled button: the CEO is exempt from self-approval (decision 27) and the route's `assertNotSelfApproval` decides |
| `raast_void` | `GET /reconciliation/raast/receipts?voidRequested=1` | `POST /reconciliation/raast/receipts/:id/void` (reason ≥ 10), `/void-request/reject` (note) | admin; a receipt that can no longer be voided shows the route's own reason on a disabled button |
| `grni_writeoff` | `GET /procurement/grni?writeOffRequested=1` | `POST /procurement/grni/:receiptLineId/write-off/approve`, `/write-off/reject` (note) | admin |
| `stock_difference` | `GET /accounting/stock-differences?status=pending` (one row per 1290 suspense line) | `POST /accounting/stock-differences/approve` `{lineIds:[id]}`, `POST /accounting/stock-differences/:id/query` (note) | admin — waste and count differences wait in 1290 until the CEO approves them into cost of sales (H20). Until that route exists it answers 404 and the type is not listed |

`approverRoles` in `providers.ts` mirrors each approve route's `requireAuth`
list. It only narrows (a queue route wider than its approve route — the
storefront list, the payroll register, stock transfers — never shows an item
the person could not act on). It never widens: the route still decides.

Not in the inbox, on purpose: manager-PIN overrides at the till (real time,
not a queue); period reopen, manual journals, journal reversal and bank-line
adjustments (the CEO / approvers act directly — there is no "request" state
to approve). If one of those gains a request step, it becomes a provider
here. (Capitalising a CapEx line became one: finance's capitalisation now
waits as a `fixed_asset_request`.)

`delegable` is false for every finance wave B type: each approve route checks
role `admin` itself (fixed-asset events, inter-company, write-offs, Raast
voids, GRNI, stock differences), so a delegate could not act on them. The HOD
step (`cash_request_hod`) is per item, like HR steps.

**PARKED (owner, 2026-10-13):** `on_account_client` stays in `APPROVAL_TYPES`
but has no provider (the on-account clients feature and its route are
parked). The inbox lists only registered providers, so nothing else is
needed; the resume adds the provider.

## Adding a type

One provider in `providers.ts`: read the module's existing queue route with
`ctx.read`, return `null` when it refuses, map rows to `ApprovalItem`s whose
actions call the module's existing routes. Add it to `APPROVAL_TYPES`, add a
two-company test in `tests/approvalsInbox.test.ts`.

## Hand-over to HODs (later)

`delegations.ts` is the seam: `ApprovalDelegations.typesFor(userId,
tenantIds)` is consulted per type next to `approverRoles`. Today it returns
nothing. When head office exists, a per-company `ApprovalDelegation` table
plugs in there — AND each delegable type's approve and queue routes must
accept the delegate (an `assertCanApprove(req, type, tenantId)` helper on the
same table). Until both are done a delegate sees nothing: the safe failure.

## Registration

`registerApprovalsPlugin(api)` from the `/api/v1` scope in `src/index.ts`
(→ `/api/v1/approvals`, `/api/v1/approvals/counts`). The internal reads go to
the same `/api/v1` base (derived from the plugin's prefix, or `apiBase`).
They carry no forwarding headers, so they are internal requests and never
spend the user's rate-limit allowance.
