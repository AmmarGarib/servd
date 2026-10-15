# Trash bin (owner, 2026-10-15)

"Add a trash bin to park delete/void/cancelled entries and add option to recover
the entries whenever required until deleted from trash also." Owner's rules:
voided / cancelled transactions are **recovered as a new copy**; each module's
managers recover their own company's items; **only the CEO empties** the Trash;
manual retention only; **money, tax and stock records are never erased**.

Design spec: the session scratchpad `trash/SPEC.md` (inventory of every delete
route, strategies, findings F1–F11). This file is the contract.

## Pieces

| File | What |
|---|---|
| `src/lib/trash.ts` | `moveToTrash(tx, req \| actor, {...})` — the ONE writer of `trash_entries`, called by every module delete route **in the same transaction** as its delete. `trashReasonOf(req)`. |
| `types.ts` | `TrashProvider` (the per-type contract), `TrashCtx`, `TrashItem`. |
| `registry.ts` | THE list (`providers/masters/*`, `providers/transactions/*`). Keys unique, module ids known (tested). |
| `service.ts` | list / detail / restore / copy / purge / archive and every shared guard. |
| `snapshot.ts` | `takeSnapshot` / `restoreSnapshot` for hard-deleted masters (same ids, current-schema field filter, ≤1 MB else 413). |
| `routes.ts` | `/api/v1/trash` (see the header). |

## Rules

- **Strategies** (`types.ts`): `soft` (deletedAt), `snapshot` (row kept in the
  entry, then hard-deleted), `status` (archive/dismiss flip, `meta.previous`),
  `none` (a voided / cancelled transaction read from its own status — copy only).
- **Who:** `/trash` is open to every login (not in `GATED_PREFIXES`, like
  `/approvals`); a type is visible only with its provider's module + role
  (`roles` = the module's own route guards — import the constant). `ceoOnly`
  types (brands, logins, CEO site pages…) are the CEO's.
- **Company:** lists use `scopeTenantWhere(req,'read')`, restore / purge /
  archive `'write'`, a copy binds to the ACTIVE company (another company's row
  → 422 `COPY_SWITCH_COMPANY`). Foreign = 404. Company-less entries are the
  CEO's only. Entries are read on `serviceClient` with that explicit scope.
- **Restore:** row lock on the entry → `ALREADY_RESTORED` / `PURGED` (409) →
  `PARENT_IN_TRASH` (409, `details.parent`) → `clashOf` → `TRASH_CLASH` (409,
  `details: {field,value,suggestion,renamable}`) → provider `restore` (default:
  clear deletedAt / re-create snapshot / write `meta.previous`). A transaction
  or a `restorable: false` type → 422 `NOT_RESTORABLE`.
- **Purge (CEO only):** reason ≥10; transactions, `status` and `erasable:false`
  → 409 `NOT_ERASABLE`; `references()` non-empty → 409 `IN_USE`
  (`details.references`). Soft rows are hard-deleted, snapshots dropped; the
  entry stays as the tombstone (who, when, why).
- **Archive (CEO only):** hides a transaction / never-erasable item from the
  default list (`state=archived` shows them).
- **One open entry per thing** (partial unique `trash_entries_open_key`);
  re-deleting after a restore makes a new entry (history).
- **Audit:** `trash.move|restore|copy|purge|archive|unarchive`, stamped with
  the ROW's company.
- **Delete routes keep answering 204** and take an optional `?reason=` / body
  `reason`. A module's CREATE route answers 409 `IN_TRASH {type,id,title}` when
  the unique value it needs is held by a row in the Trash.
- **Merge:** `trash_entries` / `trash_copies` are on the tenant-merge repoint list.
- No worker: nothing leaves the Trash automatically. No `/health` detail.

## Adding a type

1. In the module's delete route: one `$transaction` with `moveToTrash` + the
   existing write (snapshot first for a hard delete).
2. A provider in `providers/masters/<domain>.ts` (or `transactions/`), roles
   imported from the module.
3. A two-company test.
