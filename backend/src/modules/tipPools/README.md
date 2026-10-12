# tipPools

Backend module: **tipPools**. HTTP routes + business logic for the Tip Pools domain. Registered into Fastify by `src/index.ts` under the `/tipPools` URL prefix.

## Files

- `routes.ts` — Fastify route registrations for this module

## Company scope and members (HR-R7, 2026-10-12)

- A pool carries its company (`TipPool.tenantId`): created in the operator's
  ACTIVE company for one of its brands (`BRAND_NOT_IN_COMPANY` 422 otherwise);
  reads are view-aware, edits use the write scope, foreign pools are 404. The
  pool's own company takes the payout entry, the audit rows and the flags.
- A member is a login (`userId`) or an HR employee with no login
  (`employeeId`) — exactly one (CHECK). No-login staff — including an HR
  record whose login was deleted or is not of this company — come from the
  company's attendance punches. Their role is read strictly (`hrRoleKey`):
  a tip role named as a whole word in the designation, nothing that names a
  non-tip job (driver, guard, maintenance…); an unrecognised designation is
  unknown (the department is read only when there is no designation, and
  only an exact Kitchen / Main Kitchen / BOH / FOH / Front or Back of House).
  Unknown role → `no_role`, with ALL their hours in the window (placed, no
  known branch, still on shift): posting waits until they are added on the
  draft (`POST /:id/members`) or left out by name (`leaveOutStaff`). Every member must be of the pool's company.
- Payout: one entry for the pool (Dr 2095 / Cr cash or bank of the pool's
  company); each share is on its member row (name snapshot) with its own
  `tippool.distribute` audit row. Tips are not paid through payroll.
- The outlier flag is `tip_pool_outlier`.
