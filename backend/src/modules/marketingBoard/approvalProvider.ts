// Marketing tasks in the approvals inbox (owner, 2026-11-04: "the task once completed is not showing on my
// approvals"). Lists GET /my-tasks `toApprove` AS THE CALLER (tasks.ts decides who is leadership); Approve / Send back
// call the task's own routes (POST /my-tasks/:id/approve, POST /my-tasks/:id/done {done:false}), whose guard decides.
// Per item (APPROVAL_RIGHTS.marketing_task), never handed over.

import type { UserRole } from '@prisma/client'
import { APPROVAL_RIGHTS } from '../../lib/approvalRights.js'
import type { ApprovalItem, ApprovalProvider } from '../approvals/types.js'

const RIGHTS = APPROVAL_RIGHTS.marketing_task

interface Person { id: string; name: string | null }
interface Row {
  id: string; tenantId: string; title: string; deadline: string; kind: 'card' | 'calendar'
  board: { name: string } | null; brand: { name: string } | null; stageLabel: string | null
  owner: Person | null; resources: Person[]; doneAt: string | null; doneBy: Person | null; link: string
}

export const marketingTasks: ApprovalProvider = {
  type: 'marketing_task',
  label: RIGHTS.label,
  module: RIGHTS.queueModule,
  link: '/me/tasks',
  approverRoles: RIGHTS.roles as readonly UserRole[],
  delegable: RIGHTS.delegable,
  async load(ctx) {
    const res = await ctx.read<{ toApprove: Row[] }>('/my-tasks')
    if (res === null) return null
    return (res.toApprove ?? []).map((t): ApprovalItem => {
      const people = Array.from(new Set([t.owner, ...t.resources].filter((p): p is Person => !!p).map((p) => p.name ?? '—')))
      return {
        type: 'marketing_task',
        id: t.id,
        tenantId: t.tenantId,
        section: RIGHTS.section,
        submittedByIds: t.doneBy ? [t.doneBy.id] : [],
        title: `Task done — ${t.title}`,
        subtitle: t.board ? `${t.board.name} board${t.stageLabel ? ` · ${t.stageLabel}` : ''}` : `Content calendar${t.brand ? ` · ${t.brand.name}` : ''}`,
        facts: [
          { label: 'Done by', value: t.doneBy?.name ?? '—' },
          { label: 'Working on it', value: people.join(', ') || '—' },
          { label: 'Deadline', value: new Date(t.deadline).toLocaleDateString('en-PK', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Karachi' }) },
        ],
        amountCents: null,
        waitingSince: t.doneAt ?? t.deadline,
        link: t.link,
        actions: [
          { kind: 'approve', label: 'Approve', method: 'POST', path: `/my-tasks/${t.id}/approve`, body: { approved: true } },
          { kind: 'return', label: 'Send back', method: 'POST', path: `/my-tasks/${t.id}/done`, body: { done: false } },
        ],
      }
    })
  },
}
