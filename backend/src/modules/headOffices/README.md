# Head offices (D1) — module contract

A **head office** is a `Tenant` of kind `head_office` (owner decision D1,
2026-10-11): its own HR, payroll and books, serving trading companies through
`HeadOfficeLink` rows and recharging them monthly. It never has brands, menus,
orders or a till (`lib/headOffice.ts assertTradingCompany` → 422
`HEAD_OFFICE_HAS_NO_BRANDS`), and it has no fiscal POS.

Spec: `.handoff/fixes/D1D3-spec.md` §0, §3, §4.2, §9 — **Amendment A1 wins**
(it supersedes the account ranges and the second transfer engine of §3/§4.6),
plus amendments A11, A12 and A17 in `D1D3-amendments.json`.

**Everything ships OFF.** No head office exists until the CEO creates one (or
runs the setup wizard). Recharge posting stays OFF per head office until the
CEO has confirmed the accounts with the CA, recorded the CA's tax answer and
switched it on with a cutover month.

## Files

| File | What |
|---|---|
| `service.ts` | `createHeadOffice`, `linkCompany`, `endLink`, `assertHeadOfficeMayDeactivate`, `ensureBooks`, `liveHoWideDelegationIds` (all take the caller's transaction) |
| `splits.ts` | the % table: `splitFor`, `splitForOrNull`, `listSplits`, `createSplitVersion`, `deleteSplitVersion`, `markDraftRunsStale`, and the ONE rounding rule `splitByBps` |
| `accounts.ts` | `nextFreeCode`, `createChargesAccount`, `resolveRechargeAccount`, `chargesAccountCodeFor`, `ensureChartInTx`, `validateMapping`, `applyMapping` |
| `books.ts` | `HeadOfficeBooks`: `zCostPool`, `lockBooks`, `invalidateConfirmation`, `updatePool`, `confirmBooks`, `setRecharge`, `booksView`, and the setup marker `headOfficeSetupApplied` |
| `routes.ts` | `headOfficeRoutes` — the CEO's `/head-offices` API |
| `setup.ts` | the setup wizard (`headOfficeSetupRoutes`, HO-C3) |
| `pool.ts`, `runs.ts`, `runRoutes.ts`, `closeChecks.ts`, `reconciliation.ts`, `health.ts` | recharge runs (HO-A2), at `/accounting/intercompany/recharge-runs` |
| `index.ts` | `registerHeadOfficePlugins(api)` (orchestrator) |

## The money side reuses the inter-company engine

There is **no second transfer table** and **no `head_office` due accounts**
(owner, 2026-10-15: "reuse the existing inter-company transfer engine").

- **Due from / due to** of a head-office pair are the existing inter-company
  pair accounts — `intercompany/accounts.ts ensurePairAccounts`, 1450–1499 /
  2150–2199, `controlledBy 'intercompany'` — created when a company is linked.
  The pair tie-out, `intercompany_mismatch` and the inter-company close checks
  therefore cover head-office pairs with no new code. 1400–1449 / 2100–2149
  stay reserved and unused.
- **Head office books — the recharge account:** the head office's own template
  **6990** "Costs Recharged to Group Companies" (`ACCT.GROUP_RECHARGES`,
  credits only), resolved — never created as 6991+ (A1.2). The CA may re-map
  it to another expense or to a revenue account (warning: the All-companies
  P&L shows it as income and cost until eliminations are built).
- **Company books — "Head office charges — <HO>":** an expense account at the
  first free code in **6200–6249** (422 `ACCOUNT_RANGE_FULL`), one per
  (company, head office); re-linking the same head office reuses it.
- Each month's charge (HO-A2) posts one `IntercompanyTransfer` per run line
  (`source 'ho_recharge'`, `sourceRef 'ho_recharge:<lineId>'`) through
  `postSystemTransferTx`. Settlements and adjustments of a head-office pair are
  ordinary transfers on `/accounting/intercompany/transfers`.

## API (`/head-offices`, CEO only: `requireAuth(...ADMIN_ONLY)`, module `tenants`)

The CEO only sees head offices and companies they are a member of — anything
else is **404**. Every write is one `serviceClient` transaction.

| Route | Rules |
|---|---|
| `GET /` | head offices the CEO belongs to, their live companies and switch state |
| `POST / {name, isTest?}` | Tenant (kind `head_office`), `TenantMember(CEO, owner)`, the standard chart (in the transaction — `ensureChartInTx`; boot's `ensureChartOfAccounts` keeps it complete), `HeadOfficeBooks` on its 6990 with recharge OFF, HR settings with employee codes `HO-` (`hr/service.ts saveSettings`) |
| `GET /:id` | links (live and ended), the split in force this PKT month, books status, the last 12 runs, the live head-office-wide hand-overs (for the link dialog, A12) |
| `PATCH /:id {name?, isActive?}` | switching off → 409 `HEAD_OFFICE_IN_USE` while it has a live link or any non-zero pair balance |
| `POST /:id/companies {companyTenantId, extendDelegationIds?, revokeDelegationIds?}` | member of both (else 404); the target must be an active **company** (422 `LINK_TARGET_NOT_A_COMPANY` — never a head office under a head office); test and real never mix (422 `TEST_COMPANY_MIX`); 409 `ALREADY_LINKED`; **A12:** every live head-office-wide hand-over must be listed as extend or revoke (422 `DELEGATIONS_UNANSWERED`), the revoked ones in the same transaction. Creates the pair accounts, the charges account and a NEW link row; clears the confirmation and switches recharge OFF |
| `POST /:id/companies/:companyId/end {reason, lastChargedPeriod}` | **A11:** 422 `RUN_AFTER_LAST_CHARGED` (listing the runs) while a draft, submitted or posted run line for the company exists after `lastChargedPeriod`. Stamps `endedAt` + `lastChargedPeriod`; revokes the company-scoped hand-overs ('company unlinked', A12); when no version starts in `lastChargedPeriod+1` and the one in force then lists the company, creates one without it through `createSplitVersion` (409 `SPLIT_PERIOD_IN_USE` applies); marks later draft runs stale; clears the confirmation and switches recharge OFF. Reach ends on the next request |
| `GET /:id/splits` | every version (+ how many runs use it) and the one in force |
| `POST /:id/splits {effectiveFrom, lines, note?}` | each company live-linked (422 `COMPANY_NOT_LINKED`); each share 1..10000 bps, total ≤ 10000 (422 `SPLIT_OVER_100`; below 100% the rest stays with the head office); 409 `SPLIT_PERIOD_IN_USE` while a submitted or posted run exists for `effectiveFrom` or later; 409 `SPLIT_EXISTS` for a second version in the same month; draft runs from that month go stale |
| `DELETE /:id/splits/:splitId` | only while no run references it (409 `SPLIT_IN_USE`) |
| `GET /:id/books` | settings, mapped accounts per live link, warnings |
| `PUT /:id/books/accounts {rechargeAccountId?, charges?[{companyTenantId, accountId}]}` | charges: an active expense in that company's chart, not controlled; recharge: an active expense or revenue in the head office's chart, not controlled; no posting-engine code (`ACCT.*`, `REQUIRED_ACCOUNT_CODES`) → 422 `ACCOUNT_RESERVED`, except 6990 as the recharge account; an account of another chart is 404 |
| `PUT /:id/books/pool` | ranges within 1000–9999, from ≤ to; codes are 4-digit strings |
| `POST /:id/books/confirm {note, taxAnswer}` | both ≥ 10 characters; 422 `BOOKS_INCOMPLETE` while the recharge account or a live link's charges account is missing / off |
| `PUT /:id/books/recharge {enabled, fromPeriod?, requireLockedPayroll?}` | enabling: 409 `ACCOUNTS_NOT_CONFIRMED`, 422 `FROM_PERIOD_REQUIRED`; switching off always works |

**Any change to the accounts, the pool or the links clears the CA confirmation
and switches recharge OFF in the same transaction** (`invalidateConfirmation`).
The DB backs the switch: CHECK `head_office_books_enable_chk` (recharge on needs
`accountsConfirmedAt` and `rechargeFromPeriod`).

## The rounding rule (`splitByBps`, pure)

Each company gets `floor(|base| × bps / 10000)` (computed as
`q × bps + floor(r × bps / 10000)` so it is exact up to `MAX_MONEY_CENTS` with
no bigint math). When the version totals exactly 100% the leftover paisa go to
the largest share (ties: the lowest company id) so the head office nets to
zero; below 100% the leftover stays with the head office. The base's sign is
re-applied (a negative base = credits to the companies) and zero lines are
dropped.

## Guards elsewhere

- `setup/routes.ts` (A17): an account referenced by
  `HeadOfficeBooks.rechargeAccountId` or any `HeadOfficeLink.chargesAccountId`
  cannot be switched off → 422 `ACCOUNT_MAPPED_TO_HEAD_OFFICE` (re-map it on
  the Books tab first). Renaming stays allowed.
- `lib/setup-config.ts primaryTenantId()` only ever picks a trading company.
- `headOfficeSetupApplied()` (books.ts) is the marker planning, HR and the
  admin read: until the setup wizard has run they behave exactly as today.

## Audit

Written in the head office's trail AND each touched company's trail:
`ho.create`, `ho.update`, `ho.link`, `ho.unlink` (identity — they change who
reaches what), `ho.accounts.map`, `ho.accounts.confirm`, `ho.pool.update`,
`ho.recharge.enable`, `ho.recharge.disable` (also when a change switches it
off), `ho.split.create`, `ho.split.delete` (accounting), and
`approval.delegation.revoke` for hand-overs a link or unlink revoked.

## Tests

`tests/headOfficeAdmin.test.ts` (CEO-only on every route, foreign → 404, HO
under HO, test/real mix, A12 link answers, confirmation cleared by account /
pool / link changes, the DB CHECK, A17, splits, A11 end-link, switch off) and
`tests/headOfficeSplits.test.ts` (the rounding rule).
