# night-audit

Admin route: **/finance/night-audit** (module `accounting`). Contract: `backend/src/modules/nightAudit/README.md`.

Finance or the CEO runs a business day (step 1, "audited / awaiting settlement"); the day closes when its card payout, bank lines and deposits match (step 2). Only the CEO pushes a day through a block, with a reason of 10+ characters. Month close needs every active day closed.

## Files

- `page.tsx` — month picker (`?month=`), summary, calendar, selected day (`?day=`), CEO start-day setting.
- `MonthCalendar.tsx` — 7-column calendar, a list on phones.
- `DayPanel.tsx` — status, live checks, run / settle / reopen, report tab, history.
- `PushThrough.tsx` — CEO acknowledge form (tick every block + reason).
- `DailyReportView.tsx` — renders the daily audit report.
- `types.ts` — wire types and date helpers.
