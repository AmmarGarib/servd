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
| `cash_request_finance` ("Cash vouchers — finance approval") | `GET /trustops/cash-vouchers?view=finance` (rows with `canFinanceApprove`) | `POST /trustops/cash-vouchers/:id/finance-approve`, `/return` (note), `/reject` (note) | finance (role finance with the accounting module; never on a voucher they raised or hold — 409 SELF_APPROVE). Replaces the retired `cash_request_hod` (2026-10-15; the type id still parses, no provider) |
| `cash_voucher` ("Cash requests") | `GET /trustops/cash-vouchers?view=ceo` (finance_approved + legacy hod_signed) | `POST /trustops/cash-vouchers/:id/approve`, `/return` (note), `/reject` (note) | admin — the final approval (never the raiser / holder: 409 SELF_APPROVE; never the login that gave the finance approval or a legacy HOD signature: Approve disabled, 409 SAME_SIGNER) |
| `fixed_asset_request` | `GET /accounting/fixed-assets/requests?status=pending` | `POST /accounting/fixed-assets/requests/:id/approve`, `/reject` (note) | admin (finance asks: disposal, scrap, write-down, capitalisation …) |
| `intercompany_transfer` | `GET /accounting/intercompany/transfers?status=submitted` | `POST /accounting/intercompany/transfers/:id/approve`, `/reject` (note) | admin who belongs to BOTH companies (otherwise listed with the buttons disabled); the item sits in whichever of its two companies is in view |
| `bad_debt` | `GET /accounting/receivables/write-offs?status=requested` | `POST /accounting/receivables/write-offs/:id/approve`, `/reject` (note) | admin — the CEO approves every write-off (G12 / H15); no requester-based disabled button: the CEO is exempt from self-approval (decision 27) and the route's `assertNotSelfApproval` decides |
| `raast_void` | `GET /reconciliation/raast/receipts?voidRequested=1` | `POST /reconciliation/raast/receipts/:id/void` (reason ≥ 10), `/void-request/reject` (note) | admin; a receipt that can no longer be voided shows the route's own reason on a disabled button |
| `grni_writeoff` | `GET /procurement/grni?writeOffRequested=1` | `POST /procurement/grni/:receiptLineId/write-off/approve`, `/write-off/reject` (note) | admin |
| `stock_difference` | `GET /accounting/stock-differences?status=pending` (one row per 1290 suspense line) | `POST /accounting/stock-differences/approve` `{lineIds:[id]}`, `POST /accounting/stock-differences/:id/query` (note) | admin — waste and count differences wait in 1290 until the CEO approves them into cost of sales (H20). Until that route exists it answers 404 and the type is not listed |
| `journal_request` | `GET /accounting/journal-requests?status=submitted` | `POST /accounting/journal-requests/:id/approve`, `/reject` (note) | admin; kind post is Finance's (hand-over locked, A22), kinds reverse / amend (a cancel / money edit of an existing manual entry, Journals tab 2026-10-23) the CEO's alone. Not listed while the route 404s |
| `ho_recharge` | `GET /accounting/intercompany/recharge-runs?status=submitted` | `POST /accounting/intercompany/recharge-runs/:id/approve` (tick-boxes `postInOpenPeriod`, `acknowledgeWarnings`), `/reject` (note) | admin, or the head office's Finance delegate (head-office-wide hand-over only). Not listed while the route 404s |
| `connector_change` | `GET /connectors/change-requests?status=submitted` | `POST /connectors/change-requests/:id/approve`, `/reject` (note) | admin, or a Dev delegate. Not listed while the route 404s |
| `on_account_client` | `GET /accounting/customer-accounts?pending=1` (`onAccountProvider.ts`) | `POST /accounting/customer-accounts/:id/approve`, `/reject` (note required) | admin only: new corporate clients and every credit-limit increase (decreases and suspensions apply at once). Provider `delegable: false`; `assertNotSelfApproval` on the requester, the CEO exempt; 409 `NOTHING_PENDING`. Facts: client, OA number, new vs current limit, terms, brands, requested by |

`approverRoles` and `delegable` in `providers.ts` come from the rights
registry (`lib/approvalRights.ts` `APPROVAL_RIGHTS`, below) — the one copy of
each approve route's role list. It only narrows (a queue route wider than its
approve route — the storefront list, the payroll register, stock transfers —
never shows an item the person could not act on). It never widens: the route
still decides.

Not in the inbox, on purpose: manager-PIN overrides at the till (real time,
not a queue); period reopen, direct manual journals, journal reversal and
bank-line adjustments (the CEO / approvers act directly — there is no
"request" state to approve). Manual journals finance PREPARES are journal
requests (`journal_request`). If one of those gains a request step, it becomes a provider
here. (Capitalising a CapEx line became one: finance's capitalisation now
waits as a `fixed_asset_request`.)

`delegable` is false for the CEO-section types (cash requests for the
director, fixed-asset requests, write-offs, Raast voids, GRNI, stock
differences, on-account clients): each approve route checks role `admin`
itself. Finance's cash-voucher step (`cash_request_finance`) is never handed
over either; the old HOD step (`cash_request_hod`) is retired.

**PARKED (owner, 2026-10-13):** `on_account_client` stays in `APPROVAL_TYPES`
but has no provider (the on-account clients feature and its route are
parked). The inbox lists only registered providers, so nothing else is
needed; the resume adds the provider.

**RESUMED (owner, 2026-10-15):** `on_account_client` now has its provider
(`onAccountProvider.ts`, registered in `APPROVAL_PROVIDERS`). It stays CEO-only.

### Delegable flags of the head-office and on-account providers

| type | provider `delegable` | why |
|---|---|---|
| `journal_request` | kind post: **false** (locked, `DELEGATION_ENABLED.journal_request = false`, A22); kinds reverse / amend are `ceo` section | a manual journal is the CEO's to release |
| `ho_recharge` | **true**, but only by a head-office-wide Finance hand-over (never one company) | the monthly recharge run; the CEO keeps the role path |
| `connector_change` | **true** (Dev section, module `api_pos`) | a Dev delegate may approve a POS connector change |
| `on_account_client` | **false** | CEO section, never handed over |


## Adding a type

One provider in `providers.ts`: read the module's existing queue route with
`ctx.read`, return `null` when it refuses, map rows to `ApprovalItem`s whose
actions call the module's existing routes, with `...rightsOf('<type>')` for
its roles and hand-over, and `submittedByIds` on each item. Add the type to
`APPROVAL_TYPES` AND its entry to `APPROVAL_RIGHTS` and `approvalSubject` in
`lib/approvalRights.ts` (tested: every type has both), and a two-company test
in `tests/approvalsInbox.test.ts`.

## The rights registry (`lib/approvalRights.ts`)

`APPROVAL_RIGHTS` is the ONE registry: one entry per type in `APPROVAL_TYPES`
(which lives there too; `types.ts` re-exports it). Providers, approve routes,
queue routes and the hand-over catalogue all read it.

| type | section | queue module | role path | hand-over | delegate must hold |
|---|---|---|---|---|---|
| `staff_login` | operations (floor roles); **ceo** for every password role | role_management | admin | floor logins only | staff_directory |
| `storefront_publish` | marketing; **ceo** for shared (no-company) pages | storefront | admin | company pages — **locked** (`DELEGATION_ENABLED.storefront_publish = false`) | storefront |
| `purchase_order` | procurement | procurement | admin | yes | procurement |
| `recipe` | operations; **ceo** when it has no company (A21) | recipes | admin, owner | yes | recipes |
| `hr_request` | hr | staff_hr | per step | the final step | staff_hr |
| `payroll_run` | hr | staff_hr | admin, owner, management | approve / lock / reopen | staff_hr |
| `tip_pool` | finance | payroll | admin, owner | post / pay | payroll |
| `stock_transfer` | operations | inventory | managers | **never** (the company's managers; exempt from the through-head-office rule) | — |
| `cash_request_finance` | finance | accounting | finance | **never** | — |
| `cash_request_hod` (retired) | finance | accounting | — | **never** | — |
| `intercompany_transfer` | finance | accounting | admin | head-office pairs only (owned by the head office, A4); company ↔ company is CEO-only | accounting |
| `journal_request` | finance; **ceo** for kinds reverse / amend | accounting | admin | kind post — **locked** (`DELEGATION_ENABLED.journal_request = false`, A22) | accounting |
| `ho_recharge` | finance | accounting | admin | head-office-wide hand-overs only | accounting |
| `connector_change` | dev | api_pos | admin | yes | api_pos |
| `cash_voucher`, `fixed_asset_request`, `bad_debt`, `raast_void`, `grni_writeoff`, `stock_difference`, `on_account_client` | **ceo** | — | admin | **never** | — |

Sections (`APPROVAL_SECTIONS`): `ceo`, `operations`, `procurement`,
`finance`, `marketing`, `hr`, `dev`. Titles are the workspaces' own
(procurement: "Procurement"). The section is explicit per type (A23) —
`sectionOf(type, item)` moves an item to `ceo` by what it is.

**Who may approve** (`assertCanApprove`, spec §7.4 as amended):

1. **Role path:** the role is in the registry's list, every company the item
   touches is one the caller belongs to, and the caller is the CEO **or** the
   item did not come through a head office. Through head office (A3) = a
   stored `viaHeadOfficeId`, or a submitter who is a non-admin member of a
   head office whose link to the company was live when it was submitted —
   being a member of the company too does not exempt them. Stock transfers
   are exempt.
2. **Delegation path:** the type is delegable, switched on, not CEO-only for
   this item, and a LIVE hand-over covers it. Company-owned types: one
   hand-over covers every company the item touches. Head-office-owned types
   (`ho_recharge`, `intercompany_transfer`): the hand-over's head office owns
   it (A4). An item that came through a head office goes only to THAT head
   office's delegate (A13).
3. **Separation of duties:** a non-admin among the item's submitters gets 403
   `SELF_APPROVAL_BLOCKED` and a `self_approval` flag
   (`separation-of-duties.ts assertNotAmongSubmitters`).
4. **Denied:** 403 `APPROVAL_NOT_YOURS` when the company is one the caller
   belongs to, reaches or holds a hand-over in; otherwise 404.
5. **Rows:** `approvalSubject(type, id)` reads the item's companies,
   submitters and status on serviceClient BEFORE the check (A5); on success
   the RLS context is widened to the item's companies and the module re-reads
   its row through `prisma`. `approvalInputOf(type, id, subject)` builds the
   check (item-level CEO-only included). Every decision of a delegable type
   writes `approval.decide` through `auditApproval`.

Queue routes list `approvalQueueTenantIds(req, type)`: (companies in view ∩
member companies, when the role list admits the caller) ∪ the companies a
live hand-over covers, whatever the view.

## Hand-over (delegation)

The CEO hands a SECTION of a head office's companies (one company, or
head-office-wide = the head office and every company LIVE-linked to it at the
moment of use) to an active, non-admin member of that head office who holds
the module. Routes (`delegationRoutes.ts`, CEO only unless noted):

- `POST /approvals/delegations` `{headOfficeId, companyTenantId?, section,
  approvalTypes?, delegateUserId, endsAt?, note}` — checks in order: 404 (not
  a head office, or the CEO is not a member), 422 `COMPANY_NOT_LINKED`, 422
  `SECTION_NOT_DELEGABLE` / `SECTION_NOT_YET_DELEGABLE`, 422
  `TYPE_NOT_IN_SECTION`, 422 `DELEGATE_NOT_ELIGIBLE`, 422
  `DELEGATE_LACKS_MODULE`, 422 `ENDS_AT_IN_PAST`, then — for company-owned
  types — one head office per (company, section) under
  `pg_advisory_xact_lock(hashtext('delegation:'||section))`: 409
  `SECTION_HANDED_TO_OTHER_HEAD_OFFICE`. "All types" of a section with a
  locked type stores the switched-on types explicitly, so flipping a constant
  never widens an old grant.
- `POST /approvals/delegations/:id/revoke {reason}` — a second revoke → 409.
- `GET /approvals/delegations` (any login: the CEO sees every hand-over of
  their head offices; others their own), `GET /approvals/delegations/eligible?
  headOfficeId&section`, `GET /approvals/catalog` (any login).

Rows are never edited or deleted (revoke + grant again). Every use is checked
live: not revoked, inside its window, the delegate active, still a member of
the head office, still holding the module, the link live. Ending a link
revokes that company's hand-overs in the same transaction
(`revokeDelegationsForUnlinkTx`, A12); `hoWideDelegationsOf(hoId)` lists the
head-office-wide ones a new link would extend. Audit:
`approval.delegation.grant|revoke` (identity trail).

**Inbox:** the CEO's items covered by a live hand-over (whose delegate did not
submit them) carry `handedOverTo` and are collapsed per section
(`handedOverItems`, `sections[].handedOver`, `handedOver`) — never in `total`;
`?view=all` lists them inline. A delegate sees the covered companies' items
whatever the view — only those one of their own live delegations covers by
`delegationCovers` (section never `ceo`, ownership, A13; read through
`ApprovalDelegations.asDelegate`, fail-closed when absent), checked AFTER the
through-head-office block so role items moved onto a hand-over are checked
too — never their own submissions, never a company-less row. Company role approvers no
longer see items that came through a head office. `GET /approvals?type&
section&view`. With no head office and no hand-over, the inbox is exactly as
before. `delegations.ts` is the seam: `LIVE_DELEGATIONS` (the default) reads
the table through `lib/approvalRights.ts`; `NO_DELEGATIONS` stays the test
default.

## Registration

`registerApprovalsPlugin(api)` from the `/api/v1` scope in `src/index.ts`
(→ `/api/v1/approvals`, `/api/v1/approvals/counts`). The internal reads go to
the same `/api/v1` base (derived from the plugin's prefix, or `apiBase`).
They carry no forwarding headers, so they are internal requests and never
spend the user's rate-limit allowance.
