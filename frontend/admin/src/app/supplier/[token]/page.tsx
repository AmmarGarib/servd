'use client'
// Public supplier portal — no staff auth. Access via invite link with token.
// Suppliers can read conversations and reply to messages.

import { useState, useEffect, useRef } from 'react'
import { useParams } from 'next/navigation'

const API = process.env['NEXT_PUBLIC_API_URL'] ?? 'http://localhost:3001'

interface SupplierInfo {
  id: string
  name: string
  category: string | null
}

interface Conversation {
  id: string
  subject: string | null
  updatedAt: string
  staff: { name: string }
  messages: { body: string; fromStaff: boolean; createdAt: string }[]
  _count: { messages: number }
}

interface Message {
  id: string
  body: string
  fromStaff: boolean
  seenAt: string | null
  createdAt: string
}

async function portalGet<T>(token: string, path: string): Promise<T> {
  const res = await fetch(`${API}/api/v1/procurement/supplier-portal/${token}${path}`)
  if (!res.ok) throw new Error(`${res.status}`)
  return res.json() as Promise<T>
}

async function portalPost<T>(token: string, path: string, body: unknown): Promise<T> {
  const res = await fetch(`${API}/api/v1/procurement/supplier-portal/${token}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`${res.status}`)
  return res.json() as Promise<T>
}

export default function SupplierPortal() {
  const { token } = useParams<{ token: string }>()
  const [supplier, setSupplier] = useState<SupplierInfo | null>(null)
  const [conversations, setConvs] = useState<Conversation[]>([])
  const [selectedConvId, setSelectedConvId] = useState<string | null>(null)
  const [messages, setMessages] = useState<Message[]>([])
  const [reply, setReply] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const bottomRef = useRef<HTMLDivElement>(null)

  // Initial load
  useEffect(() => {
    portalGet<{ supplier: SupplierInfo; conversations: Conversation[] }>(token, '')
      .then(({ supplier, conversations }) => {
        setSupplier(supplier)
        setConvs(conversations)
        if (conversations.length === 1) setSelectedConvId(conversations[0]!.id)
      })
      .catch((e: Error) => setError(e.message === '404' ? 'Invalid or expired link.' : 'Could not load — please try again.'))
  }, [token])

  // Load messages when conversation selected
  useEffect(() => {
    if (!selectedConvId) return
    portalGet<Message[]>(token, `/conversations/${selectedConvId}`)
      .then(setMessages)
      .catch(() => { /* non-fatal */ })
  }, [selectedConvId, token])

  // Poll for new messages
  useEffect(() => {
    if (!selectedConvId) return
    const interval = setInterval(async () => {
      const msgs = await portalGet<Message[]>(token, `/conversations/${selectedConvId}`)
        .catch(() => null)
      if (msgs) setMessages(msgs)
    }, 5000)
    return () => clearInterval(interval)
  }, [selectedConvId, token])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  async function sendReply() {
    if (!selectedConvId || !reply.trim()) return
    setSending(true)
    try {
      await portalPost(token, `/conversations/${selectedConvId}`, { body: reply })
      setReply('')
      const msgs = await portalGet<Message[]>(token, `/conversations/${selectedConvId}`)
      setMessages(msgs)
    } catch { /* non-fatal */ }
    finally { setSending(false) }
  }

  if (error) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gray-950 text-white p-4">
        <div className="text-center">
          <div className="text-5xl mb-4">🔒</div>
          <h1 className="text-xl font-bold mb-2">Link Invalid</h1>
          <p className="text-gray-400">{error}</p>
          <p className="text-gray-500 text-sm mt-2">Contact the restaurant to get a new invite link.</p>
        </div>
      </div>
    )
  }

  if (!supplier) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gray-950 text-white">
        <div className="animate-pulse text-gray-500">Loading…</div>
      </div>
    )
  }

  const selectedConv = conversations.find((c) => c.id === selectedConvId)

  return (
    <div className="flex h-screen flex-col bg-gray-950 text-white">
      {/* Header */}
      <div className="flex items-center gap-3 border-b border-gray-800 bg-gray-900 px-4 py-3">
        <div className="flex h-9 w-9 items-center justify-center rounded-full bg-green-500 font-bold text-black text-sm">
          {supplier.name.charAt(0).toUpperCase()}
        </div>
        <div>
          <p className="font-semibold text-sm">{supplier.name}</p>
          {supplier.category && <p className="text-xs text-gray-400">{supplier.category}</p>}
        </div>
        <div className="ml-auto text-xs text-gray-500">servd supplier portal</div>
      </div>

      <div className="flex flex-1 overflow-hidden">
        {/* Conversation list (if multiple) */}
        {conversations.length > 1 && (
          <div className="w-64 shrink-0 overflow-y-auto border-r border-gray-800 bg-gray-900">
            {conversations.map((c) => (
              <button
                key={c.id}
                onClick={() => setSelectedConvId(c.id)}
                className={`w-full p-3 text-left border-b border-gray-800 hover:bg-gray-800 transition-colors
                  ${c.id === selectedConvId ? 'bg-gray-800' : ''}`}
              >
                <p className="text-sm font-medium truncate">{c.subject ?? c.staff.name}</p>
                <p className="text-xs text-gray-400">with {c.staff.name}</p>
                {c.messages[0] && (
                  <p className="text-xs text-gray-500 truncate mt-0.5">{c.messages[0].body}</p>
                )}
              </button>
            ))}
          </div>
        )}

        {/* Messages */}
        <div className="flex flex-1 flex-col">
          {selectedConv ? (
            <>
              <div className="border-b border-gray-800 bg-gray-900 px-4 py-2">
                <p className="text-sm font-medium">{selectedConv.subject ?? `Chat with ${selectedConv.staff.name}`}</p>
                <p className="text-xs text-gray-400">{selectedConv.staff.name} · {selectedConv._count.messages} messages</p>
              </div>

              <div className="flex-1 overflow-y-auto p-4 space-y-3">
                {messages.map((msg) => (
                  <div key={msg.id} className={`flex ${!msg.fromStaff ? 'justify-end' : 'justify-start'}`}>
                    <div className={`max-w-[75%] rounded-2xl px-4 py-2.5 ${
                      !msg.fromStaff
                        ? 'bg-green-500 text-black rounded-br-sm'
                        : 'bg-gray-800 text-white rounded-bl-sm'
                    }`}>
                      <p className="text-sm whitespace-pre-wrap">{msg.body}</p>
                      <p className={`text-xs mt-1 ${!msg.fromStaff ? 'text-black/60' : 'text-gray-400'}`}>
                        {new Date(msg.createdAt).toLocaleTimeString('en-PK', { hour: '2-digit', minute: '2-digit' })}
                      </p>
                    </div>
                  </div>
                ))}
                <div ref={bottomRef} />
              </div>

              <div className="border-t border-gray-800 bg-gray-900 p-3 flex gap-2">
                <textarea
                  value={reply}
                  onChange={(e) => setReply(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && reply.trim()) { e.preventDefault(); void sendReply() } }}
                  placeholder="Write your reply…"
                  rows={2}
                  className="flex-1 resize-none rounded-xl border border-gray-700 bg-gray-800 px-3 py-2 text-sm text-white placeholder-gray-500 focus:border-green-500 focus:outline-none"
                />
                <button
                  onClick={() => void sendReply()}
                  disabled={!reply.trim() || sending}
                  className="rounded-xl bg-green-500 px-4 py-2 font-bold text-black disabled:opacity-50"
                >
                  ➤
                </button>
              </div>
            </>
          ) : (
            <div className="flex flex-1 items-center justify-center">
              <p className="text-gray-500">Select a conversation</p>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
