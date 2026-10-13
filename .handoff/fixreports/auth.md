All 11 findings are fixed (the eight original ones plus FOH-19 and UI-11), but three assertions in existing tests now fail and need small fixes in files I don't own (details below). Nothing is committed.

**Test results:** 172 passed, 3 failed, 4 skipped across my two new suites and all the existing auth, login, 2FA, OTP, invite, password, rider, waitlist, WhatsApp-config and reservations suites. Both new suites (`backend/tests/auditAuthPeople.test.ts`, 21 tests, and `backend/tests/auditAuthOnline.test.ts`, 9 tests) pass. `tsc` is clean for the admin app and for every backend file I touched.

**The three failures are old test fixtures, not bugs.** They invite or approve a cashier or cook with no phone, which PPL-05 now refuses:
- `tests/workspaces.test.ts` line 131: add a phone to the `role: 'boh'` invite.
- `tests/workspaces.test.ts` line 162: add a phone to the `role: 'cashier'` invite.
- `tests/accessControl.test.ts`: let `makeUser` take a `phone` (and write it), then give the pending cashier `p1` a phone at line 338.

I ran patched copies with exactly those changes: accessControl 25/25 and workspaces 7/7 pass. The copies are deleted.

**Two other failures you'll see are not from auth.** `customersReconcile` fails, and backend `tsc` reports errors in crm, reservations, reviews and storefront. Both come from another agent's ONL-04 change that makes loyalty accounts per company.

**What each finding does now:**
- **PPL-04 (fixed):** phones are stored in one normalised form, and a number already on another active or pending login is refused with 409 PHONE_IN_USE. This applies at invite, approve, create, edit and reactivate, across companies. The holder is named only to an operator who could see that login anyway. Suspended logins give up their number. The shared checks live in the new `auth/staffAccounts.ts`.
- **PPL-05 (fixed):** a cashier, FOH, kitchen or expediter login with no phone is refused (400 PHONE_REQUIRED) at invite, create and approve, and when an edit clears the number or moves someone into one of those roles. Reactivating an old phone-less login is still allowed; Workforce flags it "No phone".
- **PPL-06 + UI-11 (fixed):**
  - The staff list, edit, move, delete, approve, reject, password reissue and 2FA reset are now scoped to the operator's own companies, admins included. An empty scope lists nobody.
  - Company B's CEO gets 404 on company A's logins.
  - A login shared with a company the operator isn't in gets 403, because role, status and password apply across all its companies.
  - Creating or moving a login into another company gets 422.
  - Deletes are now audited.
  - Identity audit rows are filed under the target's company, with the actor's company in metadata.
  - New audit rows are written for 2FA reset, company moves, password change, PIN set and change, and manager-issued sign-in codes.
  - `tenants/routes.ts` `/mine` now lists only companies the operator belongs to.
- **PPL-10 (my part fixed):** the staff list returns each login's linked HR employee if payroll would still pay them. Workforce shows "Still on payroll" on suspended rows with a link to the HR record, and asks for confirmation when suspending someone still on payroll.
- **PPL-11 (fixed):** the state was already stored (`mustChangePassword`), but creating a login from Workforce never set it; it does now. Login and 2FA responses return the flag. I built `/account/password`, which changes the password through the existing signed-in endpoint and keeps the person signed in on that device.
- **PPL-14 (fixed):** a manager with no override PIN can set their first one by confirming their password; after that the current PIN is needed. Wrong attempts are rate-limited per account, and the screen is on `/account/password`.
- **FOH-19 (fixed):** a manager can tap "Sign-in code" on Workforce for floor staff in their own company whose role they manage (foh_management for cashiers and servers, boh_management for kitchen, management and the CEO for all). The code is shown on the manager's screen. It uses the same code record as the WhatsApp code, so it lasts 5 minutes, works once, and the cashier redeems it at the normal sign-in with the same attempt limits. Issuing is rate-limited per manager and audited. The sign-in page has an "I have a code from my manager" option, and the "cannot send codes" error now points at it.
- **ONL-10 (fixed):**
  - The phone is normalised before lookup, so `0300…` finds the existing `92300…` account.
  - No customer is created when a link is requested. A new contact gets a signed, single-use link, and the account is made when the link is followed.
  - Links are capped at 5 per contact per day, whatever IP asks.
  - Following one link twice at the same moment no longer gives two sessions.
- **ONL-11 (fixed):** when WhatsApp or email isn't configured, the server log gets only the channel, a masked recipient and the message type, never the body or subject. Nothing in the repo read codes or links from the log; tokens are read from the database.

**API changes callers will notice:**
- Signed-in password change now returns 200 with a fresh session (was 204), and a wrong current password is 400 (was 401).
- A wrong current PIN is now 400 (was 401).
- Creating a staff login needs an active or explicit company.
- Non-admin managers no longer see company-less staff rows.

**Needs other files or a decision:**
- `frontend/admin/src/app/team/page.tsx` still labels the phone "(optional)". The server's PHONE_REQUIRED message is shown, but the label should say it's required for till and kitchen roles.
- Nothing links to `/account/password` yet. It could be added to the user menu in `AppShell.tsx`.
- For the payroll side of PPL-10, `hr/service.ts` could warn when an employee's linked login is suspended.
- **Check the live database before Monday.**
  - Any active floor logins that share a number or have none will be refused at approve and at edits.
  - The CEO must be a member of every company they run, because the company switcher and staff list now use memberships only. Before this change, admins saw every company without one.
