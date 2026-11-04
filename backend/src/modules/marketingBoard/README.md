# Marketing board + intern tracker (owner, 2026-11-03)

The Content Calendar's ONE store is extended — a board card **is** a `ContentEvent` with a `boardId` and a `stage`
(`startDate` = deadline, `assigneeId` = owner, `description` = brief). Plain calendar entries keep every new column
NULL and behave as before; `/calendar` refuses to change a board card (409 `USE_MARKETING_BOARD`) and shows board
cards (with board + stage) only to holders of `marketing_board`.

## Boards (`MarketingBoard`, tenantId, RLS, merge repoint)
- kind `brand` (linked to its Concept, in that brand's company): Simmer, Stackd, Flipd Burgers.
- kind `platform` (no brand): **beanzbakes (Instagram)** — Abeer's home-baking account. NOT a brand, company or
  business entity (owner, 2026-11-03); the row lives in the company named "GS Foods" only for company separation.
- Seeded at boot (`boards.ts ensureMarketingBoards`, one Setting marker per seed). Archived, never deleted.

## Stages
Idea → Brief ready → In progress → In review → Approved → Published. Only the CEO and holders of the per-person
module `marketing_lead` move a card (`POST /cards/:id/stage`, else 403 `STAGE_MOVE_LEAD_ONLY`). Entering Published
stamps `publishedAt` (on time = `publishedAt <= deadline`; leaving Published clears it); In review / Approved → In
progress adds a revision.

## Who sees what
| | board | stage moves / boards | tracker (manager) | own progress |
|---|---|---|---|---|
| CEO (`admin`) | all | yes | yes | — |
| `marketing_lead` holder (Anusha) | all | yes | if `marketing_tracker` ticked | — |
| marketing, brand_manager, owner, management | all (module `marketing_board`) | no | only if `marketing_tracker` ticked | marketing / brand_manager |
| `marketing_intern` | ONLY cards they are a resource / owner on; edit title, brief, links; comment; upload files | no | no | yes (`/marketing-progress/me`) |
| every other role | 403 | 403 | 403 | 403 |

`marketing_lead` and `marketing_tracker` are PER PERSON (`lib/moduleAccess.ts PER_PERSON_MODULES`): no role default,
stripped from every preset row; only the CEO's tick (moduleAllow). The intern's modules are FIXED (`INTERN_MODULES`)
and the role is refused centrally outside `auth/middleware.ts INTERN_ROUTES` (the director precedent).

## API
- `/marketing-board` (module `marketing_board`; `BOARD_ROLES`): `GET /me`, `GET|POST /boards`, `PATCH /boards/:id`,
  `GET /boards/:id/people`, `GET /boards/:id/link-options`, `GET|POST /cards`, `GET|PATCH|DELETE /cards/:id`,
  `POST /cards/:id/stage`, `POST /cards/:id/comments`, `GET /cards/:id/upload-url` (the ONE media upload,
  `media/routes.ts presignMediaUpload`, linked to the card), `POST /cards/:id/files`, `DELETE /cards/:id/files/:linkId`,
  `GET /report/weekly?weekOf&boardId&format=csv|xlsx|pdf`.
- `/marketing-tracker` (module `marketing_tracker`; `TRACKER_ROLES`): list / create / edit records, `GET /:id`
  (cards, on-time vs late, revisions, notes, every review, attendance), `/:id/attendance`, `/:id/check-ins`,
  `/:id/reviews`, `PATCH /reviews/:id`, `POST /reviews/:id/share`.
- `/marketing-progress/me` — the caller's own records; reviews only once shared.

Company scope: lists read the companies in view, edits any member company, a new card / board / tracker record binds
to the ACTIVE company. Foreign rows 404; a resource / owner not on the board company's staff 422
`RESOURCE_NOT_IN_COMPANY`; a dish / promo / campaign of another company 422 `LINK_NOT_IN_COMPANY`.

Attendance is read from HR (`hr/service.ts attendanceWithin` + standing attendance records), never ClockLog.

Bell: `marketing.card` (put on a card, stage move, comment — to the card's owner and resources) and
`marketing.weekly` (workers/marketingWeekly.ts, Monday). Delete = the `content_event` Trash provider, snapshot with
resources, comments and file links. Tests: `tests/marketingBoard.test.ts`.

## Task lists (owner, 2026-11-04) — `tasks.ts`, `/my-tasks`
A card (owner + resources) or a plain content-calendar entry (assignee) IS a task of those people — no task table.
Put on one → bell + EMAIL (`announceTaskAssigned`, after the commit; cards keep their `marketing.card` bell, calendar
entries ring `marketing.task`). Two ticks on the row: `taskDoneAt` (someone on it, or leadership; undone freely until
approved) and `leadApprovedAt` ("Approved by leadership": only after done — 409 `TASK_NOT_DONE`; never on your own
task — 403 `SELF_APPROVAL_BLOCKED`, the CEO excepted). Leadership = the CEO or a `marketing_lead` holder; for a
calendar entry also whoever created it. Approved → off everyone's list; reopen (approved false) puts it back as open.
`GET /my-tasks` = { open, awaitingApproval, done (30 days), toApprove, canApprove } across the caller's companies
(foreign → 404). Open to every staff login and the intern (INTERN_ROUTES). Admin: `/me/tasks` (My tasks) + the Task
box on the card panel. Tests: `tests/marketingTasks.test.ts`.
