# Head office — CEO and accountant runbook

Plain-language steps for the GS Head Office (the shared team that serves GS
Foods and GS x Viva): how it is set up, how its monthly cost is recharged to
the companies, how settlements work, how the CEO hands approvals over, how
people are moved, and how to roll back. Source of truth for the build:
`.handoff/fixes/D1D3-spec.md` section 14 and Amendment A1.

Everything here ships **OFF**. Nothing posts to any ledger until the CEO and
the CA have confirmed the books and switched recharge on.

## What it is, in one paragraph

A head office (HO) is a company of its own kind ("head_office") with its own
books and its own payroll. Each month the HO's **actual net cost** (debits
less credits on expense accounts 5000-6999, excluding its own recharge line
6990, taken from the HO ledger for the calendar month in Karachi time) is
shared between the companies it serves by a **percentage table** (the
split). The owner's split is **GS Foods 37.50% and GS x Viva 62.50%**. It is
charged at cost: no markup and no tax lines. Each company books a "Head office
charges" expense against a "Due to GS Head Office" liability; the HO books
"Due from <company>" against 6990. Money then moves by **settlements** on the
existing Inter-company transfers tab. Planning totals do not change: GS Foods
300k, JV 500k.

## 1. Before you start (collect these first)

Building and the deploy do not need them; **switching recharge on does**.

- The names and codes of the accounts (the screen shows them as "Confirm with
  your CA").
- The cost pool (default 5000-6999).
- The tax answer (section 3).
- The first month recharged (the cut-over month, K).
- The starting split.
- Which head-office staff keep direct access to a company.

## 2. The setup wizard (CEO, once, right after the deploy)

CEO workspace -> Companies & head offices -> **Set up head office from today's
records** (`/ceo/head-offices/setup`).

1. **Preview** shows, without changing anything: the active "head office"
   cost contributions; the head-office departments with their seats and
   employees; seats whose share differs from gross; the suggested split
   (GS Foods 37.50% / GS x Viva 62.50%, from 500k of 800k); planning before
   and after, per company.
2. **Apply** does, in one transaction: creates **GS Head Office**; links both
   companies; creates split version 1, effective this month; copies the
   departments and moves the head-office seats (share = gross); ends the old
   head-office contributions; writes the setup marker. A second run answers
   `SETUP_ALREADY_DONE`.
3. Planning totals stay the same. The old "is head office" flag and cost-share
   inputs are retired from the screens; the old tables are kept.
4. Optional, ticked by the CEO: add named HOD logins as members of GS Head
   Office now (membership only; their payroll still moves in month K).

Take a **database backup before applying**. It is not undone by a code
rollback (section 9).

## 3. Confirm the books with the CA, and the tax answer

Head office detail -> **Books** tab. Per company pair you see the four
accounts resolved to names in each chart. "Due from <company>" in the HO and
"Due to <HO>" in the company **are the pair's existing inter-company accounts**
(1450-1499 / 2150-2199, controlled `intercompany`, the same accounts the
inter-company transfers use; created if missing). Only two accounts are
head-office specific: "Head office charges" in the company (6200-6249) and the
HO's recovery account **6990** (the same account the shared-fleet recharge
uses). Codes 1400-1449 / 2100-2149 stay reserved and unused. A
yellow badge says "Confirm with your CA" until you confirm.

The **Confirm** dialog is a checklist: names and codes, the cost pool, the
percentage table, and the **tax answer**, which is required. v1 posts the
recharge **at cost with no sales tax or withholding**. Record the CA's answer,
for example "No tax on the recharge - CA confirmed <name>, <date>". If the CA
says the recharge is a taxable service, tax lines, a recharge invoice and a
company-side input-tax account must be built **before** recharge is switched
on. The same answer covers the fleet recharge.

Linking another company, or changing the accounts, clears the confirmation
and switches recharge OFF again.

## 4. Switch recharge on, and its first month

Books tab -> **Recharge** switch: enabled, **first month K**, and "require the
head office payroll to be locked". Enabling is refused
(`ACCOUNTS_NOT_CONFIRMED`) until the books are confirmed. A run can never be
submitted for a month before K (`BEFORE_CUTOVER`).

Month K is the first month the HO's own payroll is run from. The old companies
pay their staff through K-1. Do not switch recharge on for a month whose cost
is still in the companies' own books, or the cost is counted twice.

## 5. The monthly run and its approval (month K+1 onwards)

1. The month ends (Karachi time). The HO payroll for the month is **locked**.
2. The hourly worker **prepares and submits** the run when the month is ready.
   A person (HO preparer: admin, owner, management, finance who belong to the
   HO) can do it by hand from Finance -> Inter-company -> Runs: preview,
   prepare, refresh, submit, withdraw. The worker never posts.
3. The submitted run appears in **Approvals -> Finance** as "Head office
   recharge". The CEO opens it, reads the pool, the percentages and every
   line, and **approves** (ticking "post in open period" or "acknowledge
   warnings" only if the dialog shows them) or rejects with a note. A Finance
   delegate may approve only with a head-office-wide hand-over (section 7).
   The preparer or submitter can never approve their own run (the CEO is
   exempt).
4. Approval posts **both books in one transaction**. For each company: HO
   *Dr Due from C / Cr 6990*; company *Dr Head office charges / Cr Due to HO*.
   All or nothing; a refusal (period locked, account missing or inactive)
   rolls back both.
5. **True-up:** if the HO books a late cost after the run is posted, the
   difference is prepared as a **true-up** run. The CEO can **reverse** a run
   (CEO only), after which the month can be run again.
6. A month the worker found not ready by the 5th of the next month raises a
   `recharge_missing` flag; `recharge_drift` and `intercompany_mismatch` are
   raised daily.

Rounding: each company gets the floor of its share; with a 100% table the
leftover paisa go to the largest share, so the head office nets to zero. A
table under 100% leaves the rest with the HO as its own cost.

**Month-end order:** lock HO payroll, run approved and posted, settlements
recorded, reconciliation difference 0, close the **HO**, then the companies.
The period close has checks for all of this; the CEO can close over an
overridable block only with a written reason, and never over a trial-balance
failure.

## 6. Settlements (existing Inter-company transfers tab)

**Owner's choice: reuse the existing inter-company transfer engine.** There is
no second transfer table and no separate approval type. A settlement is an
`IntercompanyTransfer` created on **Finance -> Inter-company -> Transfers**
(`/accounting/intercompany/transfers`) with source `ho_recharge`, approved
there and in the inbox as "Inter-company transfer", and posted in both books
in one transaction. Only the monthly **run** is its own record.

- A company paying the HO (a cash move): from the transfers tab, a decrease of
  what the company owes with a bank account on both sides.
- The company paying a head-office bill on its behalf (for example rent): the
  rent then enters the HO pool and is recharged by the percentages.
- The HO paying a cost that belongs wholly to one company, or an opening
  balance: counters chosen by the CA. Counter accounts must be active, in the
  right chart and never controlled (`COUNTER_ACCOUNT_INVALID`).
- Who: HO and company preparers prepare; the CEO approves (never the
  preparer); only the CEO reverses.
- The pair balances (Due from / Due to) are the ordinary inter-company pair
  (1450-1499 / 2150-2199): they are tied out on the **Reconciliation** tab and
  by the daily `intercompany_mismatch` check, like any other company pair.
  They cannot be edited by hand-posted journals.

## 7. Hand-over of approvals (grant and revoke)

Initially every head-office HOD submits and the **CEO approves**. Later the
CEO may hand a whole section to a person, per head office (whole HO or one
company), per section (Operations, Procurement, Finance, Marketing, HR, Dev),
with an optional end date. The CEO workspace -> Approvals -> **Hand-over**.

- **Grant**: choose the head office, the whole HO or one company, the
  section, optionally the exact types, the person (the list shows only eligible
  people), an end date and a note. The person must be an active member of that
  HO, not an admin, and must hold the module the type needs. A company can be
  handed to only one head office per section.
- **Revoke**: any time, with a reason. There is no edit: revoke and grant
  again.
- Checked live at every approval: expiry, revocation, unlinking the company,
  leaving the HO, losing the module all stop it on the very next click.
- **Never hand over:** the CEO section (cash requests, fixed-asset requests,
  bad debts, Raast voids, GRNI write-offs, stock differences, on-account
  clients, brands, company-wide rules); manual journals of kind post are
  locked in v1; the head-office recharge only by an HO-wide Finance grant.
  Reversals, payroll covering the approver's own payslip, and going live
  stay with the CEO.
- The delegate's own submissions still go to the CEO.

## 8. Moving people to the head office

CEO workspace -> Head office detail -> **People** -> "Move people to head
office" (preview, then apply). Prerequisites: the head office's EOBI/SESSI
registration, bank account and NTN.

- The effective date is the **first of a month (K)**. The old company pays
  through the month before; the HO payroll runs from K.
- The move refuses: an employee not active in a linked company
  (`NOT_IN_LINKED_COMPANY`); an outstanding loan (`TRANSFER_LOAN_OUTSTANDING`);
  open HR records (`TRANSFER_OPEN_RECORDS`); an approved or locked old payroll
  for K or later that includes them (`TRANSFER_PAYROLL_CONFLICT`). A draft
  payroll is only warned about.
- It creates the HO employee (joining date kept), carries leave balances,
  marks the old record **transferred** (no login is switched off), moves the
  login to the head office, and removes company memberships except those you
  tick to keep. Their seat moves to the HO.
- After the move, head-office people **see** the companies they serve
  ("through <head office>") and **send changes for approval**; any other write
  to a reached company is refused (`HEAD_OFFICE_SUBMIT_ONLY`). Direct changes
  need explicit membership of that company, which is the CEO's decision.
- A person with their own payslip in a payroll run cannot approve it; the HO's
  own payroll always goes to the CEO.

## 9. Rollback caveats

- **Code-only rollback:** older images ignore the new tables and columns. A
  head office then behaves like an empty company, and head-office staff lose
  reach (the safe direction). The protection on head-office accounts is lost,
  so a stray hand-posted line will show in reconciliation after rolling
  forward again.
- **Posted recharges** are ordinary balanced entries. Reverse them in servd
  first if they must be undone.
- **Not undone by a code rollback:** the wizard's moved seats and ended
  contributions, and staff transfers. Back up the database before the wizard
  and before moving people.
- Do not roll the API image back below the release that introduced the
  head-office tables once a run has posted.
