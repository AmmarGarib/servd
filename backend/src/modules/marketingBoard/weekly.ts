// "Published vs slipped" — the marketing board's weekly report and Monday bell (owner, 2026-11-03).
//
// For a Karachi week (Monday 00:00 → next Monday 00:00 PKT), per board:
//   published  — cards that entered Published during the week (on time when publishedAt <= deadline);
//   slipped    — cards whose deadline fell in the week, has passed, and that were NOT published by it
//                (still unpublished, or published after the deadline);
//   open       — cards whose deadline falls in the week, has not passed yet, and that are not published.
// One reading (weeklyReport) behind the page, its CSV / Excel / PDF export and the Monday bell notice
// (runMarketingWeeklyOnce: last week's figures to the company's marketing leads and CEO(s), one notice per
// person per week — Setting marker per company + dedupeKey, as hr/expiryDigest.ts).

import type { Prisma } from '@prisma/client'
import { serviceClient } from '../../lib/prisma.js'
import { prisma } from '../../lib/prisma.js'
import { notifyStaffMany, type NotifyInput } from '../../lib/staffNotify.js'
import { effectiveModulesForUser } from '../../lib/moduleAccess.js'
import type { ReportTable } from '../../lib/reportExport.js'
import { STAGE_LABEL, type Stage } from './cards.js'
import { lastWeekMonday, pktDay, weekWindow } from './week.js'

export type WeeklyStatus = 'published_on_time' | 'published_late' | 'slipped' | 'open'
const STATUS_LABEL: Record<WeeklyStatus, string> = {
  published_on_time: 'Published on time', published_late: 'Published late', slipped: 'Slipped', open: 'Still open',
}

export interface WeeklyCard { id: string; title: string; type: string; stage: string | null; owner: string | null; deadline: Date; publishedAt: Date | null; status: WeeklyStatus }
export interface WeeklyBoard { id: string; name: string; kind: string; tenantId: string; published: number; publishedOnTime: number; slipped: number; open: number; cards: WeeklyCard[] }
export interface WeeklyReport { monday: string; sunday: string; boards: WeeklyBoard[]; totals: { published: number; publishedOnTime: number; slipped: number; open: number } }

/** The week's figures for the boards matching `boardWhere` (the caller's company scope already in it). */
export async function weeklyReport(boardWhere: Prisma.MarketingBoardWhereInput, monday: string, now: Date = new Date(), db: typeof prisma = prisma): Promise<WeeklyReport> {
  const { from, to, sunday } = weekWindow(monday)
  const boards = await db.marketingBoard.findMany({
    where: { ...boardWhere, archivedAt: null },
    select: { id: true, name: true, kind: true, tenantId: true },
    orderBy: [{ kind: 'asc' }, { sort: 'asc' }, { name: 'asc' }],
  })
  const cards = await db.contentEvent.findMany({
    where: {
      boardId: { in: boards.map((b) => b.id) },
      OR: [{ publishedAt: { gte: from, lt: to } }, { startDate: { gte: from, lt: to } }],
    },
    select: { id: true, boardId: true, title: true, type: true, stage: true, startDate: true, publishedAt: true, assignee: { select: { name: true } } },
    orderBy: { startDate: 'asc' },
  })
  const out: WeeklyBoard[] = boards.map((b) => ({ ...b, published: 0, publishedOnTime: 0, slipped: 0, open: 0, cards: [] }))
  const byId = new Map(out.map((b) => [b.id, b]))
  for (const c of cards) {
    const b = byId.get(c.boardId!)
    if (!b) continue
    const published = c.stage === 'published' && c.publishedAt != null
    const onTime = published && c.publishedAt!.getTime() <= c.startDate.getTime()
    const deadlineInWeek = c.startDate >= from && c.startDate < to
    const publishedInWeek = published && c.publishedAt! >= from && c.publishedAt! < to
    let status: WeeklyStatus | null = null
    if (publishedInWeek) {
      status = onTime ? 'published_on_time' : 'published_late'
      b.published++
      if (onTime) b.publishedOnTime++
    }
    if (deadlineInWeek && c.startDate.getTime() < now.getTime() && !onTime) {
      b.slipped++
      if (!status) status = 'slipped'
    } else if (deadlineInWeek && !published && c.startDate.getTime() >= now.getTime()) {
      b.open++
      if (!status) status = 'open'
    }
    if (status) b.cards.push({ id: c.id, title: c.title, type: c.type, stage: c.stage, owner: c.assignee?.name ?? null, deadline: c.startDate, publishedAt: c.publishedAt, status })
  }
  const sum = (k: 'published' | 'publishedOnTime' | 'slipped' | 'open') => out.reduce((s, b) => s + b[k], 0)
  return { monday, sunday, boards: out, totals: { published: sum('published'), publishedOnTime: sum('publishedOnTime'), slipped: sum('slipped'), open: sum('open') } }
}

/** The export table: one row per card, sectioned by board, with the board's counts. */
export function weeklyReportTable(r: WeeklyReport): ReportTable {
  const rows = r.boards.flatMap((b) => {
    const head = `${b.name} — ${b.published} published (${b.publishedOnTime} on time), ${b.slipped} slipped, ${b.open} open`
    if (b.cards.length === 0) return [{ board: head, card: '(nothing due or published this week)', type: '', owner: '', deadline: '', stage: '', published: '', status: '' }]
    return b.cards.map((c) => ({
      board: head, card: c.title, type: c.type.replace('_', ' '), owner: c.owner ?? '',
      deadline: pktDay(c.deadline), stage: c.stage ? STAGE_LABEL[c.stage as Stage] : '',
      published: c.publishedAt ? pktDay(c.publishedAt) : '', status: STATUS_LABEL[c.status],
    }))
  })
  return {
    title: 'Marketing — published vs slipped',
    period: `${r.monday} to ${r.sunday}`,
    columns: [
      { key: 'board' }, { key: 'card', label: 'Card' }, { key: 'type', label: 'Type' }, { key: 'owner', label: 'Owner' },
      { key: 'deadline', label: 'Deadline' }, { key: 'stage', label: 'Stage' }, { key: 'published', label: 'Published' }, { key: 'status', label: 'Status' },
    ],
    sectionKey: 'board',
    wrapKeys: ['card'],
    rows,
    notes: [`Totals: ${r.totals.published} published (${r.totals.publishedOnTime} on time), ${r.totals.slipped} slipped, ${r.totals.open} still open.`],
  }
}

// ── Monday bell ──────────────────────────────────────────────────────────

const markerKey = (tenantId: string) => `marketing.weekly.lastWeek:${tenantId}`

/** The company's marketing leads (per-person module, active) and its CEO(s). */
async function weeklyRecipients(tenantId: string): Promise<string[]> {
  const users = await serviceClient.user.findMany({
    where: {
      isActive: true, accountStatus: 'active', deletedAt: null,
      OR: [{ role: 'admin' }, { moduleAllow: { has: 'marketing_lead' } }],
      AND: [{ OR: [{ tenantId }, { tenantMemberships: { some: { tenantId } } }] }],
    },
    select: { id: true, role: true, moduleAllow: true, moduleDeny: true },
  })
  const out: string[] = []
  for (const u of users) {
    if (u.role === 'admin' || (await effectiveModulesForUser(u)).has('marketing_lead')) out.push(u.id)
  }
  return out
}

/** One company's notice for last week. Returns the notices created (0 when already sent this week). */
export async function runMarketingWeeklyForCompany(tenantId: string, now: Date = new Date()): Promise<number> {
  const monday = lastWeekMonday(now)
  const marker = await serviceClient.setting.findUnique({ where: { key: markerKey(tenantId) } })
  if (marker?.value === monday) return 0
  const boards = await serviceClient.marketingBoard.count({ where: { tenantId, archivedAt: null } })
  let created = 0
  if (boards > 0) {
    const r = await weeklyReport({ tenantId }, monday, now, serviceClient as unknown as typeof prisma)
    const parts = r.boards.map((b) => `${b.name}: ${b.published} published, ${b.slipped} slipped`).join('; ')
    const rows: NotifyInput[] = (await weeklyRecipients(tenantId)).map((userId) => ({
      userId, tenantId, kind: 'marketing.weekly', severity: r.totals.slipped > 0 ? 'warning' : 'info',
      title: `Marketing week of ${monday}: ${r.totals.published} published, ${r.totals.slipped} slipped`,
      body: parts, link: `/marketing/weekly?weekOf=${monday}`,
      entityType: 'marketing_weekly', entityId: tenantId, dedupeKey: `marketing.weekly:${tenantId}:${monday}`,
    }))
    created = rows.length ? await notifyStaffMany(rows) : 0
  }
  await serviceClient.setting.upsert({ where: { key: markerKey(tenantId) }, create: { key: markerKey(tenantId), value: monday }, update: { value: monday } })
  return created
}

export async function runMarketingWeeklyOnce(now: Date = new Date()): Promise<{ companies: number; notices: number }> {
  const companies = await serviceClient.tenant.findMany({ where: { deletedAt: null, kind: 'company' }, select: { id: true } })
  let notices = 0
  for (const { id } of companies) {
    try { notices += await runMarketingWeeklyForCompany(id, now) } catch (err) { console.error(`[marketing-weekly] company ${id}:`, (err as Error).message) }
  }
  return { companies: companies.length, notices }
}
