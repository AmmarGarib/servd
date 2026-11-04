// Marketing board (owner, 2026-11-03) — types and labels shared by the board, the weekly report, the tracker and
// My progress. Server: backend/src/modules/marketingBoard (README there).

export type Stage = 'idea' | 'brief_ready' | 'in_progress' | 'in_review' | 'approved' | 'published'
export type CardType = 'campaign' | 'shoot' | 'design_request'
export type Priority = 'low' | 'normal' | 'high' | 'urgent'
export type Outcome = 'on_time' | 'published_late' | 'late' | 'open'

export const STAGES: Stage[] = ['idea', 'brief_ready', 'in_progress', 'in_review', 'approved', 'published']
export const STAGE_LABEL: Record<Stage, string> = {
  idea: 'Idea', brief_ready: 'Brief ready', in_progress: 'In progress', in_review: 'In review', approved: 'Approved', published: 'Published',
}
/** Stage colours: purple tints while work moves, servd green for state / good news (Published). Tokens only. */
export const STAGE_TONE: Record<Stage, string> = {
  idea: 'bg-s-muted', brief_ready: 'bg-s-blue', in_progress: 'bg-s-amber', in_review: 'bg-s-purple', approved: 'bg-primary', published: 'bg-s-green',
}
export const TYPE_LABEL: Record<CardType, string> = { campaign: 'Campaign', shoot: 'Shoot', design_request: 'Design request' }
export const PRIORITY_LABEL: Record<Priority, string> = { low: 'Low', normal: 'Normal', high: 'High', urgent: 'Urgent' }
export const OUTCOME_LABEL: Record<Outcome, string> = { on_time: 'Published on time', published_late: 'Published late', late: 'Late', open: 'Open' }

export interface Board {
  id: string; tenantId: string; name: string; kind: 'brand' | 'platform'; conceptId: string | null
  concept: { id: string; name: string } | null; sort: number; archivedAt: string | null; openCards: number
}
export interface Person { id: string; name: string | null; role?: string }
export interface CardFile { id: string; mediaAssetId: string; name: string; filename: string; url: string; contentType: string; kind: string }
export interface Card {
  id: string; tenantId: string; boardId: string; board: { id: string; name: string; kind: string } | null
  title: string; type: CardType; stage: Stage; priority: Priority; deadline: string; brief: string | null
  referenceLinks: string[]; owner: Person | null; resources: Person[]; publishedAt: string | null
  revisionCount: number; outcome: Outcome
  menuItem: { id: string; name: string } | null; promoCode: { id: string; code: string } | null; campaign: { id: string; name: string } | null
  files: CardFile[]; commentCount: number; createdBy: Person | null; createdAt: string; updatedAt: string
  /** Task ticks (owner, 2026-11-04): done by someone on it, then approved by leadership. */
  taskStatus: 'open' | 'awaiting_approval' | 'done'; taskDoneAt: string | null; leadApprovedAt: string | null
}
export interface Comment { id: string; body: string; createdAt: string; author: Person }
export interface CardDetail extends Card { comments: Comment[] }
export interface BoardMe { userId: string; lead: boolean; intern: boolean; canCreate: boolean; canDelete: boolean; canUndoDelete: boolean }

/** YYYY-MM-DD of an instant in Karachi (PKT = UTC+5). */
export function pktYmd(iso: string): string {
  return new Date(new Date(iso).getTime() + 5 * 3_600_000).toISOString().slice(0, 10)
}
export function fmtDay(iso: string): string {
  return new Date(`${pktYmd(iso)}T00:00:00Z`).toLocaleDateString('en-PK', { day: 'numeric', month: 'short', timeZone: 'UTC' })
}
export function initials(name: string | null | undefined): string {
  return (name ?? '?').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join('') || '?'
}
