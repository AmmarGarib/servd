# Head office (D1) and HOD approvals with hand-over (D3): final build spec

**Status.** This spec judges and merges two earlier designs. It was checked against main e813299. It is complete on its own, so engineers can build from it alone.

**Prerequisites. Build only after these two have merged:**
- Wave 2, bigint-money (`20261012140000_money_bigint`): it owns accounting, procurement, reconciliation and reports today.
- D4 editor stage 1: it owns `backend/src/modules/siteLayouts/**` and `frontend/admin/src/components/storefront/**`.

**Rules that apply throughout.** CLAUDE.md applies in full:
- company separation from the first commit;
- `postJournalEntry` always needs a `tenantId`;
- the approvals inbox is read-only, and every action calls the module's own route;
- no `as never` or `as unknown` cast on a database write.

---

## 0. Answers to the required questions

| Question | Answer (the CA and owner confirm the items marked ✱) |
|---|---|
| What is recharged each month? ✱ | **What it is:** the head office's (HO's) actual net cost for the calendar month in Pakistan time (PKT), read from the HO's own ledger. It is debits minus credits on expense-type accounts inside the HO's cost pool.<br>**Default pool:** codes 5000–6999. This covers salaries and employer EOBI/SESSI (from the HO payroll accrual), rent, utilities, software, fees and depreciation.<br>**Excluded by default:** 7xxx contra-revenue; 8xxx variances, FX and disposals; the HO's own recharge account 6990.<br>**Always excluded:** every line of a journal entry whose reference starts with `ho.recharge`, i.e. the recharge itself.<br>**Basis:** charged at cost, with no markup and no tax lines in v1.<br>**Why not payroll only:** it would leave rent and software stranded in an entity that has no revenue.<br>**Why not budget:** a budget is an estimate and would need true-ups anyway.<br>**Editable:** the CA edits the pool (ranges, codes to add, codes to exclude). |
| How must the % table add up? ✱ | **Rules:** each share is 1–10000 basis points (bps), and the total per version must be ≤ 10000. Anything below 100% is retained by the HO as its own cost; the screen says "x% stays with the head office". Recommended: exactly 100%.<br>**Versions:** each % table has an effective month. A version cannot be changed once a submitted or posted run uses it.<br>**Rounding:** each company gets floor(abs(base) × bps / 10000). When the total is 100%, the leftover paisa go to the largest share (ties go to the lowest company id), so the HO nets to exactly zero. When it is below 100%, the leftover stays with the HO. |
| How does an HO get its chart? ✱ | **Standard chart:** `ensureChartOfAccounts` runs when the HO is created and again at every boot, the same as for companies.<br>**Extra accounts:** the HO module creates the following and marks each "Confirm with your CA":<br>• in the HO's books, "Head office costs recharged to companies", 6990 (expense; it carries credits, so it reduces cost). The CA may choose a revenue account instead.<br>• for each linked company, in the HO's books: "Due from <company>" (asset, first free code in 1400–1449, **controlled**).<br>• in the company's books: "Due to <head office>" (liability, first free code in 2100–2149, **controlled**) and "Head office charges — <head office>" (expense, first free code in 6200–6249).<br>**Switch:** posting stays OFF until the CEO confirms the accounts with the CA. |
| A company under two HOs: two due-to balances? | **Accounts:** the company has two links, so it gets two controlled "Due to <HO>" accounts, plus by default two "Head office charges — <HO>" accounts.<br>**Recharge:** each HO recharges only its own pool, using its own % table.<br>**Reporting:** the balance sheet shows two separate due-to lines. Reconciliation and settlement are per pair.<br>**Close:** the company cannot close a month until both HOs have recharged it. |
| What can HODs SEE versus SUBMIT? | **Who:** members of an HO tenant **reach** every company that has a live link to their HO.<br>**See:** anything their role and Module Access allow, either for one reached company (the "lens") or for all of them ("All companies").<br>**Submit:** only through allow-listed **propose** routes. Each of these creates the module's own pending item.<br>**Anything else:** any other write that names a reached company returns 403 `HEAD_OFFICE_SUBMIT_ONLY`. Making direct changes needs explicit membership of that company, which is the CEO's decision. |
| How does "submit for approval" work without a second engine? | **Existing modules:** each approval type uses its module's own pending state and its own approve route (§8.3).<br>**New pending records:** only where a module has none: `JournalRequest` (accounting) and `PosConnectorChange` (connectors). The head-office module's `RechargeRun` and `IntercompanyTransfer` are native to it.<br>**Delegation:** an input to each approve route's guard (`assertCanApprove`), not a queue. The inbox stays read-only. |
| How do HODs reach companies without becoming members (tenantScope)? | Reach is worked out on every request from `HeadOfficeLink` combined with the caller's HO memberships.<br>**Where it is held:** `req.staffUser.reachTenantIds`. It is never added to `memberTenantIds` and never copied into `TenantMember`.<br>**Effect on scopes:** `read` includes reach. `write` and `create` include a reached company only on an allow-listed submit route that names it (`submitTenantId`).<br>**Ending reach:** unlinking a company removes reach on the very next request. |
| Where does HOD payroll live? | HODs are `HrEmployee`s of the HO tenant, and the HO runs its own `HrPayrollRun`.<br>**Posting:** `postPayrollAccrual` posts to the HO's books, unchanged. The pool picks this up and the recharge carries it to the companies.<br>**Guard:** nobody except the CEO approves a payroll that contains their own payslip. |
| Migration and removal of the old pieces | **Migration:** additive, with no data backfill.<br>**Setup wizard (CEO, preview then apply):**<br>• creates the HO from today's records;<br>• links the companies and sets split v1 to 37.5/62.5;<br>• moves the HO departments and seats;<br>• ends the `TenantContribution(head_office)` rows.<br>**Old pieces:**<br>• a head_office contribution stops counting in planning as soon as either side is linked to an HO, so there is no gap;<br>• `isHeadOffice` and the cost-share inputs are retired from the API and UI;<br>• the old tables and columns are kept.<br>**People:** staff move at the CA's cutover month, using the transfer tool. |

---

## 1. Duplicates found (standing rule): flagged, with what we do

| Existing piece | Overlap | Decision |
|---|---|---|
| `TenantContribution` category `head_office` (`positions/contributions.ts`, `lib/labour-budget.ts`, `projections/labour.ts`, `opex/routes.ts`, tenants merge) | Planning-only "JV pays 500k for HO salaries" | **Replaced** (owner D1). Everything it fed moves first (§9), then it is retired. The table is kept. |
| `Department.isHeadOffice` | An HO badge inside one company | **Replaced** by `Tenant.kind`. The column is kept and never read again. |
| `Position.tenantCostShareCents` and `costShareNote` | A share of a shared seat | **Retired.** Shared seats live in the HO at 100%, and the split is the % table. The columns are kept. |
| Cost allocation engine (`modules/allocations`) | "Split a cost by a fixed %" | **Keep both; they do different jobs.** The allocation engine moves cost between brands inside one company's books and refuses to cross companies. A recharge moves cost between two sets of books, with due-to/due-from balances that must reconcile. A company may spread its "Head office charges — <HO>" account over its brands with an ordinary allocation rule. No allocation code changes. The map recommended extending the engine; that is rejected for the reasons above. |
| `lib/labour-budget.ts budgetedLabour` and `projections/labour.ts monthlyLabourCents` | Both call themselves "the labour rule", and both read contributions | Both now call **one** new helper for the HO part (§9). Merging the two functions is an owner question; the recommendation is yes. |
| Brand P&L "Head office (unallocated)" (`accounting/reports.ts HEAD_OFFICE_LABEL`) | The name collides with real head offices | Rename it to **"Company overhead (unallocated)"**. The logic is unchanged. |
| `FleetAgreement` | A crossing between companies | Kept. It is an operational permission. Its future rider-cost split can use `IntercompanyTransfer` later. |
| Approvals inbox (`modules/approvals`) | — | **Extended** with sections and delegation routing. Items stay in their modules. |
| `POST /accounting/journal` | The manual posting path | **Extracted** into `accounting/manualJournal.ts`. Journal requests post through the same function. |
| `POST /accounting/period-close` | The close path | Gains one hook (`assertCloseReady`). There is no second close path. |
| `POST /tenants` open to `ALL_STAFF` | Companies are CEO-only (D1/D2) | Make it ADMIN_ONLY and always `kind = company`. |

---

## 2. Data model and migration

### 2.1 Prisma, exact

```prisma
// What a Tenant row is (owner decision D1, 2026-10-11).
enum TenantKind {
  company      // a trading company: brands, orders, the till
  head_office  // shared-services unit with its own HR, payroll and books; serves companies via
               // HeadOfficeLink and recharges them monthly. Never has brands.
}

model Tenant {
  // … existing fields unchanged …
  kind                  TenantKind             @default(company)
  headOfficeLinks       HeadOfficeLink[]       @relation("HoLinkHeadOffice")
  servedByLinks         HeadOfficeLink[]       @relation("HoLinkCompany")
  headOfficeBooks       HeadOfficeBooks?
  rechargeSplits        RechargeSplit[]
  splitLines            RechargeSplitLine[]    @relation("SplitLineCompany")
  rechargeRuns          RechargeRun[]
  rechargeRunLines      RechargeRunLine[]      @relation("RunLineCompany")
  icTransfersAsHo       IntercompanyTransfer[] @relation("IcTransferHeadOffice")
  icTransfersAsCompany  IntercompanyTransfer[] @relation("IcTransferCompany")
  delegationsAsHo       ApprovalDelegation[]   @relation("DelegationHeadOffice")
  delegationsForCompany ApprovalDelegation[]   @relation("DelegationCompany")
  journalRequests       JournalRequest[]       @relation("TenantJournalRequests")
  posConnectorChanges   PosConnectorChange[]   @relation("TenantPosConnectorChanges")
  @@index([kind])
}

model Account {
  // … existing …
  // 'head_office' = an intercompany due-to/due-from account owned by ONE HeadOfficeLink.
  // Only postings whose sourceType starts with 'ho.' may touch it (accounting/journal.ts).
  controlledBy        String?
  linkDueFrom         HeadOfficeLink?        @relation("LinkDueFrom")
  linkDueTo           HeadOfficeLink?        @relation("LinkDueTo")
  linkCharges         HeadOfficeLink[]       @relation("LinkCharges")
  rechargeAccountFor  HeadOfficeBooks[]      @relation("HoRechargeAccount")
  icHoCounterFor      IntercompanyTransfer[] @relation("IcHoCounter")
  icCompanyCounterFor IntercompanyTransfer[] @relation("IcCompanyCounter")
}

// One row per (head office, company). CEO-only. Re-linking clears endedAt on the same row.
model HeadOfficeLink {
  id                String    @id @default(uuid())
  tenantId          String    // the head office (kind head_office); owner of the row
  companyTenantId   String    // the served company (kind company)
  dueFromAccountId  String?   @unique // HO chart: "Due from <company>" (asset, controlled)
  dueToAccountId    String?   @unique // company chart: "Due to <head office>" (liability, controlled)
  chargesAccountId  String?           // company chart: "Head office charges — <HO>" (expense; may be shared by a company's links)
  startedAt         DateTime  @default(now())
  endedAt           DateTime? // reach and delegation cover stop at once; balances and history stay
  lastChargedPeriod String?   // 'YYYY-MM', set when ended
  createdById       String
  endedById         String?
  endReason         String?
  createdAt         DateTime  @default(now())
  updatedAt         DateTime  @updatedAt
  headOffice Tenant   @relation("HoLinkHeadOffice", fields: [tenantId], references: [id], onDelete: Restrict)
  company    Tenant   @relation("HoLinkCompany", fields: [companyTenantId], references: [id], onDelete: Restrict)
  dueFrom    Account? @relation("LinkDueFrom", fields: [dueFromAccountId], references: [id], onDelete: Restrict)
  dueTo      Account? @relation("LinkDueTo", fields: [dueToAccountId], references: [id], onDelete: Restrict)
  charges    Account? @relation("LinkCharges", fields: [chargesAccountId], references: [id], onDelete: Restrict)
  @@unique([tenantId, companyTenantId])
  @@index([tenantId, endedAt])
  @@index([companyTenantId, endedAt])
  @@map("head_office_links")
}

// One per head office: its recharge account, cost pool, CA confirmation and switch.
model HeadOfficeBooks {
  tenantId              String    @id // the head office
  rechargeAccountId     String?   // HO chart; default 6990 (expense, credits); CA may pick a revenue account
  costPool              Json      @default("{\"include\":[{\"from\":5000,\"to\":6999}],\"includeCodes\":[],\"excludeCodes\":[\"6990\"]}")
  accountsConfirmedAt   DateTime? // NULL = "Confirm with your CA". Cleared by ANY change to accounts, pool or links
  accountsConfirmedById String?
  accountsConfirmedNote String?   // the CEO's note, incl. the CA's tax answer
  rechargeEnabled       Boolean   @default(false) // CHECK: only with accountsConfirmedAt + rechargeFromPeriod
  rechargeFromPeriod    String?   // 'YYYY-MM' = the CA's cutover month
  requireLockedPayroll  Boolean   @default(true)
  updatedById           String?
  createdAt             DateTime  @default(now())
  updatedAt             DateTime  @updatedAt
  tenant          Tenant   @relation(fields: [tenantId], references: [id], onDelete: Restrict)
  rechargeAccount Account? @relation("HoRechargeAccount", fields: [rechargeAccountId], references: [id], onDelete: Restrict)
  @@map("head_office_books")
}

// The CEO's % table, versioned by effective month.
model RechargeSplit {
  id            String   @id @default(uuid())
  tenantId      String   // head office
  effectiveFrom String   // 'YYYY-MM'; the version for month M = latest effectiveFrom <= M
  note          String?
  createdById   String
  createdAt     DateTime @default(now())
  tenant Tenant              @relation(fields: [tenantId], references: [id], onDelete: Restrict)
  lines  RechargeSplitLine[]
  runs   RechargeRun[]
  @@unique([tenantId, effectiveFrom])
  @@map("recharge_splits")
}

model RechargeSplitLine {
  id              String @id @default(uuid())
  splitId         String
  tenantId        String // head office (denormalised for scoping)
  companyTenantId String
  shareBps        Int    // 1..10000; sum per split <= 10000 (code)
  split   RechargeSplit @relation(fields: [splitId], references: [id], onDelete: Cascade)
  company Tenant        @relation("SplitLineCompany", fields: [companyTenantId], references: [id], onDelete: Restrict)
  @@unique([splitId, companyTenantId])
  @@index([companyTenantId])
  @@map("recharge_split_lines")
}

// The head-office module's own pending record for a month's recharge (or its true-up).
model RechargeRun {
  id                   String    @id @default(uuid())
  tenantId             String    // head office
  period               String    // 'YYYY-MM'
  kind                 String    @default("monthly") // monthly | true_up
  status               String    @default("draft")   // draft | submitted | posted | rejected | withdrawn | reversed
  splitId              String
  costPool             Json      // pool definition used (snapshot)
  basis                Json      // [{ accountId, code, name, netCents }]
  poolCents            BigInt    // HO net cost for the month at preparation
  priorCents           BigInt    // sum of baseCents of earlier POSTED, non-reversed runs for (tenant, period)
  baseCents            BigInt    // pool - prior: what this run splits
  rechargedCents       BigInt    // sum of lines
  retainedCents        BigInt    // base - sum of lines (stays with the HO)
  warnings             String[]  @default([])
  entryDate            DateTime?
  postedLate           Boolean   @default(false)
  preparedById         String?   // null = the worker
  preparedAt           DateTime  @default(now())
  submittedById        String?   // null = the worker
  submittedAt          DateTime?
  decidedById          String?
  decidedAt            DateTime?
  decisionNote         String?
  decidedVia           String?   // role | delegation
  delegationId         String?
  postedAt             DateTime?
  driftAtApprovalCents BigInt?   // (pool - prior) recomputed at approval minus baseCents
  reversedById         String?
  reversedAt           DateTime?
  reversalReason       String?
  createdAt            DateTime  @default(now())
  updatedAt            DateTime  @updatedAt
  tenant Tenant            @relation(fields: [tenantId], references: [id], onDelete: Restrict)
  split  RechargeSplit     @relation(fields: [splitId], references: [id], onDelete: Restrict)
  lines  RechargeRunLine[]
  @@index([tenantId, period, status])
  @@index([status, submittedAt])
  @@map("recharge_runs")
}

model RechargeRunLine {
  id              String  @id @default(uuid())
  runId           String
  tenantId        String  // head office
  companyTenantId String
  linkId          String
  shareBps        Int
  amountCents     BigInt  // signed: negative = credit to the company (true-up / negative month)
  hoEntryId       String? @unique
  companyEntryId  String? @unique
  run     RechargeRun @relation(fields: [runId], references: [id], onDelete: Restrict)
  company Tenant      @relation("RunLineCompany", fields: [companyTenantId], references: [id], onDelete: Restrict)
  @@unique([runId, companyTenantId])
  @@index([companyTenantId])
  @@map("recharge_run_lines")
}

// Settlements (money actually paid between the units) and paired adjustments
// (opening balances, a cost one side paid for the other). Both books, always together.
model IntercompanyTransfer {
  id                      String    @id @default(uuid())
  tenantId                String    // head office
  companyTenantId         String
  kind                    String    // settlement | adjustment
  effect                  String    // decrease | increase  (of what the company owes the HO)
  amountCents             BigInt    // > 0
  entryDate               DateTime
  hoCounterAccountId      String    // HO chart; active; NOT controlled (settlement: a bank/cash account)
  companyCounterAccountId String    // company chart; active; NOT controlled
  memo                    String
  reference               String?
  status                  String    @default("draft") // draft | submitted | posted | rejected | withdrawn | reversed
  preparedById            String
  preparedAt              DateTime  @default(now())
  submittedById           String?
  submittedAt             DateTime?
  decidedById             String?
  decidedAt               DateTime?
  decisionNote            String?
  decidedVia              String?
  delegationId            String?
  hoEntryId               String?   @unique
  companyEntryId          String?   @unique
  reversedById            String?
  reversedAt              DateTime?
  reversalReason          String?
  createdAt               DateTime  @default(now())
  updatedAt               DateTime  @updatedAt
  headOffice     Tenant  @relation("IcTransferHeadOffice", fields: [tenantId], references: [id], onDelete: Restrict)
  company        Tenant  @relation("IcTransferCompany", fields: [companyTenantId], references: [id], onDelete: Restrict)
  hoCounter      Account @relation("IcHoCounter", fields: [hoCounterAccountId], references: [id], onDelete: Restrict)
  companyCounter Account @relation("IcCompanyCounter", fields: [companyCounterAccountId], references: [id], onDelete: Restrict)
  @@index([tenantId, status])
  @@index([companyTenantId, status])
  @@map("intercompany_transfers")
}

// WHO may decide a section — never items, never decisions. Rows are never edited or deleted:
// change = revoke + new grant. Checked live on every use (nothing cached).
model ApprovalDelegation {
  id              String    @id @default(uuid())
  tenantId        String    // the head office the delegate belongs to
  companyTenantId String?   // null = the HO itself + every company LIVE-linked to it at the moment of use
  section         String    // operations | procurement | finance | marketing | hr | dev   (never ceo)
  approvalTypes   String[]  @default([]) // narrows to these delegable types of the section; [] = all
  delegateUserId  String    // plain id (users are soft-deleted; checked live)
  grantedById     String
  note            String?
  startsAt        DateTime  @default(now())
  endsAt          DateTime? // exclusive
  revokedAt       DateTime?
  revokedById     String?
  revokeReason    String?
  createdAt       DateTime  @default(now())
  headOffice Tenant  @relation("DelegationHeadOffice", fields: [tenantId], references: [id], onDelete: Restrict)
  company    Tenant? @relation("DelegationCompany", fields: [companyTenantId], references: [id], onDelete: Restrict)
  @@index([delegateUserId, revokedAt])
  @@index([tenantId, section, revokedAt])
  @@index([companyTenantId])
  @@map("approval_delegations")
}

// Accounting's own pending state for manual journals (finance prepares; CEO or a Finance delegate approves).
model JournalRequest {
  id             String    @id @default(uuid())
  tenantId       String    // the books it posts to
  kind           String    @default("post")  // post | reverse (reverse = CEO only)
  status         String    @default("draft") // draft | submitted | returned | posted | withdrawn
  description    String
  reference      String?
  entryDate      DateTime?
  lines          Json      @default("[]") // post: [{ accountId, type, amountCents, memo?, conceptId? }] (re-validated on approval)
  totalCents     BigInt    @default(0)
  reverseEntryId String?   // reverse: the manual entry to reverse
  reason         String?   // reverse: required
  preparedById   String
  preparedAt     DateTime  @default(now())
  submittedById  String?
  submittedAt    DateTime?
  decidedById    String?
  decidedAt      DateTime?
  decisionNote   String?
  decidedVia     String?
  delegationId   String?
  postedEntryId  String?   @unique
  createdAt      DateTime  @default(now())
  updatedAt      DateTime  @updatedAt
  tenant Tenant @relation("TenantJournalRequests", fields: [tenantId], references: [id], onDelete: Restrict)
  @@index([tenantId, status])
  @@index([preparedById])
  @@map("journal_requests")
}

// Connectors' own pending state for IT changes to a company's POS connector (Dev section).
model PosConnectorChange {
  id               String        @id @default(uuid())
  tenantId         String
  kind             ConnectorKind
  status           String        @default("submitted") // submitted | applied | rejected | withdrawn
  patch            Json          // the PUT /connectors/:kind body minus secrets
  apiKeyEnc        String?       // sealed with lib/secretBox; never returned
  webhookSecretEnc String?
  preparedById     String
  preparedAt       DateTime      @default(now())
  decidedById      String?
  decidedAt        DateTime?
  decisionNote     String?
  decidedVia       String?
  delegationId     String?
  createdAt        DateTime      @default(now())
  updatedAt        DateTime      @updatedAt
  tenant Tenant @relation("TenantPosConnectorChanges", fields: [tenantId], references: [id], onDelete: Restrict)
  @@index([tenantId, status])
  @@map("pos_connector_changes")
}
```

**Money columns** use BigInt, read through the same number mapping that Wave 2 adds for `journal_lines.amountCents` in `lib/prisma.ts`. If this build has to start before Wave 2 lands, declare them `Int`, keep `MAX_LINE_CENTS`, and add them to Wave 2's list.

**`TenantContribution.category`** defaults to `other`. It no longer defaults to `head_office`.

### 2.2 Migration `backend/prisma/migrations/20261013120000_head_office/migration.sql`

The name must sort after the newest migration at build time. The migration is additive: there is no backfill, and every statement is instant on real data.

**DDL:**
- `CREATE TYPE "TenantKind" AS ENUM ('company','head_office')`
- `ALTER TABLE "tenants" ADD COLUMN "kind" "TenantKind" NOT NULL DEFAULT 'company'`, plus an index on it.
- `ALTER TABLE "accounts" ADD COLUMN "controlledBy" TEXT`, with `CHECK ("controlledBy" IS NULL OR "controlledBy" = 'head_office')`.
- `ALTER TABLE "tenant_contributions" ALTER COLUMN "category" SET DEFAULT 'other'`.
- The nine tables come from the models above.

**CHECKs:**
- links: `"tenantId" <> "companyTenantId"`; `lastChargedPeriod ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'` or NULL.
- books: `NOT "rechargeEnabled" OR ("accountsConfirmedAt" IS NOT NULL AND "rechargeFromPeriod" IS NOT NULL)`; the period format.
- splits: the `effectiveFrom` format.
- split lines: `"shareBps" BETWEEN 1 AND 10000`.
- runs: the period format; `kind IN ('monthly','true_up')`; the status list.
- run lines: `"shareBps" BETWEEN 0 AND 10000`.
- transfers:
  - `kind IN ('settlement','adjustment')`
  - `effect IN ('decrease','increase')`
  - `"amountCents" > 0`
  - the status list.
- delegations: the section list; `"endsAt" IS NULL OR "endsAt" > "startsAt"`.
- journal_requests: `kind IN ('post','reverse')`; the status list; `kind <> 'reverse' OR "reverseEntryId" IS NOT NULL`.
- pos_connector_changes: the status list.

**Partial unique index:** `CREATE UNIQUE INDEX "recharge_runs_one_open" ON "recharge_runs"("tenantId","period") WHERE "status" IN ('draft','submitted')`.

**RLS:** follow the pattern of the tip-pools migration (`20261012120000`): `app_is_service_mode() OR "tenantId" = ANY(app_tenant_ids())` for USING and WITH CHECK.
- `head_office_links`, `recharge_run_lines` and `intercompany_transfers` also allow `OR "companyTenantId" = ANY(app_tenant_ids())`.
- `approval_delegations` also allows `OR "companyTenantId" = ANY(...)`.
- Reach and delegation lookups always run on `serviceClient`, the same way the auth middleware does.

**`tests/setup.ts`:** `db push` cannot express the CHECKs or the partial unique index, so apply them after `db push`, the same way it already does for `terminal_charges_one_active_per_order`. Note: the test database has no RLS policies at all (§7.5).

**The "total ≤ 100%" rule** is checked in code when a version is created. Each version is written whole, so there is no race between versions.

---

## 3. Chart of accounts and controlled accounts

**`lib/chartOfAccounts.ts`:** document the reserved ranges in the header:
- 1400–1449: due-from, HO books
- 2100–2149: due-to, company books
- 6200–6249: HO charges, company books
- 6990–6999: HO costs recharged, HO books

`ensureChartOfAccounts` is unchanged and never creates these. They are not in `REQUIRED_ACCOUNT_CODES`.

**`modules/headOffices/accounts.ts`:**
- `nextFreeCode(tx, tenantId, from, to)` returns the first code in the range that is absent from that tenant's chart, whether active or not. If none is free → 422 `ACCOUNT_RANGE_FULL`.
- `createRechargeAccount(tx, hoId)` creates 6990 (or the next free code up to 6999) "Head office costs recharged to companies" (expense). Description: "Head office: credits only — its costs recovered from the companies it serves. Confirm name and code with your CA."
- `createLinkAccounts(tx, link)` creates "Due from <company>" in the HO chart and "Due to <HO>" in the company chart. Both get `controlledBy='head_office'` and the description "Intercompany — head office link <HO> → <company>. Confirm with your CA." It also creates "Head office charges — <HO>" (expense) in the company chart.
- `validateMapping` runs when the CEO re-maps an account (`PUT /head-offices/:id/books/accounts`):
  - **Right chart and type:**
    - due-from must be an active asset in the HO chart;
    - due-to must be an active liability in the company chart;
    - charges must be an active expense in the company chart;
    - the recharge account must be an active expense in the HO chart, or a revenue account, which is allowed with the warning "the All-companies P&L will show this as both income and cost until eliminations are built". It must not be controlled.
  - **Not an engine code:** none of the four may be a posting-engine code (any `ACCT.*` value or anything in `REQUIRED_ACCOUNT_CODES`). If one is → 422 `ACCOUNT_RESERVED`.
  - **Due-account history:** a due account must have no journal lines → 422 `ACCOUNT_HAS_HISTORY`. It must not be controlled by another link → 409 `ACCOUNT_IN_USE`. Once a link has any `ho.` posting, its due accounts are locked → 409 `IC_ACCOUNT_LOCKED`.
  - **Changing the mapping:** mapping sets `controlledBy` on the new account. It clears `controlledBy` on the replaced account, which by the rules above has no lines.
  - **Effect on recharge:** any accepted change clears `accountsConfirmedAt` and sets `rechargeEnabled=false` in the same update.

**The single choke point, in `accounting/journal.ts`:**
- `resolveAccountIds` also selects `controlledBy`.
- `postJournalEntry` refuses with 422 `INTERCOMPANY_ACCOUNT_CONTROLLED` when any line's account has `controlledBy` and `!input.sourceType.startsWith('ho.')`.

So manual journals, journal requests, bills, payroll, allocations, bank-reconciliation adjustments and backfills can never touch a due account, and the two books can only move together. Reversals of `ho.*` entries use sourceType `ho.<x>.reversal`, which passes.

**`setup/routes.ts` PATCH `/setup/chart-of-accounts/:id`:** refuses `isActive:false` on a controlled account with 422 `ACCOUNT_CONTROLLED`. Renaming is still allowed; this is how the CA's names are applied.

---

## 4. Recharge accounting (`backend/src/modules/headOffices/`)

### 4.1 Pool, in `pool.ts`

`computePool(tx, hoId, period)`:
- **Window:** `periodBounds(period)` from `parsePktStartOfDay(YYYY-MM-01)` to `parsePktEndOfDay(last day)`. Use `accounting/dates.ts`.
- **Lines:** journal lines where the entry's `tenantId = hoId`, its `entryDate` is in the window, and its reference does **not** match `LIKE 'ho.recharge%'`.
- **Accounts:** account type `expense`, and either
  - its code is numeric and falls inside an `include` range, or
  - its code is in `includeCodes`,
  
  and its code is not in `excludeCodes`.
- **Result:** the pool is the sum of (debit − credit). `basis` holds `[{accountId, code, name, netCents}]`.

Notes:
- The HO payroll accrual (posted at lock, dated the last day of the month at 00:00 UTC) falls inside the window.
- A paired adjustment that credits an HO expense, for example a cost the HO paid wholly for one company, correctly reduces the pool.
- `costPool` is validated with zod: ranges inside 1000–9999 with from ≤ to; codes are strings.

### 4.2 Split, in `splits.ts`

- `splitFor(hoId, period)` returns the latest version with `effectiveFrom ≤ period`. If there is none → 422 `NO_SPLIT`.
- **Creating a version:** `POST /head-offices/:id/splits {effectiveFrom, lines[], note}`.
  - Every line's company must have a **live** link to this HO → 422 `COMPANY_NOT_LINKED`.
  - shareBps must be 1..10000, and the total ≤ 10000 → 422 `SPLIT_OVER_100`.
  - It is refused when any run with status `submitted` or `posted` exists for a period ≥ effectiveFrom → 409 `SPLIT_PERIOD_IN_USE` ("withdraw or reverse those runs first").
  - Draft runs for those periods are marked stale and must be refreshed.
- **Removing a version:** `DELETE /head-offices/:id/splits/:splitId` is allowed only while no run references it.
- **`splitByBps(base, lines)`** is a pure function. Each line gets floor(abs(base) × bps / 10000).
  - If the total bps = 10000, the residue goes to the largest bps (ties go to the lowest companyTenantId).
  - Otherwise the residue is retained.
  - The sign is re-applied at the end.
  - Lines of 0 are dropped.
- **True-ups** use the `splitId` of the month's first posted run.

### 4.3 Run lifecycle, in `runs.ts` (routes under `/intercompany`)

| Step | Who | What |
|---|---|---|
| **prepare** `POST /intercompany/runs {headOfficeId, period}` | `IC_PREPARERS` (admin, owner, management, finance) who are members of the HO, or the CEO; the worker as system | **Preconditions:** the month must be over in PKT (else 422 `PERIOD_NOT_OVER`), and a split must exist.<br>**Lock and compute:** take `pg_advisory_xact_lock(hashtext('ho.recharge'), hashtext(hoId||':'||period))`. Compute pool, prior (the total `baseCents` of posted, non-reversed runs for that HO and month), base = pool − prior, and the lines.<br>**Kind:** `monthly` when no posted, non-reversed run exists for the month; otherwise `true_up`.<br>**Refusals:** base = 0 → 409 `NOTHING_TO_RECHARGE`. An open run already exists → 409 `RUN_OPEN` (the partial unique index is the backstop).<br>**Warnings stored on the run:**<br>• HO payroll for the month is not locked (only when `requireLockedPayroll` is off);<br>• HO journal requests dated in the month are still undecided;<br>• the HO's month is already locked;<br>• a company is closed through the month;<br>• the recharge account is revenue-type;<br>• base is negative;<br>• the split totals less than 100%.<br>`GET /intercompany/preview` does the same calculation without saving a row. |
| **refresh** (draft only) | preparers | Recompute. |
| **submit** | the preparer, any HO preparer, or the worker | **Needs all of:**<br>• books confirmed (409 `ACCOUNTS_NOT_CONFIRMED`);<br>• recharge enabled (409 `RECHARGE_OFF`);<br>• period ≥ `rechargeFromPeriod` (422 `BEFORE_CUTOVER`);<br>• every line's link mapped, with accounts active and of the right type;<br>• when `requireLockedPayroll` is on and the HO had `payableEmployees` in the month, its `HrPayrollRun` for the month locked (409 `PAYROLL_NOT_LOCKED`).<br>Recomputes before saving. The run then lands in the **Finance** section of the inbox. |
| **approve** `POST /intercompany/runs/:id/approve {postInOpenPeriod?, acknowledgeWarnings?}` | the CEO, or a Finance delegate with an **HO-wide** delegation for this HO (§8). Never the preparer or submitter (the CEO is exempt). | **Before posting:** `assertCanApprove(ho_recharge)`, then re-check the submit conditions inside the transaction. Warnings exist without `acknowledgeWarnings` → 422 `WARNINGS_NOT_ACKNOWLEDGED`.<br>**One transaction (`{timeout: 30_000}`):**<br>1. Take the advisory lock above.<br>2. Claim the run with `updateMany where status='submitted'`. Zero rows → 409 `RUN_NOT_PENDING`.<br>3. Post the stored lines (§4.4).<br>4. Store the entry ids.<br>5. Write `driftAtApprovalCents` = (pool − prior, recomputed) − baseCents.<br>6. Set status `posted`.<br>**After commit:** if drift ≠ 0, the response says "a true-up of X will follow" and the worker prepares it. |
| **reject** `{note}` (required) | the same rights as approve | Status `rejected`. A new run can be prepared by a person. |
| **withdraw** | the preparer or any HO preparer | Status `withdrawn`. |
| **reverse** `{reason, postInOpenPeriod?}` | **CEO only** | In one transaction, call `reverseJournalEntry` for both books of every line (`ho.recharge.reversal:<lineId>`). The date is the original date if every book is open, otherwise the common open date. Status `reversed`. The month can then be run again, because prior excludes reversed runs. |

### 4.4 Postings (both books, one transaction, all or nothing)

For each run line with amount A > 0, both entries use reference `ho.recharge:<lineId>`, `sourceType 'ho.recharge'`, `postedBy` = the approver and the same entryDate. Brand is untagged (`conceptId null`).
- **HO book:** Dr "Due from C" A / Cr recharge account A.
- **Company C:** Dr "Head office charges — H" A / Cr "Due to H" A.
- **A < 0:** every side flips.

Every call uses `postJournalEntry(…, {tx})`. Each must return `posted: true`; otherwise throw `ALREADY_POSTED` as a defence against double posting. Any refusal rolls back the whole run, so one book never moves without the other. Refusals include `PERIOD_LOCKED`, `ACCOUNT_NOT_FOUND`, an inactive account, `INTERCOMPANY_ACCOUNT_CONTROLLED` and an amount over the line ceiling while journal lines are still Int.

Descriptions read `Head office charge 2026-11 — GS Head Office (62.50%)`, or `… true-up` / `… (posted late)`.

### 4.5 Period locks and dates (`periods.ts`)

- **Default entryDate:** the last day of the month at 23:59:00 PKT, so it sorts after the month's other entries.
- **Locked books:** if any book involved (the HO plus every company with a line) has `lockedThrough` ≥ that date, the call fails with 409 `PERIOD_LOCKED_IN {books:[name, lockedThrough]}`.
- **`postInOpenPeriod: true`:** all entries move to the common open date, which is `parsePktStartOfDay(the day after the latest lockedThrough among those books)`. This sets `postedLate`, and the description says "for <Month YYYY> (posted late)".
- **Settlements and adjustments** follow the same rules for their given entryDate.

### 4.6 Settlements and paired adjustments (`transfers.ts`, routes under `/intercompany/transfers`)

**Postings**, with reference `ho.transfer:<id>` in both books:

| Effect | HO book | Company book |
|---|---|---|
| `decrease` (company owes the HO less) | Dr hoCounter / Cr "Due from C" | Dr "Due to H" / Cr companyCounter |
| `increase` (company owes the HO more) | Dr "Due from C" / Cr hoCounter | Dr companyCounter / Cr "Due to H" |

Examples:
- A settlement is `decrease` with a bank account as the counter on both sides.
- The company paying the HO's rent on its behalf is `decrease` with hoCounter 6010 Rent and companyCounter bank. The rent then enters the HO pool and is recharged by the %.
- The HO paying a cost that belongs wholly to C is `increase` with hoCounter bank and companyCounter the expense account.
- Opening balances use counters the CA picks.

**Rules:**
- **Counter accounts:** active, in the correct chart, never controlled → 422 `COUNTER_ACCOUNT_INVALID`.
- **Pair:** the company must have a link to this HO, live or ended.
- **Preparers:** `IC_PREPARERS` who are members of **either** side.
- **Approve:** the CEO, or a Finance delegate covering the company. Never the preparer. Posting happens in one transaction.
- **Reverse:** CEO only (`ho.transfer.reversal:<id>`).

### 4.7 Close checks (`closeChecks.ts`, called by `POST /accounting/period-close` before the lock row is written)

`assertCloseReady(tenantId, newLock, acknowledgeRecharge?)` runs for every PKT month M whose last day falls in (previous lock, new lock]. Define:
- `ready(H, M)`, which is all of:
  - if `requireLockedPayroll` is on and H had payable employees in M, then H's payroll for M is locked;
  - no open run for (H, M);
  - `drift(H,M) = pool(H,M) − Σbase(posted non-reversed runs) = 0`.

The checks:
- **Head office:** if the tenant is an HO with recharge enabled and M ≥ `rechargeFromPeriod`, then `ready(tenant, M)` must hold.
- **Company:** for each link (live or ended) whose HO has recharge enabled, where M ≥ the HO's `rechargeFromPeriod` and the split for M gives this company a share > 0, `ready(HO, M)` must hold. This works for a month whose pool is zero, and it stops a company closing before the HO has accrued its payroll.

**On failure:** 409 `RECHARGE_NOT_READY {problems:[{headOffice, period, reason, driftCents}]}`.

**Override:** `acknowledgeRecharge: {reason}` (at least 10 characters). It is audited as `period.close.recharge_override` and raises a high exception `recharge_close_override` in that tenant.

Closing and reopening a period stay CEO-only.

### 4.8 Reconciliation and visibility (`reconciliation.ts`)

**Invariants**, tested and checked daily:
1. For each pair and each date, the debit balance of "Due from C" equals the credit balance of "Due to H".
2. The recharge lines on both sides agree per run line.
3. Every line on a controlled account belongs to an entry referenced `ho.*`.
4. Per run, the total of the lines plus retained equals base.

**Endpoints:**
- `GET /intercompany/reconciliation?asOf&headOfficeId&companyId` returns, per pair:
  - both balances and the difference, which must be 0;
  - movements grouped by reference prefix (`ho.recharge`, `ho.transfer` and their reversals);
  - stray lines, which should be none.
  
  CSV export.
- `GET /intercompany/statement?headOfficeId&companyId&from&to` shows opening, charges, settlements, adjustments and closing.

**Who sees what (a deliberate, tested crossing, like FleetAgreement):**
- HO members holding `accounting` see every pair of their HO.
- Company members holding `accounting` see their own company's pairs: both balances, their run lines, and the run `basis` (per-account totals) that their charge came from.
- Nothing else of the other side's books is visible.

**v1 has no elimination in the "All companies" reports.** With the default contra-expense presentation the portfolio P&L is already correct: HO cost − recovery + the companies' charges = the real cost, and revenue is untouched. Due-to and due-from show grossed up in a portfolio balance sheet. Eliminations come in a later phase if the CA picks revenue presentation or wants a consolidated balance sheet.

### 4.9 Worker, in `backend/src/workers/headOfficeRecharge.ts`

Exports `startHeadOfficeRechargeWorker()` (hourly `setInterval`, `unref`, first tick after 60 s; started only under `ENABLE_WORKERS`) and `runHeadOfficeRechargeTick(now)`. It uses `serviceClient`.

It loops **per head office** (`kind head_office`, active, not deleted, recharge enabled), with each HO in its own try/catch. For each M from the later of `rechargeFromPeriod` and 12 months ago, up to the previous month:
- **No run rows at all for M, and `ready` minus the drift condition holds:** prepare and submit as system.
- **Latest run is posted, drift ≠ 0, and no open run:** prepare and submit a true-up.
- **Latest run was rejected or withdrawn:** do nothing; a person decides.
- **Not ready on day ≥ 5 of M+1 (PKT):** raise `recharge_missing` in the HO tenant once. It resolves when M is ready.

Once a day (the first tick after 06:00 PKT) it raises or resolves:
- `recharge_drift`
- `intercompany_mismatch` (critical; any pair whose balances differ)

The worker **never posts**. The new kinds are added to the `ExceptionKind` union in `lib/exceptions.ts`; it is a String column, so no migration is needed. `/health` gains `headOffice: off | ok | warn`. It warns on an open `intercompany_mismatch`, or when a recharge-ON HO has its last month not ready after day 10.

### 4.10 Tax (must be answered before switching recharge on)

v1 posts the recharge at cost, with no sales-tax or withholding lines. The confirm dialog requires the CEO to record the CA's answer, for example: "No tax on the recharge — CA confirmed <name, date>".

If the CA says it is a taxable service, the following must be built **before** posting is switched on:
- tax lines;
- a recharge invoice;
- the company-side input-tax account.

### 4.11 Worked example (Sept 2026, GS Head Office)

- **Pool:** PKR 1,000,000, made up of 6032 wages 800,000 + 6010 rent 150,000 + 6070 software 50,000.
- **Split:** GS Foods 37.5% / GSX Viva 62.5%.
- **Date:** every entry is dated 30 Sep 23:59 PKT.

Postings:
- **HO book:**
  - Dr "Due from GS Foods" 375,000 / Cr 6990 375,000 `[ho.recharge:L1]`
  - Dr "Due from GSX Viva" 625,000 / Cr 6990 625,000 `[ho.recharge:L2]`
- **GS Foods:** Dr "HO charges — GS Head Office" 375,000 / Cr "Due to GS Head Office" 375,000 `[ho.recharge:L1]`
- **GSX Viva:** the same entry for 625,000 `[ho.recharge:L2]`

Result: the HO's September P&L nets to 0 and each pair reconciles to 0.

---

## 5. Head-office HR, payroll and moving staff

- **HO HR basics at creation:** default HR settings, employee-code prefix `HO-`, and departments copied by the setup wizard (Procurement, Finance, Marketing) or created by HR. Payroll is unchanged:
  - `HrPayrollRun(tenantId = HO)` posts through `hr/ledger.ts postPayrollAccrual` into the HO's books;
  - `wageAccountFor` maps HO department names to 6032;
  - the run is paid from the HO's bank, or the HO is first funded by a settlement.
- **New guard, OWN_PAYSLIP:** on `POST /hr/payroll/runs/:id/approve`, `/lock` and `/reopen`, a non-admin whose login is linked to an employee with a payslip on the run → 403 `OWN_PAY_IN_RUN`. Consequence: the HO's own payroll always goes to the CEO.
- **Transfer tool (Stream C):** `hr/transfer.ts` with `previewTransfer(input)` and `transferEmployeesToHeadOffice({employeeIds, headOfficeTenantId, effectiveDate /* 1st of a month */, keepJoiningDate=true, keepCompanyMemberships=[]})`. Exposed as ADMIN_ONLY `POST /hr/head-office-transfers/preview` and `POST /hr/head-office-transfers`.
  - **Refuses when:**
    - the employee is not active in a company linked to that HO → 422 `NOT_IN_LINKED_COMPANY`;
    - a loan is outstanding → 409 `TRANSFER_LOAN_OUTSTANDING`;
    - HR records are still submitted → 409 `TRANSFER_OPEN_RECORDS`;
    - an approved or locked payroll of the old company for a month ≥ the effective month contains them → 409 `TRANSFER_PAYROLL_CONFLICT`.
    
    A draft payroll is only warned about, because recalculating it drops them.
  - **In one transaction:**
    1. Create a new `HrEmployee` in the HO. Copy the master data; match departments, designations and grades by name or create them; map the manager if the manager has already moved; keep the joining date (continuity); store `data.transferredFrom`.
    2. Carry the leave balances as approved system `leave_adjustment` records. Copy the company's leave types first if the HO has none.
    3. Set the old record to status **`transferred`** with `lastWorkingDay` = the day before the effective date. This status is not in `LEFT_STATUSES`, so no login is deactivated, and attrition reports exclude it. The old company pays through the month before.
    4. Login: upsert `TenantMember(HO)`. Set `User.tenantId` = HO if it pointed at the old company. Remove the company memberships except those the CEO ticked to keep.
    5. Move the Position that user fills to the HO: department twin, `conceptId null`, share = gross.
    6. Audit in both companies' identity trails.
- **Cross-company reporting line** (outlet staff reporting to an HO HOD) is out of scope. It is an owner question. `/hr/team` and the `hod` step stay within one company.

---

## 6. Access: head-office reach

### 6.1 Derivation (`lib/headOffice.ts`, Stream B)

`headOfficeReach(memberTenantIds)` runs one `serviceClient` query: `head_office_links` where `tenantId ∈ memberTenantIds`, `endedAt IS NULL`, the HO is active and not deleted, and the company is active and not deleted. It returns `Map<companyId, hoIds[]>`.
- It runs only when the user has memberships. It is not cached, so unlinking takes effect on the next request.
- Links only ever run from a `head_office` tenant to a `company` tenant (enforced in routes), so reach never chains and staff never reach another HO.

### 6.2 Middleware (`modules/auth/middleware.ts attachStaffPrincipal`)

```
memberTenantIds = TenantMember ∪ User.tenantId                        (unchanged)
reach           = headOfficeReach(memberTenantIds); reachTenantIds = keys(reach) \ memberTenantIds
header          = x-servd-active-tenant
route           = (req.method, req.routeOptions.url minus '/api/v1')
if header ∈ memberTenantIds:            effective = header                          (unchanged)
elif header ∈ reachTenantIds:
   GET/HEAD                           → effective = header; viaHeadOfficeIds = reach[header]   // the lens: read only
   route ∈ HO_SUBMIT_ROUTES           → effective = header; submitTenantId = header
   route ∈ HO_PASSTHROUGH             → header ignored (effective = User.tenantId)
   else                               → 403 HEAD_OFFICE_SUBMIT_ONLY "You are viewing <company> through <HO>: this change
                                         needs a member of <company> or the CEO. Use 'Send for approval' where the screen offers it."
elif header present and method not GET/HEAD → 403 COMPANY_HEADER_NOT_ALLOWED (was: silently ignored → write landed in the primary company)
else header ignored                                                                            (unchanged)
tenantFilter: GET portfolio → { in: member ∪ reach }; GET single → effective (was User.tenantId; differs only when a header is sent);
              non-GET → { in: member ∪ [submitTenantId] } (or the single id)
req.staffUser += { reachTenantIds, viaHeadOfficeIds?, submitTenantId? }
RLS tenantIds: GET portfolio → member ∪ reach; GET single → [effective]; non-GET → member ∪ [submitTenantId]
```

`enforceModuleAccess` is unchanged. It works per user, so reach never widens anyone's modules.

### 6.3 `lib/tenantScope.ts`

- `resolveTenantScope`: portfolio = `memberTenantIds ∪ reachTenantIds`, read from `req.staffUser` (stop re-querying TenantMember); single = `[effective]`.
- `scopeTenantWhere(req,'write')` = member ∪ [submitTenantId]. `'create'` = effective (unchanged; this is the lens company only on submit routes).
- New helpers:
  - `reachTenantIds(req)`
  - `isReachOnly(req, tenantId)`
  - `viaHeadOffice(req, tenantId): string[]`
  - `widenRls(req, tenantIds)`, which appends to the RLS context through `setRlsContext`.
- Checks that must stay **member-only** keep using `memberTenantIds`:
  - tenants PATCH and merge;
  - contributions;
  - `/tenants/switch` (already refuses a company with no TenantMember row → 403 `NOT_A_MEMBER`);
  - every company picker on a write.

### 6.4 Allow-lists (`lib/headOffice.ts`, one file, tested against registered routes)

**`HO_SUBMIT_ROUTES`** (exact method + pattern). Each route enforces its condition in-route through `assertHoMayPropose(req, ok, what)` → 403 `HEAD_OFFICE_SUBMIT_ONLY`. A condition applies only when `isReachOnly(req, company)`.

- **Procurement:**
  - `POST /procurement/purchase-orders` (draft).
  - `POST /procurement/purchase-orders/:id/submit`: only your own PO (`createdBy`). Through HO it always goes to `pending_approval`, whatever the threshold (`submitPo(…, {forceApproval:true})`).
  - `POST /procurement/purchase-orders/:id/cancel`: only your own, while draft or pending.
  - `POST /stock-transfers`: a request; the company's managers approve, unchanged.
- **Operations:**
  - `POST /recipes` (iteration only).
  - `PUT /recipes/:id` and `POST /recipes/:id/test-attempts`: only while the recipe is in `iteration`.
  - `POST /recipes/:id/submit`.
  - `POST /auth/staff/invite`: the new login is pending in the lens company, within your `childRoles`.
- **HR:**
  - `POST /hr/records/:section`: only a section whose active format has at least one approval step. A section with no steps would approve instantly, so it is refused.
  - `PATCH /hr/records/:section/:id`, `POST …/:id/submit` and `POST …/:id/cancel`: only your own record (`createdById`), not yet acted on.
  - `POST /hr/records/offer/:id/create-employee`: only after the offer is approved.
  - Payroll preparation: `POST /hr/payroll/runs`, `POST /hr/payroll/runs/:id/recalculate`, `PATCH /hr/payroll/payslips/:id` and `DELETE /hr/payroll/runs/:id`, each only while the run is `draft`.
- **Finance:** `POST /accounting/journal-requests`, `PATCH /accounting/journal-requests/:id`, `POST …/:id/submit` and `POST …/:id/withdraw`, each only for your own request.
- **Marketing** (after D4 merges): `PUT /site-layouts/:slug/draft`, `DELETE /site-layouts/:slug/draft` and `POST /site-layouts/:slug/submit`. Only rows whose company is the lens company; rows with no company (`servd:*`) are never allowed.
- **Dev:** `POST /connectors/:kind/change-requests` and `POST /connectors/change-requests/:id/withdraw`. Regenerating secrets is refused.

**`HO_PASSTHROUGH`** (the header is ignored; the route resolves the row's own company itself):
- **Personal routes:** logout, refresh, own password and 2FA, own profile, `/hr/me*` writes, own notification reads, the time clock's own punch, `POST /tenants/switch/:id`.
- **Approval routes:** every approve, reject, decide, post, pay, lock or reopen route listed in §8.3.
- **Modules that never use the active company:** `/intercompany/*` and `/head-offices/*` (they resolve tenants from params and body).

### 6.5 RLS (production has `RLS_ENFORCE=1`; the test database has no policies)

The request's RLS context must always contain the company being touched:
- middleware: lens GETs and submit routes;
- `assertCanApprove`: widens to the item's company or companies when the grant comes through delegation, or through reach for HR's earlier steps;
- `approvalQueueTenantIds`: widens to the delegation-covered companies it returns.

Without this, `purchase_orders` (via `suppliers.tenantId`) and `users` (by `tenantId`) policies would block a delegate's approval in production, while every test passed.

**Unit tests** assert the context after the middleware and after each helper (§12). Before deploy, the orchestrator also verifies one delegated PO approval on a local database with the policies applied and a non-owner role.

### 6.6 What HO staff can see, submit, and not do

| | In reached companies |
|---|---|
| **See** | Every GET their role and Module Access allow, for one company (lens) or all of them ("All companies"). Their own HO's books, HR and payroll as members. Runs, transfers and reconciliation of their HO (accounting module). |
| **Submit** | Only the routes in §6.4, each creating the module's own pending item. |
| **Cannot** | Make direct writes in reached companies. Join their socket rooms (pages poll in v1). Reach another HO's companies. Switch their active company to a reached company. |

**Company members see:** their own company, plus the charges to their company, its balances and the run basis for each HO. Never the HO's books, unless they are an HO member.

### 6.7 Head-office tenants are not trading companies

- `assertTradingCompany(tenantId)` → 422 `HEAD_OFFICE_HAS_NO_BRANDS`. Called by `POST /concepts` and `POST /tenants/apply-template`.
- `POST /tenants/merge` refuses an HO, and refuses any tenant with links or controlled accounts → 422 `MERGE_HAS_HEAD_OFFICE`.
- `POST /tenants` becomes ADMIN_ONLY and always creates `kind company`.
- `/tenants/mine` returns `kind`, and adds reached companies as `{access:'head_office', via:[HO names]}` (the switcher uses them for the lens; they cannot be switched to).
- `primaryTenantId()` (setup-config) and the boot location seeding filter on `kind: 'company'`.
- An HO may have:
  - an office Location (time clock / geofence);
  - suppliers and bills (its own costs);
  - bank accounts;
  - fixed assets;
  - HR.

---

## 7. Approvals: sections, submissions, delegation, inbox

### 7.1 Sections (one source: `lib/workspaces.ts`)

- Add `approvalSection?: string` to `WorkspaceSection`. Set it on Operations' `stock` section ("Stock & buying") to `'procurement'`. This matches the HO Procurement department and its HOD.
- `sectionOfModule(m)` = that section's `approvalSection`, or else its workspace id.
- `APPROVAL_SECTIONS`:
  - `ceo` (items nobody else may approve)
  - `operations`
  - `procurement`
  - `finance`
  - `marketing`
  - `hr`
  - `dev`
- Titles come from the workspaces; procurement's is "Procurement". A test pins that the list derives from WORKSPACES.

### 7.2 Rights registry: `backend/src/lib/approvalRights.ts` (new; the one copy)

`APPROVAL_TYPES` moves here; `approvals/types.ts` re-exports it. Providers and routes both read `APPROVAL_RIGHTS`.

| type | section | queue module | role path (today's guard, members only) | delegable | delegate must hold | item-level CEO-only |
|---|---|---|---|---|---|---|
| `staff_login` | operations for floor roles (`OTP_LOGIN_ROLES`: cashier, foh, boh, kitchen, expediter); otherwise **ceo** | role_management | admin | floor roles only | staff_directory | every password role (managers and above, owner, finance, hr, marketing, brand_manager, procurement, it) |
| `storefront_publish` | marketing (company brand rows); **ceo** for rows with no company | storefront | admin | company rows only, **after the owner confirms** (grant refused with 422 `SECTION_NOT_YET_DELEGABLE` until a constant is flipped) | storefront | `servd:*` / null-tenant rows; rollback and delete stay with the CEO |
| `purchase_order` | procurement | procurement | admin | yes | procurement | — |
| `stock_transfer` | operations | inventory | MANAGERS | no | — | — |
| `recipe` | operations | recipes | admin, owner | yes | recipes | — |
| `hr_request` | hr | staff_hr | per step (`canActOnStep`) | the **final** step (HR or management) | staff_hr | — |
| `payroll_run` | hr | staff_hr | admin, owner, management | approve, lock, reopen (**not** paid) | staff_hr | — (OWN_PAY_IN_RUN applies) |
| `tip_pool` | finance | payroll | admin, owner | post, pay | payroll | — |
| `journal_request` (new) | finance; **ceo** for kind reverse | accounting | admin | kind post only | accounting | kind reverse |
| `ho_recharge` (new) | finance | accounting | admin | yes, **HO-wide delegation only** | accounting | — (reversal is CEO-only) |
| `ic_transfer` (new) | finance | accounting | admin | yes (covering the company) | accounting | — (reversal is CEO-only) |
| `connector_change` (new) | dev | api_pos | admin | yes | api_pos | — |

**Exports:**
```ts
export interface ApprovalCheck {
  type: ApprovalType
  tenantId: string | null            // the item's company (runs: the HO); null = shared row → CEO only
  touchesTenantIds?: string[]        // every company it posts into (runs: HO + each company with a line); default [tenantId]
  ceoOnly?: boolean                  // item-level CEO-only (table above)
  roleListAllows: boolean            // the module's existing role list admits req.staffUser.role
  submittedByIds: Array<string | null | undefined>   // creator / submitter / preparers
  entity: string; entityId: string; action: 'approve'|'reject'|'post'|'pay'|'lock'|'reopen'|'decide'
}
export type ApprovalGrant = { via: 'role' } | { via: 'delegation'; delegationId: string }
export async function canApprove(req, c): Promise<ApprovalGrant | { denied: 403 | 404; code: string; message: string }>
export async function assertCanApprove(req, c): Promise<ApprovalGrant>   // throws; widens RLS on success
export async function approvalQueueTenantIds(req, type): Promise<string[] | null>  // null → the queue route answers 403
export async function liveDelegations(userId): Promise<LiveDelegation[]>
export async function delegationCovering(userId, type, tenantIds: string[]): Promise<LiveDelegation | null>
export async function submittedThroughHeadOffice(tenantId: string, submitterIds: string[]): Promise<boolean>
export function sectionOf(type: ApprovalType, item?: { role?: string; tenantId?: string | null; kind?: string }): ApprovalSection
export async function auditApproval(req, e: { type; entity; entityId; tenantId; decision; via; delegationId? }): Promise<void>
```

### 7.3 Submitting for approval, per module (every type uses its own module state)

| Section | HOD action (through HO, see §6.4) | Pending state | Approve / reject route (existing unless marked NEW) | Change |
|---|---|---|---|---|
| Procurement | Purchase order | PO `pending_approval` (always pending through HO) | `POST /procurement/purchase-orders/:id/approve`, `/reject` | `ALL_STAFF` + `assertCanApprove`.<br>Separation of duties: not `createdBy`.<br>Claim with `updateMany where status='pending_approval'`; zero rows → 409. |
| Procurement / Ops | Stock transfer request | `requested` | `PATCH /stock-transfers/:id/approve`, `/cancel` | Unchanged: the company's managers (non-delegable). |
| Operations | Recipe / live price | `iteration → pending_approval` | `POST /recipes/:id/approve`, `/reject` | `assertCanApprove`; the existing owner rule stays; claim by status. |
| Operations | Floor login | `User.accountStatus = pending` | `PATCH /auth/staff/:id/approve`, `/reject` | `assertCanApprove(ceoOnly = role is not a floor role)`.<br>Separation of duties: not `invitedById`.<br>422 `LOGIN_NEEDS_COMPANY` stays. |
| Marketing | Company brand page or pop-up | SiteLayout `draftStatus pending` | `POST /site-layouts/:slug/approve`, `/reject` | `assertCanApprove(ceoOnly = tenantId null)`.<br>Separation of duties: not `submittedById` / `draftUpdatedById`.<br>Done after D4 merges. |
| HR | Leave, overtime, salary revision, offer, loan, promotion, termination, … | `HrRecord` submitted at step n | `POST /hr/records/:section/:id/decide` | `decideRight` (§7.4.3). |
| HR | Payroll | `HrPayrollRun` draft | `POST /hr/payroll/runs/:id/approve` (+ `/lock`, `/reopen`) | `assertCanApprove`.<br>Existing preparer rule plus OWN_PAY_IN_RUN.<br>`/paid` keeps the role path only. |
| Finance | Manual journal | **NEW `JournalRequest`** draft → submitted (`returned` on reject) | **NEW** `POST /accounting/journal-requests/:id/approve`, `/reject` | Approve calls `postManualJournal` (the same function as `POST /accounting/journal`) with `sourceId = request.id`. Reference `manual:<requestId>`, so the existing CEO reversal route can undo it. Raises the `manual_journal` exception as today. Kind reverse calls `reverseManualJournal` (CEO only). |
| Finance | Monthly recharge / true-up | **NEW `RechargeRun`** | **NEW** `POST /intercompany/runs/:id/approve`, `/reject` | §4.3 |
| Finance | Settlement / adjustment | **NEW `IntercompanyTransfer`** | **NEW** `POST /intercompany/transfers/:id/approve`, `/reject` | §4.6 |
| Finance | Tip pool post / pay | `TipPool` draft / posted | `POST /tip-pools/:id/post`, `/pay` | `assertCanApprove`. Separation of duties: not `createdById`. |
| Dev | POS connector settings | **NEW `PosConnectorChange`** | **NEW** `POST /connectors/change-requests/:id/approve`, `/reject` | Approve calls the extracted `applyConnectorConfig(tx, tenantId, kind, body, actor)`: the same row lock and validation as `PUT /connectors/:kind`, with sealed secrets decrypted inside. A live fiscal connector refuses driver and URL changes (switch off first), as today. |
| Marketing | Campaigns / promos | — | — | Not through HO in v1 (owner question). |
| Finance | Bank-rec adjustments, period close | — | — | Not through HO; close stays CEO-only. |

This is not a second approval engine:
- `ApprovalDelegation` only says **who** may decide a section.
- Items, states and decisions stay in each module's own row.
- The inbox reads module routes as the user.
- Each new pending record belongs to exactly one module and posts or applies through that module's own path.

### 7.4 Who may approve

1. **Role path:**
   - `roleListAllows`, and
   - every tenant in `touchesTenantIds` ∈ `memberTenantIds`, and
   - the caller is `admin`, **or** `!submittedThroughHeadOffice(tenantId, submittedByIds)`. "Through head office" means a submitter is a member of an HO with a live link to the item's company and is **not** a member of that company. It is evaluated at approval time.

   This enforces "HODs submit to me": a company GM or co-owner never approves an HOD's submission, while their own staff's items are unchanged. Stock transfers are exempt; their company managers decide as today.
2. **Delegation path:**
   - the type is delegable;
   - `!ceoOnly`;
   - `sectionOf(type, item) ≠ 'ceo'`;
   - a **live** delegation exists for the caller, the section and the type that covers **every** tenant in `touchesTenantIds`.
   
   `ho_recharge` requires a delegation with `companyTenantId null` for the run's HO.
3. **Separation of duties:** if a non-admin caller is in `submittedByIds` → `assertNotSelfApproval` (403 `SELF_APPROVAL_BLOCKED` plus a `self_approval` flag). The CEO is exempt.
   - **HR `decideRight(req, rec, step, isLast)`:** `canActOnStep` plus the following.
     - **Member of `rec.tenantId`:** today's rules, including `stepIsHrWork` → staff_hr. On a final step of a record created through HO, the through-HO rule applies.
     - **Reach-only caller:** may decide an `hr` step that is **not** the last step (HR review work). The final step, whether HR or management, needs a live HR delegation covering `rec.tenantId`; otherwise 403 `FINAL_STEP_NEEDS_HANDOVER`.
     - **Widening:** on success it widens RLS.
     
     `approvalsWaitingOn` uses the same function over member ∪ reach ∪ delegation-covered companies, so the route and the inbox agree.
4. **Denied:**
   - if the item's company is in member ∪ reach ∪ any delegation-covered company → 403 `APPROVAL_NOT_YOURS` ("This needs the CEO" or "…the <section> approver");
   - otherwise 404, so the id is not confirmed.
5. **Row lookups:** approve and queue routes stop using role arrays.
   - Guard: `requireAuth(...ALL_STAFF)` plus the module checks they already have.
   - Load: the row by id with no scope, then compute its company, then `assertCanApprove`.
   - Queue routes use `approvalQueueTenantIds(req, type)` = (view scope ∩ members, when `roleListAllows`) ∪ delegation-covered companies regardless of the view. If that is empty and the caller has no right anywhere, the route answers 403, so the inbox drops the type.

### 7.5 Delegation (`modules/approvals/delegationRoutes.ts`; logic in `lib/approvalRights.ts`)

**Grant**, `POST /approvals/delegations` (ADMIN_ONLY), body `{headOfficeId, companyTenantId?, section, approvalTypes?, delegateUserId, endsAt?, note}`:
- **Scope:** the HO is kind head_office and the CEO is a member of it (404 otherwise). The company, if given, is live-linked to that HO (422 `COMPANY_NOT_LINKED`).
- **Section:** must be in the list and not `ceo` → 422 `SECTION_NOT_DELEGABLE`. Marketing → 422 `SECTION_NOT_YET_DELEGABLE` until the owner confirms. The types must be a subset of the section's delegable types → 422 `TYPE_NOT_IN_SECTION`.
- **Delegate:**
  - active login, not admin, and an active member of that HO → 422 `DELEGATE_NOT_ELIGIBLE`;
  - holds the "must hold" module for every delegated type → 422 `DELEGATE_LACKS_MODULE` (naming the module);
  - `endsAt` is in the future, with no backdating.
- **One HO per (company, section):** no live delegation of the same (company, section) may belong to **another** HO → 409 `SECTION_HANDED_TO_OTHER_HEAD_OFFICE`. A company-scoped grant collides with another HO's HO-wide grant that covers that company, and the reverse. Checked under `pg_advisory_xact_lock(hashtext('delegation:'||section))`. Several delegates within one HO are allowed (a deputy); the first to act wins through the module's claim.
- **No edit:** revoke and grant again.

**Revoke**, `POST /approvals/delegations/:id/revoke {reason}` (ADMIN_ONLY). A second revoke → 409.

**List:** `GET /approvals/delegations` (the CEO sees all in their HOs; others see their own). `GET /approvals/delegations/eligible?headOfficeId&section`. `GET /approvals/catalog` returns sections → delegable types with labels.

**Live check on every use** (nothing cached; no expiry job):
- not revoked, and `startsAt ≤ now < endsAt`;
- the delegate is still active, still a member of the HO, and still holds the module;
- the coverage is either the company itself, or HO-wide where the tenant is the HO or a company with a **live** link now;
- the type is in `approvalTypes`, or that list is empty.

So expiry, revocation, unlinking, removal from the HO or loss of the module all bite on the very next request.

**After hand-over:** the section's items go to the delegate's inbox. The CEO keeps the role path, and the delegate's own submissions still go to the CEO because of separation of duties.

### 7.6 Inbox routing (`modules/approvals/service.ts`, still read-only)

- **Item fields:** `ApprovalItem` gains `section`, `submittedByIds`, `viaHeadOfficeId?` and `handedOverTo? {userId, name, endsAt}`. `ApprovalTypeSummary` gains `section`. The response gains `sections:[{id, title, count, handedOver, delegates:[…]}]` and `handedOver` (a total).
- **New providers:**
  - `journalRequests` (`GET /accounting/journal-requests?status=submitted`)
  - `rechargeRuns` (`GET /intercompany/runs?status=submitted`); its approve dialog carries warnings and `postInOpenPeriod`.
  - `icTransfers` (`GET /intercompany/transfers?status=submitted`)
  - `connectorChanges` (`GET /connectors/change-requests?status=submitted`)
- **Who sees what:**
  - **CEO:** every item in their companies. Items covered by a live delegation whose delegate is not a submitter go into a collapsed "Handed over to <name> until <date>" group per section. They are counted in `handedOver`, not in `total`, and the CEO can still act on them. `?view=all` lists them inline.
  - **Delegates:** items of their delegated sections and types in covered companies, whatever the view, labelled by company. Their own submissions are never listed.
  - **Company role approvers:** as today, minus items submitted through HO (one batched membership query).
  - **HR:** `spansMemberCompanies` widens to member ∪ reach ∪ delegated.
- **Context and query:** `ProviderContext` gains `reachTenantIds` and `delegated: Map<type, Set<tenantId>>`. Query becomes `GET /approvals?type&section&view`. `delegations.ts` is implemented on top of `lib/approvalRights.ts`.

### 7.7 CEO-only, even after any delegation (route keeps `requireAuth(...ADMIN_ONLY)` and never calls `assertCanApprove`; a test pins each)

- **Module access:** `PUT /permissions/role-modules`; the CEO staff editor (`POST/PATCH/DELETE /auth/users…`, reissue password, 2FA reset).
- **Companies and head offices:** every `/tenants` write, `/concepts` create and delete, every `/head-offices/*` route, `/hr/head-office-transfers*`, and delegation grant and revoke.
- **Logins:** every password-role login (item-level).
- **Periods:** `POST /accounting/period-close` and `/period-close/reopen`.
- **Tax:** `/connectors/fiscal/go-live`, `/switch-off`, `/reporting-required`, `/documents/release`.
- **Journals:** `POST /accounting/journal` (direct), `/accounting/journal/:id/reverse`, `/intercompany/runs/:id/reverse`, `/intercompany/transfers/:id/reverse`, and journal requests of kind reverse.
- **Storefront:** pages with no company (`servd:*`); `/site-layouts/:slug/rollback`; `DELETE /site-layouts/:slug`.

### 7.8 Audit

- **Durable rows first:**
  - links (start, end, ended by, reason);
  - books (confirmed by, at, note);
  - split versions, which are never edited;
  - runs and transfers (prepared, submitted and decided by; how decided; delegation id; reversed by);
  - delegations, which are never deleted.
- **`audit()` events:**
  - `accounting` category:
    - `ho.create`, `ho.link`, `ho.unlink`
    - `ho.accounts.map`, `ho.accounts.confirm`, `ho.pool.update`
    - `ho.recharge.enable` / `ho.recharge.disable`
    - `ho.split.create`
    - `ho.recharge.prepare|submit|approve|reject|withdraw|reverse`
    - `ho.transfer.*`
    - `period.close.recharge_override`
    
    Written in the HO's trail **and** in each touched company's trail.
  - `identity` category: `approval.delegation.grant|revoke`, `hr.transfer` (both companies), `ho.setup.apply`.
- **Every approve or reject of a delegable type:**
  - writes `approval.decide {type, entity, entityId, decision, via, delegationId}` through `auditApproval`, next to the module's existing audit, `poActivityLog` or `SiteLayoutVersion`;
  - submit audits through HO gain `metadata.viaHeadOfficeId`.

---

## 8. Removing the old pieces (consumers move first) and planning

| Old piece | What it fed | Moves to | Removed (same release; data kept) |
|---|---|---|---|
| `TenantContribution(head_office)` | `budgetedLabour` netting (Positions summary, OpEx budget); `monthlyLabourCents` (Projections "Head office labour (net of JV)", OpEx); the OpEx payroll snapshot's in-scope cancel; the contributions panel and modal; tenants merge repoint | `headOfficePlanCharges(tenantIds, month)` in `lib/labour-budget.ts`, used by **both** labour functions (below); the books get the posted recharge | • POST/PATCH refuse `head_office` → 422 `USE_HEAD_OFFICE`, and the zod default becomes required.<br>• Readers skip a head_office row **once either of its companies has a live HO link** (until then it still counts, so there is no planning gap).<br>• The setup wizard ends the rows.<br>• GET lists ended rows read-only.<br>• Commissary, shared_services and other categories are unchanged. |
| `Department.isHeadOffice` | HR org badge and toggle (`hr/routes.ts` ~L700–776); positions include; `byDepartment.isHeadOffice` | Derived: `headOffice = tenant.kind === 'head_office'` | zod strips the field on create and edit; responses stop returning it; UI toggle and badges removed. |
| `Position.tenantCostShareCents` / `costShareNote` | Labour totals (share × headcount); the note on Workforce positions | Seats are 100% their own tenant's; shared cost goes through the HO split | • The API strips both fields.<br>• The server sets share = gross on create, and on any change to `monthlySalaryCents`.<br>• Readers keep reading `tenantCostShareCents`, which is now always equal to gross; the wizard normalises the old rows (no silent number change).<br>• The UI inputs and the note are removed. |
| "Head office (unallocated)" label | Brand P&L, management dashboards | "Company overhead (unallocated)" | Rename `HEAD_OFFICE_LABEL` plus the admin text. |

**Planning (Stream C):**
- `headOfficePlanCharges(tenantIds, month)`:
  - **Company C in scope:** for each live link (H, C), the charge is share(H, C, split for the month) × `budgetedLabour([H]).shareMonthlyCents`. That is salaries only, the same scope as today.
  - **HO H in scope:** `rechargedOut` = Σ of those charges.
  - **Pairs with both sides in scope** cancel.
- `budgetedLabour` adds `headOfficeCharges:[{headOfficeId, name, shareBps, monthlyCents}]`, `headOfficeChargesMonthlyCents` and `rechargedOutMonthlyCents`. `net = share + outgoing(other) − incoming(other) + hoCharges − rechargedOut`.
- `monthlyLabourCents` does the same: it renames `headOfficeCents` to `companyLevelSeatsCents` and adds `headOfficeChargesCents`.
- OpEx payroll snapshot, projections ("Head office charges (plan)" and "Company-level seats") and positions summary (`contributions` = other categories + `headOfficeCharges`) all switch over.
- **Seeded check:** before and after the wizard, the figures are identical: GS Foods 300k + company-level seats; GSX Viva 500k; portfolio 800k + company-level seats.

---

## 9. API (new and changed)

### `/head-offices` (CEO only: `requireAuth(...ADMIN_ONLY)`; module `tenants`)

- **Head offices:**
  - `GET /head-offices`, `GET /head-offices/:id` (links, current split, books status, last runs).
  - `POST /head-offices {name}`: in one transaction, create the Tenant (kind head_office), `TenantMember(CEO, owner)`, the chart, the recharge account and `HeadOfficeBooks`. Recharge is OFF.
  - `PATCH /head-offices/:id {name?, isActive?}`: deactivating is refused while it has live links or non-zero balances → 409 `HEAD_OFFICE_IN_USE`.
- **Links:**
  - `POST /head-offices/:id/companies {companyTenantId}`. The CEO must be a member of both. The company must be kind company and active; otherwise 422 `LINK_TARGET_NOT_A_COMPANY`. It creates the link and the accounts in both charts, and clears confirmation and switches recharge OFF.
  - `POST /head-offices/:id/companies/:companyId/end {reason, lastChargedPeriod}`. Reach and delegation cover end at once. In the same transaction, if no version effective at `lastChargedPeriod`+1 exists, it creates one: the version in force without that company, with a warning to re-spread. A run for a month after `lastChargedPeriod` never charges the company → 422 `COMPANY_UNLINKED`.
- **Splits:** `GET/POST /head-offices/:id/splits`; `DELETE /head-offices/:id/splits/:splitId`.
- **Books:**
  - `GET /head-offices/:id/books`
  - `PUT /head-offices/:id/books/accounts`
  - `PUT /head-offices/:id/books/pool`
  - `POST /head-offices/:id/books/confirm {note, taxAnswer}`
  - `PUT /head-offices/:id/books/recharge {enabled, fromPeriod, requireLockedPayroll}` → 409 `ACCOUNTS_NOT_CONFIRMED` when enabling unconfirmed books.
- **Setup:** `GET /head-offices/setup/preview`; `POST /head-offices/setup` (§14).

### `/intercompany` (module `accounting`; HO preparers, company readers and approvers as in §4)

- **Runs:**
  - `GET /intercompany/preview?headOfficeId&period`
  - `GET /intercompany/runs?headOfficeId&period&status`
  - `POST /intercompany/runs`
  - `GET /intercompany/runs/:id`
  - `POST /intercompany/runs/:id/refresh|submit|withdraw|approve|reject|reverse`
- **Transfers:**
  - `GET /intercompany/transfers`, `POST /intercompany/transfers`
  - `PATCH /intercompany/transfers/:id`
  - `POST /intercompany/transfers/:id/submit|withdraw|approve|reject|reverse`
- **Reports and status:**
  - `GET /intercompany/reconciliation`
  - `GET /intercompany/statement`
  - `GET /intercompany/close-status?tenantId&through`
  - `GET /intercompany/head-offices/:id/summary`: for HO members; served companies, current shares, last runs, balances.

### `/accounting`

- `GET /accounting/journal-requests?status`: read scope ∪ approvable.
- `POST /accounting/journal-requests`: preparers admin, owner, management, finance. Bound to the active company, or to the lens company on a submit route.
- `PATCH /accounting/journal-requests/:id`: the preparer; draft or returned.
- `POST /accounting/journal-requests/:id/submit|withdraw`: the preparer.
- `POST /accounting/journal-requests/:id/approve|reject`.
- `POST /accounting/period-close` gains `acknowledgeRecharge`.
- `POST /accounting/journal` and `/journal/:id/reverse` now call `manualJournal.ts`.

### `/approvals`

- `GET /approvals?type&section&view`, `GET /approvals/counts`, `GET /approvals/catalog`
- `GET /approvals/delegations`, `GET /approvals/delegations/eligible`
- `POST /approvals/delegations`, `POST /approvals/delegations/:id/revoke`

### `/connectors`

- `GET /connectors/change-requests?status`
- `POST /connectors/:kind/change-requests`: CONNECTOR_ADMINS. Requires `SERVD_SECRET_KEY` when secrets are given; otherwise 503 `SECRET_KEY_MISSING`.
- `POST /connectors/change-requests/:id/approve|reject|withdraw`

### `/hr`

- `POST /hr/head-office-transfers/preview`, `POST /hr/head-office-transfers` (ADMIN_ONLY).

### Changed elsewhere

- **`/permissions/me`** gains `headOffices:[{id,name}]`, `reach:[{companyId, name, via:[{id,name}]}]` and `delegations:[{id, section, scopeName, endsAt}]`.
- **Tenants and concepts:**
  - `/tenants/mine` gains `kind` and the reach entries.
  - `POST /tenants` becomes ADMIN_ONLY.
  - merge and apply-template refuse an HO.
  - `POST /concepts` refuses an HO.
- **Chart of accounts:** `PATCH /setup/chart-of-accounts/:id` refuses deactivating a controlled account.
- **Approve and queue routes** listed in §7.3 are rewired.
- **Submit routes** listed in §6.4 gain their conditions.
- **HR org, positions and contributions:** as in §8.
- **`index.ts`:**
  - register `registerHeadOfficePlugins(api)` (`/head-offices` + `/intercompany`);
  - add the delegation routes inside the approvals plugin;
  - start `startHeadOfficeRechargeWorker()` under `ENABLE_WORKERS`;
  - add `/health` `headOffice` via `headOfficeHealth()`;
  - apply the boot `kind` filters.

### Module gates (`lib/moduleAccess.ts` `GATED_PREFIXES`)

Add `{ prefix: '/intercompany', anyOf: ['accounting'] }` and `{ prefix: '/head-offices', anyOf: ['tenants'] }`. There are **no new module ids**, so there are no `MODULE_GRANTS` changes and no change to the frontend `ModuleId` union.

---

## 10. Admin pages (`frontend/admin`)

### CEO workspace

**Companies & head offices** (`/ceo/companies`, module `tenants`):
- companies, each with the HOs that serve it;
- head offices, each with its companies, split status and books status ("Confirm with your CA" / Confirmed / "Recharge on from <month>");
- buttons: "New head office" and "Set up head office from today's records" (`/ceo/head-offices/setup`: preview → apply).

**Head office detail** (`/ceo/head-offices/[id]`), with tabs:

| Tab | Contents |
|---|---|
| Companies | Link or end a link, with the last charged month. |
| Cost split | Versions; the total and the % retained; "New split from <month>". |
| Books | Per pair, the four accounts resolved to names in each chart; the recharge account; the cost pool; a yellow CA badge.<br>Confirm dialog checklist: names/codes, pool, % table, and the **tax answer**, which is required.<br>Recharge switch, first month and the payroll-lock rule. |
| Runs | — |
| Reconciliation | Pairs and their differences. |
| Hand-over | The delegations of this HO. |
| People | HO employees and members; the "Move people to head office" tool (preview → apply); warnings such as "also a direct member of …". |

**Approvals** (`/ceo/approvals`):
- tabs: All · Operations · Procurement · Finance · Marketing · HR · Dev · CEO only, each with a count;
- items grouped by type, with company and "via <HO>" chips;
- a collapsed "Handed over" group per section;
- new item actions: journal request approve/return; recharge approve dialog (warnings, `postInOpenPeriod`); transfer approve/reject; connector change approve/reject.

**Hand-over** (`/ceo/approvals/hand-over`): every delegation (active, ended, revoked). The grant dialog has HO, the whole HO or one company, section, types, person (eligible list only), end date and note. The revoke dialog takes a reason.

### Finance and accounting

- **Finance → Intercompany** (`/finance/intercompany`, module `accounting`):
  - HO members: runs (prepare, preview, refresh, submit, withdraw), transfers, reconciliation and statements;
  - company members: charges to their company per HO, balances and statements.
- **Accounting → Journal:** non-CEO users get "Send for approval" plus a list of their requests (draft, submitted, returned, posted). The CEO keeps direct posting and also sees requests.

### Head-office staff

- **Lens:**
  - `TenantSwitcher` adds a "Through <HO>" group from `/permissions/me.reach`. Picking a company sets `localStorage servd_lens_tenant`; it never calls `/tenants/switch`.
  - `lib/api.ts` sends `x-servd-active-tenant: <lens>` on **every** request while the lens is on, unless `extra.tenantId` is given. On 403 `HEAD_OFFICE_SUBMIT_ONLY` it shows a toast. The portfolio write-guard modal is skipped while the lens is on.
  - At app load, a lens that is no longer in `reach` is dropped.
- **`LensBanner`** in AppShell: "Viewing GSX Viva through GS Head Office — you can look, and send changes for approval."
- **`/head-office`** (always open; the API scopes it): served companies, current shares, last month's recharge status, balances, "Handed to you by the CEO: <section> for <scope> until <date>", and quick links.
- Existing submit buttons (new PO / submit, recipe submit, HR record create / submit, payroll preparation, invite, storefront submit) work through the lens as they are. The only change is that results say "Sent for approval".

### Removals and labels

- `/workforce/positions` (`view.tsx`): head_office contribution rows become read-only "ended"; a "Head office charges (plan)" panel is added; isHeadOffice badges and the cost-share/note inputs go.
- `/hr/org`: the isHeadOffice toggle goes.
- `/finance/projections` and `/finance/opex`: new labels.
- `/finance/capex`: text.

### `lib/moduleCatalog.ts`

- `tenants` gains Companies & head offices;
- `approvals` gains Hand-over;
- `accounting` gains Intercompany and Journal requests;
- `ALWAYS_OPEN_PREFIXES` gains `/head-office`;
- the gap notes are updated for the new label.

---

## 11. Workspaces and sidebar

- `workspaces.ts`: `approvalSection: 'procurement'` on Operations' `stock` section; the CEO "Companies & head offices" comment is updated.
- `tests/workspaces.test.ts` is updated.
- The sidebar shows Approvals to a delegate while they hold a live delegation, as well as whenever counts > 0.

---

## 12. Tests (real Fastify inject on the disposable DB; every new route has a two-company test)

Fixtures used throughout:
- **A–B:** two companies, each with its own staff.
- **HO + C1 + C2:** a head office serving two companies.
- **C under H1 and H2:** one company under two head offices.

### Stream A (books)

**`headOfficeBooks.test.ts`** (HO + C1 + C2, split 60/30, 10% retained). Set-up: an HO payroll accrual through `postPayrollAccrual`, plus a bill and a manual JE in September. Then:
- preview and prepare give the basis by account, the lines and the retained amount;
- rounding is exact, including 100,001 paisa over 3 × 3333 bps;
- submit is refused until:
  - the books are confirmed;
  - recharge is on;
  - payroll is locked;
  - the month is over;
  - the period is on or after cutover;
- approve gives 2 pairs, every book balanced, the 4 invariants, and an HO P&L equal to the retained amount;
- a second approve → 409; a concurrent approve posts once;
- C2 locked → nothing posted in any book, with 409 naming C2; with `postInOpenPeriod` every book gets the same date;
- drift is reported at approval;
- positive and negative true-ups;
- the CEO reversal restores both books; non-CEO gets 403;
- a split over 100% → 422; a split version into a used month → 409;
- the worker makes one draft per (HO, month) across two ticks, never posts, and leaves a rejected month alone;
- `intercompany_mismatch` is raised.

**`controlledAccounts.test.ts`:**
- a manual JE, journal request, bill, allocation run or bank-rec adjustment on a controlled account → 422 `INTERCOMPANY_ACCOUNT_CONTROLLED`;
- deactivating one → 422;
- re-mapping with history → 422; re-mapping after posting → 409;
- `ho.*` postings pass.

**`headOfficeTwoHeadOffices.test.ts`** (C under H1 at 40% and H2 at 25%):
- two due-to and two charges accounts;
- each run touches only its own pair;
- each pair reconciles to 0;
- C's close is refused, naming both, until both are ready; the override is audited and flagged;
- ending H2 leaves H1 untouched; a later H2 month does not charge C;
- a second HO's hand-over of the same (C, section) → 409.

**`headOfficeClose.test.ts`:**
- the HO close is refused with drift, an open run, or payroll not locked;
- the company close is refused until the HO is ready;
- a zero-cost month closes;
- the mid-month lock window;
- the override.

**`intercompanyTransfers.test.ts`:**
- a settlement and both adjustment effects post to both books;
- reversal is CEO-only;
- company B gets 404 on the A–HO pair;
- a company-scoped Finance delegate approves.

**`headOfficeAdmin.test.ts`:**
- only the CEO can create, link, split, confirm, switch recharge on or run setup; others get 403 and a foreign company gets 404;
- linking an HO under an HO → 422;
- brand creation in an HO → 422 (both paths);
- merge refuses;
- `POST /tenants` is ADMIN_ONLY;
- any accounts change clears confirmation and switches recharge off; the CHECK holds.

**`headOfficeSetup.test.ts`:**
- the preview suggests 37.5/62.5;
- apply creates the HO, links, v1 split, departments and seats, and ends the contributions;
- a second run → 409.

**`journalRequests.test.ts`:**
- two companies; create binds to the active company; B gets 404;
- the cycle draft → submitted → returned → resubmitted → posted;
- the posted entry `manual:<id>` matches what a direct `POST /accounting/journal` would post and can be reversed by the CEO route;
- a locked period → 422 and the request stays submitted;
- the preparer cannot approve;
- kind reverse is CEO-only.

### Stream B (access and approvals)

**`headOfficeReach.test.ts`:**
- **Lens reads:** reads of A work through the lens, and in portfolio, within the member's modules.
- **Lens writes:**
  - an unlisted write → 403 `HEAD_OFFICE_SUBMIT_ONLY`;
  - a submit route binds to A;
  - a passthrough route ignores the header;
  - a member of B forging header = A: GET is ignored (404 on A's rows); a non-GET → 403 `COMPANY_HEADER_NOT_ALLOWED`.
- **Reach limits:**
  - unlinking → no reach on the next request;
  - reach never chains and never reaches another HO's companies;
  - `/tenants/switch` to a reached company → 403;
  - no TenantMember rows are ever created.
- **RLS context unit tests:** GET single, portfolio, submit, passthrough, delegated approve, HR non-final step and the queue helper.
- **Allow-lists:** every `HO_SUBMIT_ROUTES` and `HO_PASSTHROUGH` entry matches a registered route (an `onRoute` collector).

**`approvalRights.test.ts`:**
- registry invariants;
- sections derive from WORKSPACES;
- every CEO-only route in §7.7 still answers 403 to a delegate;
- `delegationCovers`: HO-wide covers the HO and its live links; company scope covers only that company; not started, expired, revoked, left the HO or lost the module → not live.

**`approvalDelegation.test.ts`:**
- Grant and revoke are CEO-only, with eligibility and module checks and audit; Marketing is refused until it is flipped.
- **Before hand-over:** an HOD's PO, recipe or journal request in A shows in the CEO inbox under its section, and the HOD's own approve call → 403.
- **After an HO-wide Procurement hand-over:**
  - the HOD approves a teammate's PO in A; audit records `via: delegation`;
  - their own PO → 403 plus a flag, and it stays with the CEO;
  - a company-scoped hand-over does not cover B;
  - past `endsAt`, revoked, unlinked, removed from the HO or module lost → 403 on the next call.
- **CEO inbox:** shows the "Handed over" group, and the CEO can still approve.
- **Through-HO rule:** a GM of A cannot approve an HOD-submitted recipe or payroll in A, but can approve A's own staff's.
- **CEO-only items never pass through delegation:** a manager login, a `servd:*` page, a reverse request.

**Also in Stream B:**
- `approvalsInbox.test.ts` (update): sections, `handedOver`, `submittedByIds`, `viaHeadOfficeId`, the four new providers.
- `workspaces.test.ts` (update).
- `connectorChanges.test.ts`:
  - a request through the lens, with secrets sealed and never returned;
  - approve goes through the same validation as PUT, including the live-fiscal refusals;
  - regenerating secrets is refused;
  - B gets 404.

### Stream C (people and planning)

**`hrHeadOffice.test.ts`:**
- through the lens: a with-steps record in A → 201; a no-step section → 403;
- HO HR decides a non-final HR step in A;
- a reach user on the final or management step → 403 without hand-over, OK with an HR hand-over;
- payroll prepared in A through the lens; at approval:
  - the preparer → 403;
  - OWN_PAY_IN_RUN → 403;
  - A's management cannot approve an HO-prepared run;
  - a delegate can;
- `approvalsWaitingOn` includes reach (non-final) and delegated (final) items;
- `isHeadOffice` is ignored;
- HO payroll posts to the HO's books.

**`hrTransfer.test.ts`:**
- the old record becomes `transferred`;
- leave is carried over;
- refusals for loans, open records and payroll conflicts;
- `payableEmployees` makes the old company pay through K−1;
- the login is kept, and memberships are handled;
- the seat moves;
- both companies' trails are audited.

**`labourBudgetHeadOffice.test.ts`:**
- plan charges appear in `budgetedLabour`, `monthlyLabourCents`, the OpEx snapshot, projections and positions summary;
- the seeded case is identical before and after setup;
- portfolio cancels;
- a head_office contribution counts until either side is linked, then not; other categories are unchanged;
- positions ignore share and note input.

### Orchestrator

- the full backend suite;
- three tsc runs (backend, admin, storefront);
- `next build` for the admin, plus screenshots;
- one RLS-enforced manual check of a delegated PO approval (§6.5).

---

## 13. Build streams (disjoint file ownership)

**Order:**
1. Wave 2 and D4 stage 1 merge first.
2. **Hour 0:**
   - Stream A commits `schema.prisma` and the migration, then runs `prisma generate`.
   - Stream B commits `lib/headOffice.ts`, `lib/approvalRights.ts` and the `tenantScope.ts` additions with their **final exported signatures**; the bodies may follow.
3. All four streams then run in parallel.
4. Integration (B is the orchestrator).

**Stream A, Books & head office (owns `schema.prisma` and the migrations).** Run by an opus agent; the orchestrator reviews every money path.
- `backend/prisma/schema.prisma`
- `backend/prisma/migrations/20261013120000_head_office/**`
- `backend/tests/setup.ts`
- `backend/src/modules/headOffices/**` (new): README, index, routes, intercompanyRoutes, accounts, pool, splits, runs, transfers, reconciliation, closeChecks, periods, setup, health
- `backend/src/workers/headOfficeRecharge.ts` (new), `backend/src/workers/README.md`
- `backend/src/modules/accounting/journal.ts`, `routes.ts`, `manualJournal.ts` (new), `journalRequests.ts` (new)
- `backend/src/lib/chartOfAccounts.ts`, `backend/src/lib/exceptions.ts`, `backend/src/lib/setup-config.ts`
- `backend/src/modules/setup/routes.ts`
- `backend/src/modules/tenants/routes.ts`, `backend/src/modules/concepts/routes.ts`
- tests: headOfficeBooks, controlledAccounts, headOfficeTwoHeadOffices, headOfficeClose, intercompanyTransfers, headOfficeAdmin, headOfficeSetup, journalRequests

**Stream B, Access & approvals.** Run by the orchestrator itself, per CLAUDE.md: auth, permissions and tenant isolation are never delegated. It may hand sub-parts to an opus agent and review them line by line.
- `backend/src/modules/auth/middleware.ts`, `backend/src/lib/tenantScope.ts`
- `backend/src/lib/headOffice.ts` (new), `backend/src/lib/approvalRights.ts` (new)
- `backend/src/lib/workspaces.ts`, `backend/src/lib/moduleAccess.ts`
- `backend/src/modules/permissions/routes.ts`
- `backend/src/modules/approvals/**`, including the new `delegationRoutes.ts`
- `backend/src/index.ts`
- `backend/src/modules/procurement/routes.ts`, `service.ts`
- `backend/src/modules/recipes/routes.ts`
- `backend/src/modules/auth/routes.ts`, `staffAccounts.ts`
- `backend/src/modules/tipPools/routes.ts`
- `backend/src/modules/stockTransfers/routes.ts`
- `backend/src/modules/connectors/routes.ts`, `changeRequests.ts` (new)
- `backend/src/modules/siteLayouts/routes.ts`, `service.ts` (only after D4 merges)
- tests: headOfficeReach, approvalRights, approvalDelegation, connectorChanges; updates to approvalsInbox and workspaces

**Stream C, People & planning.** Opus agent.
- `backend/src/modules/hr/**`: routes, logic, service, forms, reports, separations, new `transfer.ts`
- `backend/src/lib/labour-budget.ts`
- `backend/src/modules/projections/**`, `backend/src/modules/opex/routes.ts`, `backend/src/modules/positions/**`
- `backend/src/modules/accounting/reports.ts` (label only)
- `backend/src/modules/management/routes.ts` (label text only)
- `backend/scripts/seed-positions.ts` (create the HO + link + split v1 instead of HO seats in GS Foods and the JV contribution)
- tests: hrHeadOffice, hrTransfer, labourBudgetHeadOffice

**Stream D, Admin frontend.** Opus agent; it never runs builds.
- `frontend/admin/src/app/ceo/**`: companies, head-offices/[id], head-offices/setup, approvals, approvals/hand-over, approvalsData.ts
- `frontend/admin/src/app/head-office/**` (new)
- `frontend/admin/src/app/finance/intercompany/**` (new)
- `frontend/admin/src/app/accounting/journal/**`
- `frontend/admin/src/app/workforce/positions/view.tsx`, `app/workforce/page.tsx`
- `frontend/admin/src/app/hr/org/page.tsx`, `app/hr/**` (result texts)
- `frontend/admin/src/app/finance/{projections,opex,capex}/page.tsx`
- `frontend/admin/src/app/procurement/**`, `app/accounting/recipes/**`, `app/connectors/pos/**` (result texts, change requests)
- `frontend/admin/src/components/ui/TenantSwitcher.tsx`, `AppShell.tsx`, `LensBanner.tsx` (new)
- `frontend/admin/src/hooks/useLens.ts` (new)
- `frontend/admin/src/lib/api.ts`, `headOfficeApi.ts` (new), `moduleCatalog.ts`, `hr.ts`
- `frontend/admin/src/components/storefront/**` (submit through the lens; only after D4 merges)

**Agreed cross-stream interfaces (hour 0):**
- **B exports:** `headOfficeReach`, `reachTenantIds`, `isReachOnly`, `viaHeadOffice`, `widenRls`, `assertHoMayPropose`, `assertTradingCompany`, `assertCanApprove`, `canApprove`, `approvalQueueTenantIds`, `delegationCovering`, `submittedThroughHeadOffice`, `auditApproval`, `APPROVAL_RIGHTS`, `APPROVAL_SECTIONS`.
- **A exports:** `registerHeadOfficePlugins`, `startHeadOfficeRechargeWorker`, `headOfficeHealth`, `postManualJournal`, `reverseManualJournal`, `splitFor`.
- **C exports:** `headOfficePlanCharges`, `transferEmployeesToHeadOffice`, `previewTransfer`.

**Orchestrator, after the streams:**
- CLAUDE.md gains a "Head office and approval hand-over" section. The storefront rule text changes only once the owner confirms Marketing hand-over.
- Run the full suite, three tsc runs and the admin build with screenshots, and verify the money and auth paths in A, B and C.

---

## 14. Rollout, cutover and rollback

1. **Before switching recharge on:** collect the owner's and the CA's answers (names, codes, pool, tax, cutover month K, starting split, which HO staff keep direct company access). Building can start before then.
2. **Deploy:** use the manual image flow from a clean git archive. The migration is additive and has no backfill. Recharge is OFF, nobody has a delegation, and reach exists only once the CEO links companies.
3. **Right after deploy:** the CEO runs **"Set up head office from today's records"**.
   - **Preview** shows:
     - the active head_office contributions;
     - the isHeadOffice departments with their seats and employees;
     - seats whose share differs from gross;
     - the suggested split (GS Foods 3750 / GSX Viva 6250, from 500k of 800k);
     - planning before and after, per company.
   - **Apply**, in one transaction:
     - creates "GS Head Office";
     - links both companies (accounts in all three charts);
     - creates split v1 effective this month;
     - copies the departments and moves the HO seats (share = gross);
     - normalises the listed seats;
     - ends the head_office contributions;
     - writes the setup marker (a second run → 409 `SETUP_ALREADY_DONE`).
   - Planning totals stay the same: GS Foods 300k, JV 500k.
4. **With the CA:** the CEO confirms the accounts (with the tax answer) and switches recharge on from K.
5. **Month K:** the CEO moves HO staff with the transfer tool. Prerequisites: the HO's EOBI/SESSI registration, bank account and NTN. The HO's payroll runs from K, and the old companies pay through K−1. Direct company memberships are removed except those the CEO ticked.
6. **Month K+1:**
   1. The HO payroll for K is locked.
   2. The worker prepares and submits the run.
   3. The CEO approves it in Approvals → Finance, and both books post.
   4. Settlements are recorded as cash moves.
   5. Reconciliation is 0.
   6. The HO is closed, then the companies.
7. **Hand-over:** whenever the owner scales out, per HO or per company, per section, with an optional end date.

**Rollback:**
- **Code-only rollback:** the old images ignore the new tables and columns. An HO then behaves like an empty company. HO staff lose reach, which is the safe direction. The controlled-account choke point is lost, so any stray line shows in reconciliation after rolling forward again.
- **Posted recharges** are ordinary balanced entries. The CEO reverses them in servd first if needed.
- **Not undone by a code rollback:** the setup wizard's moved seats and ended contributions, and staff transfers. Take a database backup before setup and before the transfers.