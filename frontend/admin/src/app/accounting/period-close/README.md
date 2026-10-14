# period-close

Admin route: **/accounting/period-close**. Next.js App Router page module — `page.tsx` is the entry, any sibling `layout.tsx` wraps it.

## Files

- `page.tsx` — the one close / reopen of a company's books (CEO only), with the
  ONE close checklist (finance wave B, H29).
  - `GET /accounting/period-close?lockedThrough=<date>` answers the active
    company's lock plus, for that date, `checks` (every `CloseProblem` from
    `backend/src/modules/accounting/closeChecks.ts` `CLOSE_CHECKS`), `months`,
    `isYearEnd`, `closesFiscalYear`, `fiscalYear {endMonth, label, start, end}`
    and `ready`. `raastUnmatched` is still sent for older pages.
  - Chips: red = blocks the close, amber = warning (never stops it), green =
    nothing blocks. Each problem links to the page that shows its rows (`link`)
    and may offer a one-click fix (`fix.path`, POSTed with `{}`; the route's
    own guard decides).
  - The CEO may close over an overridable block by ticking it and giving a
    reason (at least 10 characters): `POST /accounting/period-close`
    `{ lockedThrough, note?, acknowledge: { keys, reason } }` — stored on the
    lock (`overrides`, `overrideReason`), audited `period.close_override`,
    flagged `period_close_override` (high). The trial balance can never be
    closed over (422 `NOT_OVERRIDABLE`). Anything left open → 409
    `CLOSE_NOT_READY` `{ problems, open }`; Raast as the ONLY block is still
    409 `RAAST_UNMATCHED`, and the old `closeWithUnmatchedRaast: true` switch
    works only then (audited `period.close_with_unmatched_raast`).
  - A close whose range passes the company's fiscal year end shows the
    "Year-end close" banner and is audited `period.year_end_close`. Nothing is
    posted: the roll-forward is virtual (balance sheet / trial balance).
  - Fiscal year end month (CEO): `PATCH /tenants/:id { fiscalYearEndMonth, reason? }`.
    Once the books were closed across a year end, the change needs a reason
    (409 `FY_CHANGE_AFTER_YEAR_END_CLOSE` otherwise); `GET /accounting/fiscal-year`
    says so (`closedAcrossYearEnd`).
  - Close history (`GET /accounting/period-close/history`) shows what each close
    was closed over and why.
