All nine findings are fixed. Nothing is committed. There are 28 new regression tests in three new files, and all of them pass. Of the 284 tests in my files plus the existing suites that cover the files I touched, 280 pass. The 4 failures are in sign-in and invite flows (`auth/*`) that another agent is changing (details under "Other files"). `tsc` shows 0 errors for both backend and admin.

**Findings**

- **PPL-01, a tip paid twice (fixed).** A new pool whose period overlaps another pool of the same brand is refused with a 409 that names the existing pool. The check happens under a per-brand lock. Pool windows now include the start time but not the end time, so two back-to-back pools don't share any orders.
  - Posting or paying a pool is refused (409) if an overlapping pool of the brand is already posted or paid. That covers duplicates created before this fix.
  - Paying marks the pool paid and posts the ledger entry in one step, so a double click gets 422 and only one entry is posted.
  - I added `DELETE /tip-pools/:id` for draft pools, so a mistaken draft can be redone, and a "Delete draft" button on the tip-pools page.
  - Marking each pooled order with its pool would need a new column on orders. I didn't add it; the overlap rule does the job without it.
- **PPL-02, a Stackd pool paying Flipd staff (fixed).** Pools now count only hours worked at the brand's branches. A shift's branch is the one its punch matched, otherwise the person's HR branch. A shift with no known branch counts only when the company has just one brand.
  - If the company has several brands and this brand isn't linked to any branch, creating a pool returns 422 `BRAND_HAS_NO_BRANCH`.
- **PPL-03, forgotten clock-out (fixed).** An open clock-in counts as a missed clock-out once it is 16 hours old, or 12 hours old and from an earlier Karachi day. A shift running past midnight still counts as in progress.
  - When that happens, the old day is marked `missing_punch` with no hours, and today's clock-in goes ahead.
  - A late clock-out is never paired with the old clock-in (the cause of the 25-hour shift).
  - The status screen now uses the same rule, so it matches what the clock does. The kiosk follows it too.
  - Tip pools ignore any span over 16 hours, which covers bad pairs already stored. HR's attendance corrections are counted once approved.
  - The time-clock page now tells the person their last clock-in was never closed.
- **PPL-07, negative salary (fixed).** Negative money is refused on employee records and HR records whatever a company's own form says. The only exception is "Other adjustments" on full & final settlements. Basic salary above gross is refused.
  - Approving or locking a payroll run is blocked if any payslip comes to less than zero; the message names the people.
  - Marking a run paid now pays exactly what the lock booked to Wages Payable (2020), so 2020 clears to zero.
- **PPL-08 and BOOKS-02, sidebar vs API (fixed for the routes I own).** `/finance`, `/projections` and `/tip-pools` are now gated by the capital, projections and payroll modules. `/hr/payroll` accepts `staff_hr` or `payroll`.
  - Finance can now read capital, projections, tip pools and the payroll register (runs, payslips, bank file). It can also create and edit projections. Finance cannot prepare, approve or pay payroll, and cannot write CapEx.
  - HR can now reach tip pools.
  - BOH managers get the Rota module, since the rota routes already let them in.
  - A test checks every role against these modules: the page loads if the role's defaults include the module and returns 403 if not.
- **PPL-10, switched-off login still paid (fixed).** A payroll run now warns by name when an employee's login is switched off but HR still has them active. It also warns when someone is terminated with no last working day.
- **PPL-12, shift on a leave day (fixed).** Adding or editing a rota shift on a day of approved leave returns 409 `ON_LEAVE`, and "copy week" skips those days. Half-day leave and marking a day off are still allowed. There was no existing manager override flag, so I didn't add one; to roster someone, the leave is shortened or cancelled in HR first.
- **PPL-13, staff shift swaps (fixed).** Staff can now request a swap from My HR. It is always their own shift, with a current colleague at the same branch in the same company, for today or a later day. Their reporting manager approves it.
- **PPL-15, leaver sweep (fixed).** The sweep now uses the standard suspend helper, so the login shows as suspended. It also finishes off older logins that were only switched off through `isActive`.

**Decisions for you**
- FOH, BOH and F&B managers lose capital, projections and tip pools, which is what the audit expected. If floor managers should draft tip pools, the CEO can grant them the payroll module in Module Access.
- Finance gets full projections access but read-only capital.

**Tests added** (in `/home/user/servd/backend/tests/`):
- `auditPeopleTips.test.ts`: 11 tests
- `auditPeopleHr.test.ts`: 11 tests
- `auditPeopleAccess.test.ts`: 6 tests

They use two companies throughout, and company B gets 404 on company A's pools, payroll runs, projections and swap approvals.

The existing suites that cover these files pass: hrModule, attendanceRota, apAging, auditSplit, booksReports, booksReconcile, sepFinance, auditAccounting, dedupeSmall. In `accessControl` and `workspaces`, the module-access tests pass. The 4 failures there are sign-in and invite flows, listed below.

**Other files that need changes**
- **4 failing tests in `auth/*` (another agent's area):** `accessControl.test.ts` "deactivating from Workforce…" and "approve and reject are audited", and `workspaces.test.ts`'s two team-invite tests. A floor invite without a phone now gets 400, which looks like the PPL-05 fix, and the `PATCH /auth/users` response shape changed. These tests passed in my first run and none of my files are involved; that agent needs to update them.
- **Gift cards (not mine, still blocking BOOKS-02):** `giftCards/routes.ts:46,187` still only allow managers, so finance gets 403 on Gift cards. It needs the finance team added; the module gate already stops other roles.
- `reports/*` refuses finance on `/reports/top-items` even though finance holds the reports module.
- `auth/routes.ts`: `GET /auth/users` refuses HR, which holds `staff_directory`.
- `/positions/summary` refuses HR, and the OpEx page's `/opex` routes refuse finance.
- `frontend/admin/src/lib/moduleCatalog.ts` needs a "Payroll register" link to `/hr/payroll` under the `payroll` module so finance can find it in the sidebar.

Other changed files:
- `backend/src/lib/moduleAccess.ts`
- `backend/src/modules/tipPools/routes.ts`
- `backend/src/modules/timeclock/service.ts`, `routes.ts`
- `backend/src/modules/hr/attendance.ts`, `forms.ts`, `routes.ts`, `service.ts`, `ledger.ts`, `separations.ts`
- `backend/src/modules/scheduling/routes.ts`
- `backend/src/modules/projections/routes.ts`
- `backend/src/modules/financePlanning/routes.ts`
- `frontend/admin/src/app/tip-pools/page.tsx`, `hr/me/page.tsx`, `time-clock/page.tsx`
