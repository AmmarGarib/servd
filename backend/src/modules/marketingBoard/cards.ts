// Marketing board cards — shared reads (owner, 2026-11-03). A card IS a ContentEvent with a boardId and a stage:
// startDate = its deadline, assigneeId = its owner, description = its brief.

import type { Prisma } from '@prisma/client'

export const STAGES = ['idea', 'brief_ready', 'in_progress', 'in_review', 'approved', 'published'] as const
export type Stage = typeof STAGES[number]
export const CARD_TYPES = ['campaign', 'shoot', 'design_request'] as const
export const PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const

export const STAGE_LABEL: Record<Stage, string> = {
  idea: 'Idea', brief_ready: 'Brief ready', in_progress: 'In progress',
  in_review: 'In review', approved: 'Approved', published: 'Published',
}

/** A move back from In review / Approved to In progress is a revision. */
export function isRevision(from: Stage | null, to: Stage): boolean {
  return to === 'in_progress' && (from === 'in_review' || from === 'approved')
}

export type CardOutcome = 'on_time' | 'published_late' | 'late' | 'open'

/** On time = published by the deadline; overdue and unpublished = late. */
export function outcomeOf(card: { stage: string | null; publishedAt: Date | null; startDate: Date }, now: Date = new Date()): CardOutcome {
  if (card.stage === 'published' && card.publishedAt) return card.publishedAt.getTime() <= card.startDate.getTime() ? 'on_time' : 'published_late'
  return card.startDate.getTime() < now.getTime() ? 'late' : 'open'
}

/** Everything a card list / detail needs (never another company's rows — the where clause scopes it). */
export const CARD_INCLUDE = {
  board:     { select: { id: true, name: true, kind: true, conceptId: true } },
  assignee:  { select: { id: true, name: true } },
  createdBy: { select: { id: true, name: true } },
  resources: { select: { userId: true, user: { select: { id: true, name: true, role: true } } }, orderBy: { createdAt: 'asc' as const } },
  files:     { select: { id: true, mediaAssetId: true, createdAt: true, mediaAsset: { select: { id: true, name: true, filename: true, url: true, contentType: true, kind: true } } }, orderBy: { createdAt: 'asc' as const } },
  menuItem:  { select: { id: true, name: true } },
  promoCode: { select: { id: true, code: true } },
  campaign:  { select: { id: true, name: true } },
  _count:    { select: { comments: true } },
} satisfies Prisma.ContentEventInclude

type CardRow = Prisma.ContentEventGetPayload<{ include: typeof CARD_INCLUDE }>

export function cardDto(c: CardRow, now: Date = new Date()) {
  return {
    id: c.id,
    tenantId: c.tenantId,
    boardId: c.boardId,
    board: c.board,
    conceptId: c.conceptId,
    title: c.title,
    type: c.type,
    stage: c.stage,
    priority: c.priority ?? 'normal',
    deadline: c.startDate,
    brief: c.description,
    referenceLinks: c.referenceLinks,
    owner: c.assignee,
    resources: c.resources.map((r) => r.user),
    publishedAt: c.publishedAt,
    revisionCount: c.revisionCount,
    outcome: outcomeOf(c, now),
    menuItem: c.menuItem,
    promoCode: c.promoCode,
    campaign: c.campaign,
    files: c.files.map((f) => ({
      id: f.id, mediaAssetId: f.mediaAssetId,
      name: f.mediaAsset.name || f.mediaAsset.filename, filename: f.mediaAsset.filename,
      url: f.mediaAsset.url, contentType: f.mediaAsset.contentType, kind: f.mediaAsset.kind,
    })),
    commentCount: c._count.comments,
    // Task ticks (owner, 2026-11-04; tasks.ts): done by someone on it, then "Approved by leadership".
    taskStatus: c.leadApprovedAt ? 'done' as const : c.taskDoneAt ? 'awaiting_approval' as const : 'open' as const,
    taskDoneAt: c.taskDoneAt,
    leadApprovedAt: c.leadApprovedAt,
    createdBy: c.createdBy,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
  }
}
