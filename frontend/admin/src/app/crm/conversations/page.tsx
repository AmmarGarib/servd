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

interface Conversation {
  id: string
  customerId: string
  staffId: string
  subject: string | null
  source: 'complaint' | 'review' | 'manual'
  sourceRefId: string | null
  updatedAt: string
  customer: { id: string; name: string; email: string | null; phone: string | null }
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
  web_portal: { icon: '🌐', label: 'Portal',   color: 'text-kds-subtext' },
  email:      { icon: '📧', label: 'Email',    color: 'text-blue-400' },
  whatsapp:   { icon: '💬', label: 'WhatsApp', color: 'text-[#25D366]' },
}

const SOURCE_META: Record<string, { icon: string; label: string }> = {
  complaint: { icon: '🎫', label: 'Complaint' },
  review:    { icon: '⭐', label: 'Review' },
  manual:    { icon: '💬', label: 'Manual' },
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
    '🌐 Portal',
    selected.customer.email ? '📧 ' + selected.customer.email : null,
    selected.customer.phone ? '💬 ' + selected.customer.phone : null,
  ].filter(Boolean) as string[] : []

  return (
    <div className="flex h-screen bg-kds-bg">
      {/* Sidebar */}
      <div className="w-80 shrink-0 flex flex-col border-r border-kds-border bg-kds-card">
        <div className="p-4 border-b border-kds-border">
          <h1 className="font-black text-kds-text">CRM Conversations</h1>
          <p className="text-xs text-kds-subtext mt-0.5">{conversations.length} active customer threads</p>
        </div>

        <div className="flex-1 overflow-y-auto">
          {isLoading && <p className="p-4 text-sm text-kds-subtext">Loading…</p>}
          {!isLoading && conversations.length === 0 && (
            <div className="p-6 text-center">
              <p className="text-3xl mb-2">📭</p>
              <p className="text-sm font-semibold text-kds-text">No conversations yet</p>
              <p className="text-xs text-kds-subtext mt-1">
                Start one from a complaint or review by tapping <span className="font-bold text-blue-400">💬 Reach out</span>.
              </p>
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
                className={`w-full p-4 text-left border-b border-kds-border transition-colors hover:bg-kds-bg/50 ${
                  c.id === selectedId ? 'bg-kds-bg/70' : ''
                }`}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <p className="font-semibold text-sm text-kds-text truncate">{c.customer.name}</p>
                      <span className="shrink-0 text-[10px] uppercase tracking-wider text-kds-subtext">
                        {meta.icon} {meta.label}
                      </span>
                    </div>
                    {c.subject && <p className="text-xs text-kds-subtext truncate mt-0.5">{c.subject}</p>}
                    {lastMsg && (
                      <p className="text-xs text-kds-subtext mt-1 truncate">
                        {lastMsg.fromStaff ? 'You: ' : `${c.customer.name.split(/\s+/)[0]}: `}
                        {lastMsg.body}
                      </p>
                    )}
                  </div>
                  <p className="shrink-0 text-[10px] text-kds-subtext">
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
            <div className="flex items-center justify-between border-b border-kds-border bg-kds-card px-5 py-3">
              <div className="min-w-0">
                <h2 className="font-bold text-kds-text truncate">{selected.customer.name}</h2>
                <p className="text-xs text-kds-subtext truncate">
                  {selected.subject ?? 'No subject'} · {SOURCE_META[selected.source]?.label ?? 'Manual'}
                </p>
                <div className="mt-1.5 flex flex-wrap gap-1.5">
                  {selected.customer.email && (
                    <span className="inline-flex items-center gap-1 rounded-full bg-blue-500/10 border border-blue-500/30 px-2 py-0.5 text-[10px] text-blue-400">
                      📧 {selected.customer.email}
                    </span>
                  )}
                  {selected.customer.phone && (
                    <span className="inline-flex items-center gap-1 rounded-full bg-[#25D366]/10 border border-[#25D366]/30 px-2 py-0.5 text-[10px] text-[#25D366]">
                      💬 {selected.customer.phone}
                    </span>
                  )}
                </div>
              </div>
            </div>

            <div className="flex-1 overflow-y-auto p-4 space-y-3">
              {messages.map((msg) => (
                <div key={msg.id} className={`flex ${msg.fromStaff ? 'justify-end' : 'justify-start'}`}>
                  <div className={`max-w-[70%] rounded-2xl px-4 py-2.5 ${
                    msg.fromStaff
                      ? 'bg-kds-green text-black rounded-br-sm'
                      : 'bg-kds-card border border-kds-border text-kds-text rounded-bl-sm'
                  }`}>
                    <p className="text-sm whitespace-pre-wrap">{msg.body}</p>
                    <p className={`text-xs mt-1 flex items-center gap-1.5 ${msg.fromStaff ? 'text-black/60' : 'text-kds-subtext'}`}>
                      <span>
                        {new Date(msg.createdAt).toLocaleTimeString('en-PK', { hour: '2-digit', minute: '2-digit' })}
                        {msg.fromStaff && msg.seenAt && ' · Seen'}
                      </span>
                      {!msg.fromStaff && msg.channel && msg.channel !== 'web_portal' && CHANNEL_META[msg.channel] && (
                        <span className={`inline-flex items-center gap-0.5 ${CHANNEL_META[msg.channel].color}`}
                          title={`Replied via ${CHANNEL_META[msg.channel].label}`}>
                          · {CHANNEL_META[msg.channel].icon} {CHANNEL_META[msg.channel].label}
                        </span>
                      )}
                    </p>
                  </div>
                </div>
              ))}
              {messages.length === 0 && (
                <div className="text-center mt-12">
                  <p className="text-3xl mb-2">📬</p>
                  <p className="text-sm text-kds-subtext">No messages yet</p>
                </div>
              )}
            </div>

            <div className="border-t border-kds-border bg-kds-card/40 px-4 py-1.5 text-[10px] text-kds-subtext">
              On send: <span className="text-kds-text font-semibold">{willReach.join(' · ')}</span>
            </div>

            <div className="border-t border-kds-border bg-kds-card p-3 flex gap-2">
              <textarea
                value={newMessage}
                onChange={(e) => setNewMessage(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && newMessage.trim()) { e.preventDefault(); sendMessage.mutate() } }}
                placeholder="Type a message… (Enter to send)"
                rows={2}
                className="flex-1 resize-none rounded-xl border border-kds-border bg-kds-bg px-3 py-2 text-sm text-kds-text focus:border-kds-green focus:outline-none"
              />
              <button
                onClick={() => sendMessage.mutate()}
                disabled={!newMessage.trim() || sendMessage.isPending}
                className="rounded-xl bg-kds-green px-4 py-2 font-bold text-black disabled:opacity-50 hover:opacity-90"
              >
                {sendMessage.isPending ? '…' : '➤'}
              </button>
            </div>
          </>
        ) : (
          <div className="flex flex-1 items-center justify-center bg-kds-bg/40">
            <div className="text-center max-w-sm px-6">
              <p className="text-5xl mb-3">💬</p>
              <p className="font-bold text-kds-text">Pick a conversation to read</p>
              <p className="text-sm text-kds-subtext mt-1">
                Threads start from <span className="font-bold text-blue-400">💬 Reach out</span> on a complaint or review.
              </p>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
