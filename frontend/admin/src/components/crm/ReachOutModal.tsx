'use client'
// ─── Customer reach-out modal ─────────────────────────────────────────────────
// Used from /complaints and /reviews. Spawns a CustomerConversation linked to
// the originating record (source='complaint'|'review' + sourceRefId), which
// triggers email + WhatsApp fan-out via the backend's deliverToCustomer().
//
// Imported here rather than inlined into each page so the staff-facing copy
// + channel chips stay consistent — operators learn one mental model.

import { useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { api } from '../../lib/api'

const inp = 'w-full rounded-lg bg-kds-bg border border-kds-border px-3 py-2 text-kds-text text-sm focus:border-kds-green focus:outline-none'

export interface ReachOutContext {
  source: 'complaint' | 'review'
  sourceRefId: string
  // Originating record's title/subject — used to seed Subject and message.
  contextTitle: string
  // Optional supporting copy shown in the body template (e.g. complaint
  // category, review rating). Pass through-as-is, no formatting.
  contextSubtitle?: string
  conceptName: string
  customer: { id: string; name: string; email: string | null; phone: string | null }
}

export function ReachOutModal({
  context,
  onClose,
  onSent,
}: {
  context: ReachOutContext
  onClose: () => void
  onSent: () => void
}) {
  const firstName = context.customer.name.split(/\s+/)[0]

  // Source-specific default copy. Both intentionally short — operators tend
  // to rewrite anyway, the goal is just to remove the blank-page friction.
  const defaultBody = context.source === 'complaint'
    ? `Hi ${firstName},\n\nI'm following up on the issue you raised at ${context.conceptName}: "${context.contextTitle}".\n\nSorry about that experience — could you tell me a bit more about what happened? We'd like to make it right.\n\nThanks,\nThe team at servd`
    : `Hi ${firstName},\n\nThank you for the review of ${context.conceptName} — "${context.contextTitle}".\n\nWe'd love to hear more about your visit and how we can do even better next time.\n\nThanks,\nThe team at servd`

  const [subject, setSubject] = useState(
    context.source === 'complaint'
      ? `Following up: ${context.contextTitle}`
      : `Thanks for reviewing ${context.conceptName}`,
  )
  const [body, setBody] = useState(defaultBody)
  const [error, setError] = useState<string | null>(null)

  const send = useMutation({
    mutationFn: () =>
      api.post<{ id: string }>('/crm/conversations', {
        customerId:  context.customer.id,
        subject,
        message:     body,
        source:      context.source,
        sourceRefId: context.sourceRefId,
      }),
    onSuccess: () => onSent(),
    onError: (e: Error) => setError(e.message),
  })

  const reaches = [
    context.customer.email && `📧 ${context.customer.email}`,
    context.customer.phone && `💬 ${context.customer.phone}`,
  ].filter(Boolean) as string[]

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4" onClick={onClose}>
      <div className="w-full max-w-lg rounded-2xl bg-kds-card border border-kds-border shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}>
        <div className="border-b border-kds-border px-5 py-3 flex items-center justify-between">
          <div className="min-w-0">
            <h2 className="font-black text-kds-text">Reach out to {firstName}</h2>
            <p className="text-xs text-kds-subtext mt-0.5 truncate">
              Linked to {context.source}: <span className="text-kds-text">{context.contextTitle}</span>
              {context.contextSubtitle && <span className="ml-1 text-kds-subtext/70">· {context.contextSubtitle}</span>}
            </p>
          </div>
          <button onClick={onClose} className="text-2xl leading-none text-kds-subtext hover:text-kds-text">✕</button>
        </div>

        <div className="p-5 space-y-4 max-h-[70vh] overflow-y-auto">
          <div className="rounded-xl border border-kds-border bg-kds-bg/40 p-3">
            <p className="text-[10px] font-bold uppercase tracking-wider text-kds-subtext mb-2">Will reach via</p>
            <div className="flex flex-wrap gap-1.5">
              <span className="rounded-full bg-kds-green/10 border border-kds-green/30 px-2 py-0.5 text-[10px] text-kds-green">🌐 In-app thread</span>
              {reaches.map((r) => (
                <span key={r} className="rounded-full bg-blue-500/10 border border-blue-500/30 px-2 py-0.5 text-[10px] text-blue-400">
                  {r}
                </span>
              ))}
              {reaches.length === 0 && (
                <span className="text-[10px] text-kds-amber italic">No email or phone on file — only the in-app record will be created.</span>
              )}
            </div>
          </div>

          <div>
            <label className="text-xs text-kds-subtext">Subject</label>
            <input value={subject} onChange={(e) => setSubject(e.target.value)} className={`${inp} mt-1`} />
          </div>
          <div>
            <label className="text-xs text-kds-subtext">Message</label>
            <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={8} className={`${inp} mt-1 resize-none`} />
          </div>

          {error && <p className="rounded-lg border border-kds-red/40 bg-kds-red/10 px-3 py-2 text-xs text-kds-red">{error}</p>}
        </div>

        <div className="flex items-center justify-between gap-3 border-t border-kds-border bg-kds-bg/40 p-4">
          <button onClick={onClose} className="rounded-xl border border-kds-border px-4 py-2.5 text-sm text-kds-subtext hover:text-kds-text">
            Cancel
          </button>
          <button
            onClick={() => send.mutate()}
            disabled={send.isPending || !body.trim()}
            className="rounded-xl bg-kds-green px-5 py-2.5 text-sm font-black text-black hover:opacity-90 disabled:opacity-50"
          >
            {send.isPending ? 'Sending…' : 'Send & open thread'}
          </button>
        </div>
      </div>
    </div>
  )
}
