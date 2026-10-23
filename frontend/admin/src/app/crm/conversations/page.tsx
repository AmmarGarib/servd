'use client'
// ─── CRM Conversations — staff-facing chat with customers ─────────────────────
// Mirrors the supplier chat UI at /procurement/chat but for the customer side.
// Each thread can hold web_portal / email / whatsapp messages — channel chip
// per bubble shows where each one came from. Outbound messages fan out to
// every channel the customer has on file (email + WhatsApp).
//
// Threads typically originate from a "Reach out" tap on a complaint or review,
// but staff can also start one from scratch (future: customer-picker; for now
// you can deep-link from /crm/customers).

import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '../../../lib/api'
import { NavIcon } from '../../../components/ui/NavIcon'
import { CompactEmptyState } from '../../../components/ui/CompactEmptyState'

interface Conversation {
  id: string
  customerId: string
  staffId: string
  subject: string | null
  source: 'complaint' | 'review' | 'manual'
  sourceRefId: string | null
  updatedAt: string
  customer: {
    id: string; name: string; email: string | null; phone: string | null
    // Brand the customer typically orders from — drives the chip on each
    // conversation row so the CRM operator sees which company they're on.
    preferredConcept: { name: string; slug: string } | null
  }
  staff: { id: string; name: string }
  messages: { id: string; body: string; fromStaff: boolean; createdAt: string; channel?: string }[]
  _count: { messages: number }
}

interface Message {
  id: string
  body: string
  fromStaff: boolean
  senderId: string | null
  seenAt: string | null
  createdAt: string
  channel?: string
  inboundFromAddress?: string | null
}

const CHANNEL_META: Record<string, { icon: string; label: string; color: string }> = {
  web_portal: { icon: 'globe', label: 'Portal',   color: 'text-s-muted' },
  email:      { icon: 'mail', label: 'Email',    color: 'text-primary-ink' },
  whatsapp:   { icon: 'chat', label: 'WhatsApp', color: 'text-success' },
}

const SOURCE_META: Record<string, { icon: string; label: string }> = {
  complaint: { icon: 'ticket', label: 'Complaint' },
  review:    { icon: 'star', label: 'Review' },
  manual:    { icon: 'chat', label: 'Manual' },
}

export default function CrmConversationsPage() {
  const qc = useQueryClient()
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [newMessage, setNewMessage] = useState('')

  const { data: conversations = [], isLoading } = useQuery<Conversation[]>({
    queryKey: ['crm-conversations'],
    queryFn: () => api.get('/crm/conversations'),
    refetchInterval: 10_000,
  })

  const { data: messages = [] } = useQuery<Message[]>({
    queryKey: ['crm-messages', selectedId],
    queryFn: () => api.get(`/crm/conversations/${selectedId}/messages`),
    enabled: !!selectedId,
    refetchInterval: 5_000,
  })

  const sendMessage = useMutation({
    mutationFn: () => api.post(`/crm/conversations/${selectedId}/messages`, { body: newMessage }),
    onSuccess: () => {
      setNewMessage('')
      void qc.invalidateQueries({ queryKey: ['crm-messages', selectedId] })
      void qc.invalidateQueries({ queryKey: ['crm-conversations'] })
    },
  })

  const selected = conversations.find((c) => c.id === selectedId)
  const willReach = selected ? [
    'Portal',
    selected.customer.email ? 'Email ' + selected.customer.email : null,
    selected.customer.phone ? 'WhatsApp ' + selected.customer.phone : null,
  ].filter(Boolean) as string[] : []

  return (
    <div className="flex h-screen bg-s-bg">
      {/* Sidebar */}
      <div className="w-80 shrink-0 flex flex-col border-r border-s-border bg-s-surface">
        <div className="p-4 border-b border-s-border">
          <h1 className="font-black text-s-text">CRM Conversations</h1>
          <p className="text-xs text-s-muted mt-0.5">{conversations.length} active customer threads</p>
        </div>

        <div className="flex-1 overflow-y-auto">
          {isLoading && <p className="p-4 text-sm text-s-muted">Loading…</p>}
          {!isLoading && conversations.length === 0 && (
            <div className="p-4">
              <CompactEmptyState icon={<NavIcon name="inbox" size={28} />} message="No conversations yet. Start one with Reach out on a complaint or review." />
            </div>
          )}

          {conversations.map((c) => {
            const lastMsg = c.messages[0]
            const lastDate = new Date(c.updatedAt)
            const isToday = lastDate.toDateString() === new Date().toDateString()
            // SOURCE_META.manual is statically defined so we know this is
            // never undefined; the cast avoids TS's noUncheckedIndexedAccess
            // false-positive.
            const meta: { icon: string; label: string } = SOURCE_META[c.source] ?? SOURCE_META['manual']!
            return (
              <button
                key={c.id}
                onClick={() => setSelectedId(c.id)}
                className={`w-full p-4 text-left border-b border-s-border transition-colors hover:bg-s-bg/50 ${
                  c.id === selectedId ? 'bg-s-bg/70' : ''
                }`}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <p className="font-semibold text-sm text-s-text truncate">{c.customer.name}</p>
                      {/* Brand chip so the centralised CRM operator can tell
                          which company this thread belongs to before they
                          reply. Hidden when the customer has no preferred
                          brand yet (one-off guest). */}
                      {c.customer.preferredConcept && (
                        <span className="shrink-0 text-[9px] uppercase tracking-wider font-bold px-1.5 py-0.5 rounded"
                          style={{ background: 'rgb(var(--ink-rgb) / 0.15)', color: 'var(--erp-primary-ink)' }}>
                          {c.customer.preferredConcept.name}
                        </span>
                      )}
                      <span className="shrink-0 text-[10px] uppercase tracking-wider text-s-muted">
                        <NavIcon name={meta.icon} size={12} className="mr-1 inline" />{meta.label}
                      </span>
                    </div>
                    {c.subject && <p className="text-xs text-s-muted truncate mt-0.5">{c.subject}</p>}
                    {lastMsg && (
                      <p className="text-xs text-s-muted mt-1 truncate">
                        {lastMsg.fromStaff ? 'You: ' : `${c.customer.name.split(/\s+/)[0]}: `}
                        {lastMsg.body}
                      </p>
                    )}
                  </div>
                  <p className="shrink-0 text-[10px] text-s-muted">
                    {isToday
                      ? lastDate.toLocaleTimeString('en-PK', { hour: '2-digit', minute: '2-digit' })
                      : lastDate.toLocaleDateString('en-PK', { day: 'numeric', month: 'short' })}
                  </p>
                </div>
              </button>
            )
          })}
        </div>
      </div>

      {/* Thread */}
      <div className="flex flex-1 flex-col">
        {selected ? (
          <>
            <div className="flex items-center justify-between border-b border-s-border bg-s-surface px-5 py-3">
              <div className="min-w-0">
                <h2 className="font-bold text-s-text truncate">{selected.customer.name}</h2>
                <p className="text-xs text-s-muted truncate">
                  {selected.subject ?? 'No subject'} · {SOURCE_META[selected.source]?.label ?? 'Manual'}
                </p>
                <div className="mt-1.5 flex flex-wrap gap-1.5">
                  {selected.customer.email && (
                    <span className="inline-flex items-center gap-1 rounded-full bg-blue-500/10 border border-blue-500/30 px-2 py-0.5 text-[10px] text-blue-700">
                      <NavIcon name="mail" size={11} />{selected.customer.email}
                    </span>
                  )}
                  {selected.customer.phone && (
                    <span className="inline-flex items-center gap-1 rounded-full bg-accent-dim border border-accent px-2 py-0.5 text-[10px] text-success">
                      <NavIcon name="chat" size={11} />{selected.customer.phone}
                    </span>
                  )}
                </div>
              </div>
            </div>

            <div className="flex-1 overflow-y-auto p-4 space-y-3">
              {messages.map((msg) => {
                // Pre-compute channel chip metadata so TS narrows it once,
                // outside JSX where flow-typing through &&-chains is brittle
                // under noUncheckedIndexedAccess.
                const channelMeta =
                  !msg.fromStaff && msg.channel && msg.channel !== 'web_portal'
                    ? CHANNEL_META[msg.channel] ?? null
                    : null

                return (
                  <div key={msg.id} className={`flex ${msg.fromStaff ? 'justify-end' : 'justify-start'}`}>
                    <div className={`max-w-[70%] rounded-2xl px-4 py-2.5 ${
                      msg.fromStaff
                        ? 'bg-primary text-primary-on rounded-br-sm'
                        : 'bg-s-surface border border-s-border text-s-text rounded-bl-sm'
                    }`}>
                      <p className="text-sm whitespace-pre-wrap">{msg.body}</p>
                      <p className={`text-xs mt-1 flex items-center gap-1.5 ${msg.fromStaff ? 'text-primary-on/60' : 'text-s-muted'}`}>
                        <span>
                          {new Date(msg.createdAt).toLocaleTimeString('en-PK', { hour: '2-digit', minute: '2-digit' })}
                          {msg.fromStaff && msg.seenAt && ' · Seen'}
                        </span>
                        {channelMeta && (
                          <span className={`inline-flex items-center gap-0.5 ${channelMeta.color}`}
                            title={`Replied via ${channelMeta.label}`}>
                            · <NavIcon name={channelMeta.icon} size={12} className="mr-0.5 inline" />{channelMeta.label}
                          </span>
                        )}
                      </p>
                    </div>
                  </div>
                )
              })}
              {messages.length === 0 && (
                <div className="mt-12">
                  <CompactEmptyState icon={<NavIcon name="inbox" size={28} />} message="No messages yet" />
                </div>
              )}
            </div>

            <div className="border-t border-s-border bg-s-surface/40 px-4 py-1.5 text-[10px] text-s-muted">
              On send: <span className="text-s-text font-semibold">{willReach.join(' · ')}</span>
            </div>

            <div className="border-t border-s-border bg-s-surface p-3 flex gap-2">
              <textarea
                value={newMessage}
                onChange={(e) => setNewMessage(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && newMessage.trim()) { e.preventDefault(); sendMessage.mutate() } }}
                placeholder="Type a message… (Enter to send)"
                rows={2}
                className="flex-1 resize-none rounded-xl border border-s-border bg-s-bg px-3 py-2 text-sm text-s-text focus:border-primary focus:outline-none"
              />
              <button
                onClick={() => sendMessage.mutate()}
                disabled={!newMessage.trim() || sendMessage.isPending}
                className="rounded-xl bg-primary px-4 py-2 font-bold text-primary-on disabled:opacity-50 hover:opacity-90"
              >
                {sendMessage.isPending ? '…' : <NavIcon name="send" size={16} />}
              </button>
            </div>
          </>
        ) : (
          <div className="flex flex-1 items-center justify-center bg-s-bg/40">
            <div className="text-center max-w-sm px-6">
              <span className="mb-3 inline-block text-s-muted"><NavIcon name="chat" size={40} /></span>
              <p className="font-bold text-s-text">Pick a conversation to read</p>
              <p className="text-sm text-s-muted mt-1">
                Threads start from <span className="font-bold text-primary-ink">Reach out</span> on a complaint or review.
              </p>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
