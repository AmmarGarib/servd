import os, sys, re
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from common import SP, DECISIONS, WAVE0, RULES_BACKEND, RULES_UI, REPORT, HEADER
from agents_w1 import W1
from agents_w2 import W2
from agents_w3 import W3
from agents_w4 import W4

WAVES = [("W1", W1), ("W2", W2), ("W3", W3), ("W4", W4)]
ALL = W1 + W2 + W3 + W4

ids = [a["id"] for a in ALL]
assert len(ids) == len(set(ids)), "duplicate agent id"
idxs = [a["idx"] for a in ALL if a["idx"] is not None]
assert len(idxs) == len(set(idxs)), "duplicate redis index"
assert all(0 <= i <= 31 for i in idxs), "redis index out of range"
for a in ALL:
    for k in ("id", "wave", "area", "idx", "title", "summary", "owns", "read", "tasks", "consumes", "exposes", "tests"):
        assert k in a, (a.get("id"), k)


def db_of(a):
    return "servd_test_wb_" + a["id"].replace("-", "_")


def kind_of(a):
    if a["id"] == "w4-docs":
        return "docs"
    return "backend" if a["idx"] is not None else "ui"


def testenv(a):
    k = kind_of(a)
    if k == "backend":
        return ("Test DB **`%s`** · Redis **`redis://127.0.0.1:6390/%d`** (index %d) — yours alone" % (db_of(a), a["idx"], a["idx"]))
    if k == "docs":
        return "Docs agent — no database, no tests to run"
    return "UI agent — no database, no tests to run"


def sp(text):
    return text.replace("SCRATCH", SP)


RULES_DOCS = r"""
## Rules for this docs agent (CLAUDE.md applies in full)

1. **Ownership.** Edit ONLY the files listed under "You own". If a code comment or another agent's README is wrong, say so in your report.
2. Document what the code on disk DOES (W1-W3 are merged when you start); where code and plan differ, the code wins — note the difference.
3. Plain English, no emoji, no secrets, no card codes, no real phone numbers, no customer data. Brand names: Stackd, Simmer, Flipd.
4. No builds, no tests, no commits.
"""

NEXT_WAVE_NOTE = {
    "W1": "Files you own may be edited again by a LATER wave's owner (see shared-files.md): leave clean seams and say in your report what the next owner must know.",
    "W2": "W1 is merged: code against the W1 contracts as they are ON DISK (read the files). Files you own may change hands in W3/W4 (shared-files.md).",
    "W3": "W1 and W2 are merged: code against their contracts as they are ON DISK (read the files). Files you own may change hands in W4 (shared-files.md).",
    "W4": "W1-W3 are merged: code against the API and helpers as they are ON DISK (read the files). Nothing after you edits your files except the orchestrator in wave Z.",
}


def bullet_list(items):
    return "\n".join("- `%s`" % i if not i.startswith("existing") and not i.startswith("admin READMEs") and "(grep" not in i else "- %s" % i for i in items)


def brief(a):
    k = kind_of(a)
    head = HEADER.format(id=a["id"], title=a["title"], wave=a["wave"], area=a["area"], testenv=testenv(a), sp=SP)
    head = head.replace(" (SCRATCH = `%s`)" % SP, "")
    parts = [sp(head)]
    parts.append("## Your job in one line\n\n%s\n\n%s\n" % (a["summary"], NEXT_WAVE_NOTE[a["wave"]]))
    parts.append(sp(DECISIONS))
    parts.append(sp(WAVE0))
    parts.append("## You own (edit only these)\n\n" + bullet_list(a["owns"]) + "\n")
    parts.append("## Read first\n\n" + "\n".join("- " + sp(r) for r in a["read"]) + "\n")
    parts.append("## What to build\n" + sp(a["tasks"]))
    parts.append("## Contracts you consume (already on disk when you start)\n" + sp(a["consumes"]) + "\n")
    parts.append("## Contracts you expose (later waves code against these — keep the names and signatures)\n" + sp(a["exposes"]) + "\n")
    if k == "backend":
        cmd_db = db_of(a)
        parts.append("## Tests\n\nYour database: `%s`. Your Redis: `redis://127.0.0.1:6390/%d`. Command (from `backend/`, your files only):\n\n"
                     "```\nDATABASE_URL=postgresql://postgres@127.0.0.1:5432/%s REDIS_URL=redis://127.0.0.1:6390/%d "
                     "JWT_SECRET=test-secret-for-local-verification-only-not-a-real-key "
                     "JWT_REFRESH_SECRET=test-refresh-secret-for-local-verification-only "
                     "SERVD_SECRET_KEY=$(node -e \"console.log(Buffer.alloc(32,7).toString('base64'))\") NODE_ENV=test "
                     "npx vitest run tests/<file>.test.ts …\n```\n%s\n" % (cmd_db, a["idx"], cmd_db, a["idx"], sp(a["tests"])))
        rules = RULES_BACKEND.replace("DBNAME", cmd_db).replace("REDISIDX", str(a["idx"]))
        parts.append(sp(rules))
    elif k == "docs":
        parts.append("## Checks\n" + sp(a["tests"]))
        parts.append(RULES_DOCS)
    else:
        parts.append("## Checks\n" + sp(a["tests"]))
        parts.append(sp(RULES_UI))
    parts.append(REPORT)
    return "\n".join(parts)


def digest(tasks, limit=230):
    out = []
    for line in tasks.strip().splitlines():
        s = line.strip()
        if not s:
            continue
        if s.startswith("**") or s.startswith("- ") or re.match(r"^\d+\. ", s):
            t = s if len(s) <= limit else s[:limit].rstrip() + " …"
            out.append("  - " + t.lstrip("- "))
    return "\n".join(out)


W0_CHECKLIST = r"""
## Wave 0 — the orchestrator alone (serial; nothing fans out until all of this is green)

0. **Owner inputs.** Confirm owner Q1 (EOBI/SESSI/salary-tax challans: default = HR's eobi_challan form retired, finance records them in the tax-payments
   register). Everything else builds on the stated defaults (section "Owner / accountant questions" below) — none blocks the start.
1. **Test infrastructure.** Postgres at 127.0.0.1:5432 (user postgres). Create one database per backend agent (names in the wave tables:
   `servd_test_wb_<id with underscores>`; every name contains 'test' as tests/setup.ts requires). Start ONE Redis for the whole build:
   `redis-server --port 6390 --databases 32 --save '' --appendonly no --daemonize yes` (32 databases — the default 16 is not enough). Each backend
   agent owns one index (0-26). Never point an agent at another agent's DB or index, never at production.
2. **Schema** — exactly `schema-merged.prisma.md`: edit `backend/prisma/schema.prisma`; write `prisma/migrations/20261014085900_finance_wave_b_enums/
   migration.sql` (enum ADD VALUE only — never used inside either migration) and `20261014090000_finance_wave_b/migration.sql` (header with the P3009
   runbook, DDL, backfills §4 in order, partial uniques §5, CHECKs §6, RLS §7); `prisma validate`; `prisma generate`. **Migration dry run:** on a
   scratch DB built with `prisma db push` from the PREVIOUS schema (git stash) plus a few rows per touched table, apply the two migration files with
   `psql -v ON_ERROR_STOP=1 -f …` in order, then `prisma migrate diff --from-url <scratch> --to-schema-datamodel prisma/schema.prisma --exit-code`
   must show no drift beyond the SQL-only objects; run each backfill twice (idempotent).
3. **Chart + journal** — exactly `chart-merged.md` (chartOfAccounts.ts: codes, renames, reserved-range header, REQUIRED, `controlledBy`,
   `assertTemplateAccounts`, `REGISTER_CONTROLLED_CODES`; journal.ts: ACCT names, TILL_CLEARING_CODES, ON_ACCOUNT_MEMO, CONTROLLED_PREFIX, the
   controlled-account rule with `controlledOverride`, `lateDatingFor`).
4. **Shared libs** — `shared-files.md` §A, every item marked w0: sourcePosting.ts (`keepLiveDate`, tx-aware `liveRevision(s)`), bankAccounts.ts
   (`ledgerBalancesByCode` asOf), exceptions.ts (every new ExceptionKind), lib/inventoryClass.ts, lib/savepoint.ts (+ the import swap in
   orders/service.ts), lib/evidenceFile.ts (+ the import swap in cashVouchers.ts), lib/onAccountCard.ts, accounting/closeCheckTypes.ts,
   accounting/fiscalYear.ts (pure part), lib/tenders.ts, approvals/types.ts, lib/moduleAccess.ts (module ids food_cost + emergency_overrides,
   defaults, MODULE_GRANTS, GATED_PREFIXES insertions in the stated order), lib/workspaces.ts, reconciliation/routes.ts (+ the three stub child
   plugin files), reconciliation/backfillOrders.ts (exports only), packages/types order fields.
5. **Tests base** — tests/setup.ts seeds every template code (ensureChartOfAccounts for the test companies helper) and applies §5-§6 SQL from the
   migration file after `db push`; tests/moneyBigint.test.ts EXPECTED_BIGINT_FIELDS += schema §3.38 (50 → 92) with the count from the DMMF.
6. **Admin shared** — lib/appRoles.ts, lib/moduleCatalog.ts (all area entries + MODULE_GAPS rewrites; no ModulePage.roles), next.config.js redirect
   /accounting/food-cost → /reports/food-cost, app/exceptions/page.tsx labels.
7. **Verify** — `npx tsc --noEmit -p .` in backend and frontend/admin clean; run tests/moneyBigint, the module-access / workspace suites
   (grep tests/ for MODULE_GRANTS, GATED_PREFIXES, workspaces) and one posting suite on a w0 database; commit on main ("wave B w0").
8. **Launch W1** — all W1 agents in ONE message, `model: "opus"`, each told only: "Your brief is `SCRATCH/briefs/<id>.md` — read it in full and follow it."
"""

GATE = r"""
## Gates between waves (orchestrator; after W1, W2 and W3)

1. Collect every report. Apply patch notes to orchestrator-owned files at once; patch notes for a file a LATER agent owns are appended to that agent's
   brief under "Patch notes to apply first" before it launches. Conflicting notes → decide, record the decision in the next briefs.
2. For each backend agent: rerun its exact test command on its own DB; `npx tsc --noEmit -p .` in backend (and frontend/admin if touched). Red →
   resume that agent (SendMessage) with the failure; never patch around it silently.
3. Personal review (CLAUDE.md: money, tax, auth and tenant isolation are never delegated below the orchestrator):
   - after W1: lib/stockLedger.ts (FIFO maths, exact closure, company checks), lib/withholding.ts, fixedAssets chargeThrough + events postings,
     intercompany postings (both books, one tx), card-payout split, ban promotion per company, delivery-fee tax maths + fiscal payload, reroute.
   - after W2: recipe explosion + packaging by order type / vessel / Box given, cancel / void / return semantics in orders/service.ts, supplierPosting rewrite + cut-over,
     orderPosting / shiftPosting COGS + 4110, capexPosting, salesTaxReturn, on-account exposure + write-offs, codPosting, pettyCashPosting, close checks.
   - after W3: chargeOrderToAccount + every on_account refund writer, till-clearing cut-over, opening counts → 3020, returnedFood, settlement poster +
     H3 auto-conversion, depreciation worker.
4. Commit on main per wave ("wave B W1" …). Launch the next wave in ONE message.
"""

WZ_CHECKLIST = r"""
## Wave Z — the orchestrator alone (after W4)

1. **backend/src/index.ts registrations** (+ any extra snippet agents reported): foodCostRoutes at '/reports/food-cost' BEFORE reportRoutes;
   grniRoutes '/procurement/grni'; withholdingRoutes '/accounting/withholding'; statutoryRoutes '/accounting/statutory'; intercompanyRoutes
   '/accounting/intercompany'; customerAccountRoutes '/accounting/customer-accounts'; posOnAccountRoutes '/pos' (second plugin); posBoxGivenRoutes '/pos' (third plugin); emergencyOverridesRoutes
   '/emergency-overrides'; banAppealRoutes '/storefront'. (fixedAssets requests/pools plugins register inside fixedAssets/routes.ts; the reconciliation
   child plugins inside reconciliation/routes.ts.) Check each path against its GATED_PREFIXES rule.
2. **Workers** (inside workersEnabled): startDepreciationWorker (03:20 PKT), startIntercompanyFleetWorker (03:40), startTillClearingSweepWorker (03:10),
   startCashAdvanceOverdueWorker (09:10), startOnAccountDailyWorker (09:20), startCodCustodyWorker (every 30 min); comment on startGiftCardExpiryWorker
   ('posts breakage').
3. **Boot** (per company, after ensureChartOfAccounts, each in its own try/catch, logged): ensureAssetClasses + reclassLegacyAccumulated;
   ensureFifoCutover (before listen); sweepTillClearing({ mode: 'cutover' }) once (Setting marker); applyModuleGrants already runs (MODULE_GRANTS
   now includes food_cost + emergency_overrides).
4. **/health:** fixedAssets (fixedAssetTieOut + last FixedAssetRun per company), fifoCutover (every company cut over; company-less items with stock
   listed), pettyCash tie-out (floats vs 1011, advances vs 1355), chartTemplateTypes, tillClearing (marker + open till_clearing_unexpected), statutory
   reclass pending (warn), cardPayouts unsettled (warn).
5. **CLOSE_CHECKS:** add prepaidCloseChecks (w2-fa-capex) and inventoryCloseChecks (w3-fc-report) to the array w2-close built.
6. Apply every remaining patch note; replace the two W1 'guarded' dynamic imports of files that only arrived in W2 (lib/stockLedger.ts →
   inventory/fifoCutover.js ensureFifoCutover; fixedAssets/events.ts → financePlanning/capexPosting.js capexAdvancesForLine) with plain typed
   `await import('<literal path>')` calls (keep them dynamic — the static form would be an import cycle) and confirm tsc still passes; grep that the
   deprecated aliases (runDepreciation, ASSET_CATEGORIES, the postWasteLog / postStockCount re-exports,
   readers of the retired Recipe.packagingPct column (management's new packagingPct KPI field is fine), servedWhen, plateWearPct, '/recipes/food-cost', '/dispatch/orders/:id/delivered', '/orders/:id/cod-unpaid',
   '/orders/:id/refused-at-door', '/trustops/orders/:id/otp', '/apply-missed-bill-variances', 'disburse') are gone everywhere (backend, admin,
   tablet, rider, storefront, mobile, tests, .sim).
7. **CLAUDE.md** — the sections listed in shared-files.md §A (Fixed assets v2; Food cost and stock incl. THE packaging rule; Tax decisions H8-H13;
   People, close and inter-company; Cash requests + petty cash in the ledger (replaces "Cash vouchers"); Delivery code-only + Emergency overrides
   (rewrite BOTH Own-fleet bullets); On-account clients, bad debts, Raast void + the rollback caveat; amend the Raast "Tenders" bullet; rewrite the
   BOOKS-06 sentence about postSupplierBill; remove C1/C2/C5, G1-G14, F*, K* from "Pending owner/CA decisions" and record the H1-H30 defaults in force;
   add TODO(asset-sale-tax)).
8. **Full verification:** the whole backend suite on one fresh DB (serial, as vitest is configured), then the RLS suites with RLS_ENFORCE=1;
   `npx tsc --noEmit -p .` in backend, frontend/admin, frontend/storefront, tablet, mobile, rider; `next build` for admin and storefront (never next to
   a dev server — they share .next); screenshots per the UI agents' checklists (admin at phone width too); repeat the wave-0 migration dry run with the
   final schema.
9. **Ship:** commit + push to main; CI builds the three images; the webhook deploys; check https://api.servd.pk/health on the box (fixedAssets,
   fifoCutover, pettyCash, tillClearing). **Rollback caveat:** once an on_account payment or a voided Raast receipt exists, the API image must not roll
   back below this release (an older Prisma client throws on the new enum values); the WhatsApp / SMTP key caveat stands as before.
10. **Go-live worklist for the owner:** recipes in production without a packaging line (the recipes list filter 'No packaging') — the F&B manager
    adds them; the WHT rate table (placeholders until finance confirms the Finance Act rates; withholding stays OFF per company until switched on);
    card-payout settings per company; the CEO's FIFO alignment (dry run first); the petty-cash history backfill (dry run first).
"""

FOLLOW_UPS = r"""
## Follow-ups (separate tasks — NOT built in wave B; spawn them as suggestions after wave Z)

- 'petty_cash' as a payment source for OpEx / CapEx / HR loans (moneyAccountCode option + recordPettyCashSpendTx) — CA critic 13 (assumption recorded).
- The manager vs FINANCIALS_VIEWERS / ModulePage.roles access mismatch — FA critic 9 (raised, not changed here).
- Per-outlet stock pools (owner: the NEXT build) — lots, waste, counts and receipts already carry locationId.
- Moving the remaining route reads from serviceClient to the RLS client (the RLS read-client switch).
- TODO(asset-sale-tax): sales tax on fixed-asset disposal proceeds.
- Card payouts per Keenu MID (CardSettlement.unit 'brand' / 'terminal') once the owner confirms how many MIDs each company has.
- D1 head office (ranges 1400-1449 / 2100-2149 / 6200-6249 reserved; 6990 shared; source 'ho_recharge').
- Mobile delivery with a pin picker (expo-location) — mobile is pickup-only until then.
"""

OWNER_QS = r"""
## Owner / accountant questions — each is BUILT on the default shown; one switch point each

| # | Question | Default built |
|---|---|---|
| P | Packaging (FINAL owner rule): takeaway/delivery use the recipe's packaging; a packaging-vessel brand (Stackd) uses it on every order; dine-in at a plate brand only when staff tap "Box given". | Built (decision P1). Brand create requires the service vessel. |
| Q1 | EOBI / SESSI / salary-tax challans: finance's tax-payments register, HR form retired? | Retired; finance records them (confirm before W1) |
| IC-Q2 | Shared-fleet charge basis | CEO-set rate per trip (FleetRate) |
| IC-Q3 | Fleet charge: cost recovery (no tax) or taxable revenue? | Cost recovery, Cr 6990 |
| IC-Q4 | Inter-company settlements: finance prepares, CEO approves? | Yes (approvals type intercompany_transfer) |
| IC-Q5 | TenantContribution: post monthly or planning only? | Planning only (not posted) |
| DL-Q1 | Is the RGM foh_management? | Yes — foh_management gets Emergency overrides |
| DL-Q2/Q3 | Reroute sends a NEW code; also shown in the rider app? | New code; shown in the app as a fallback |
| DL-Q4 | Customer unreachable: strike? | No strike (only refusals) |
| DL-Q5 | Prepaid online order whose food came back | The manager decides through the existing cancelled-ticket hand-back |
| DL-Q6/Q7 | Lifting a ban keeps strikes? Recycled number freed? | Keep strikes; release-contact frees the number |
| DL-Q8 | Riders on servd payroll? | No — COD owed sits on 1351, recovered at the till |
| DL-Q9 | Blocked customer can still sign in? | Yes, with the notice and the appeal |
| OA | GST rate on account; who approves clients and limit increases; block or warn when overdue; loyalty earn; CEO-raised write-off | Cash rate; the CEO; block; no earn; applies at once |
| FA | Should EVERY capitalisation (incl. smallwares Quick buys) need the CEO? | Yes — finance prepares, the CEO approves |
| TX | One Keenu MID per company or per brand? | Per company (unit 'company') |
| TX | WHT rates (Finance Act) | Placeholder table, withholding OFF until finance switches it on per company |
| TX | Fiscal vendor: DELIVERY-CHARGE line and on_account (PaymentMode cash) accepted? | Built; confirm with the POS vendor before go-live |
| FC-(c) | Stock cooked before its delivery is entered | Settled against the next lot within 7 days (shortfall settle) |
| FC-(d) | Items on no recipe (oil, salt) | 'Issue on receipt' per item (off by default) |
| FC-(e) | Who may enter opening stock (posted to equity) | finance, CEO, management |
| Hasnain | FIFO cut-over alignment difference: 3020 (prior period) or 5050? | 3020, shown on its own line |
| Hasnain | H1-H30 | In force as listed in every brief; each one is a single switch point |
"""


def build_waves():
    out = []
    out.append("# Wave B — build waves (the orchestrator's master plan)\n")
    out.append("Scratch: `%s`. Inputs: schema-merged.prisma.md, chart-merged.md, shared-files.md, briefs/<agent-id>.md (one self-contained brief per "
               "builder — launch each agent with only its brief path). All builder agents run on Opus (`model: \"opus\"`, CLAUDE.md). Every file has ONE "
               "owner per wave (shared-files.md). Backend agents test on their own Postgres DB `servd_test_wb_<id>` (127.0.0.1:5432, user postgres) and "
               "their own Redis index on `redis://127.0.0.1:6390/<idx>`; UI and docs agents run no tests (tsc only). No agent runs builds, dev servers, "
               "the whole suite, production calls or commits.\n" % SP)
    out.append("**Packaging (FINAL owner rule, 2026-10-13):** every plate recipe has an optional Packaging section; a sale uses it for takeaway / "
               "delivery, on every order of a packaging-vessel brand (Concept.serviceVessel, required at brand create; Stackd), and on a dine-in "
               "line only when staff tap 'Box given' (OrderItem.boxGiven); target MC per order type follows the same rule; the Q factor stays the "
               "only pricing allowance; one seam `packagingApplies(order, line)`.\n")
    out.append("## Summary\n")
    out.append("| Wave | Agents (parallel) | Backend DB / Redis |\n|---|---|---|")
    out.append("| W0 | orchestrator — schema, chart, shared libs, stubs, test base, admin shared files | — |")
    for w, agents in WAVES:
        out.append("| %s | %s | %s |" % (w, ", ".join(a["id"] for a in agents),
                                          ", ".join("%s→%d" % (a["id"], a["idx"]) for a in agents if a["idx"] is not None)))
    out.append("| WZ | orchestrator — index.ts, workers, boot, /health, CLOSE_CHECKS, CLAUDE.md, full suite, builds, screenshots, ship | — |\n")
    out.append(sp(W0_CHECKLIST))
    for w, agents in WAVES:
        out.append("\n---\n\n# %s — %d agents in parallel\n" % (w, len(agents)))
        out.append("| id | area | DB | Redis |\n|---|---|---|---|")
        for a in agents:
            k = kind_of(a)
            out.append("| %s | %s | %s | %s |" % (a["id"], a["area"], ("`%s`" % db_of(a)) if k == "backend" else "— (%s)" % k,
                                                 ("6390/%d" % a["idx"]) if k == "backend" else "—"))
        out.append("")
        for a in agents:
            k = kind_of(a)
            out.append("\n## %s — %s\n" % (a["id"], a["title"]))
            out.append("Area: %s · %s · brief: `briefs/%s.md`\n" % (a["area"], testenv(a), a["id"]))
            out.append("%s\n" % a["summary"])
            out.append("**Owned files**\n\n" + bullet_list(a["owns"]) + "\n")
            out.append("**Tasks (outline — full text in the brief)**\n\n" + sp(digest(a["tasks"])) + "\n")
            out.append("**Consumes**\n" + sp(a["consumes"]) + "\n")
            out.append("**Exposes**\n" + sp(a["exposes"]) + "\n")
            label = "Tests" if k == "backend" else "Checks"
            extra = (" — run on `%s`, Redis index %d" % (db_of(a), a["idx"])) if k == "backend" else ""
            out.append("**%s%s**\n%s\n" % (label, extra, sp(a["tests"])))
        if w == "W1":
            out.append(GATE)
        elif w in ("W2", "W3"):
            out.append("\n## Gate after %s\n\nRun the gate steps above (section 'Gates between waves'), with the personal-review list 'after %s'; then launch the next wave in ONE message.\n" % (w, w))
    out.append(WZ_CHECKLIST)
    out.append(FOLLOW_UPS)
    out.append(OWNER_QS)
    return "\n".join(out)


def main():
    os.makedirs(os.path.join(SP, "briefs"), exist_ok=True)
    for a in ALL:
        with open(os.path.join(SP, "briefs", a["id"] + ".md"), "w") as f:
            f.write(brief(a))
    with open(os.path.join(SP, "build-waves.md"), "w") as f:
        f.write(build_waves())
    print("agents:", len(ALL), "backend:", sum(1 for a in ALL if kind_of(a) == "backend"))


if __name__ == "__main__":
    main()
