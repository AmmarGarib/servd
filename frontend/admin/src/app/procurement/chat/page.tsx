'use client'
import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '../../../lib/api'

// ─── Types ────────────────────────────────────────────────────────────────────

interface Conversation {
  id: string
  supplierId: string
  staffId: string
  subject: string | null
  updatedAt: string
  supplier: { id: string; name: string; category: string | null; phone?: string | null; email?: string | null; whatsappPhone?: string | null }
  staff: { id: string; name: string }
  messages: { id: string; body: string; fromStaff: boolean; createdAt: string; channel?: string }[]
  _count: { messages: number }
}

interface Supplier {
  id: string
  name: string
  category: string | null
  phone?: string | null
  email?: string | null
  whatsappPhone?: string | null
  assignedStaff?: { id: string; name: string } | null
}

interface Message {
  id: string
  body: string
  fromStaff: boolean
  senderId: string | null
  seenAt: string | null
  createdAt: string
  channel?: string                 // 'web_portal' | 'email' | 'whatsapp'
  inboundFromAddress?: string | null
}

// Channel display metadata — keeps the chip render code declarative.
const CHANNEL_META: Record<string, { icon: string; label: string; color: string }> = {
  web_portal: { icon: '🌐', label: 'Portal',   color: 'text-s-muted' },
  email:      { icon: '📧', label: 'Email',    color: 'text-blue-700' },
  whatsapp:   { icon: '💬', label: 'WhatsApp', color: 'text-[#25D366]' },
}

interface PortalToken {
  id: string
  token: string
  label: string | null
  lastUsedAt: string | null
  createdAt: string
}

// ─── Constants ────────────────────────────────────────────────────────────────

const CATEGORY_PRESETS: Array<{ value: string; label: string; emoji: string; example: string }> = [
  { value: 'meat',       label: 'Meat & Poultry', emoji: '🥩', example: 'e.g. Mubarak Meat House' },
  { value: 'produce',    label: 'Vegetables & Produce', emoji: '🥬', example: 'e.g. Sabzi Mandi' },
  { value: 'dairy',      label: 'Dairy & Eggs', emoji: '🥚', example: 'e.g. Olpers Distributor' },
  { value: 'dry_goods',  label: 'Dry Goods & Spices', emoji: '🌾', example: 'e.g. Karachi Spice Co' },
  { value: 'beverages',  label: 'Beverages', emoji: '🥤', example: 'e.g. Coca-Cola Lahore' },
  { value: 'packaging',  label: 'Packaging', emoji: '📦', example: 'e.g. EcoBox Pakistan' },
  { value: 'cleaning',   label: 'Cleaning Supplies', emoji: '🧴', example: 'e.g. CleanPro' },
  { value: 'other',      label: 'Other', emoji: '🏷',  example: 'e.g. Equipment, services…' },
]

const MESSAGE_TEMPLATES = [
  { label: '📋 Weekly order',  subject: 'Weekly order',
    body: 'Hi! Would like to place this week\'s order. Please confirm availability and prices for:\n\n- \n- \n\nDelivery preferred by [day].' },
  { label: '💰 Price check',   subject: 'Price inquiry',
    body: 'Hi, can you share your latest prices for:\n\n- \n- \n\nThanks!' },
  { label: '🆕 New product',   subject: 'New product inquiry',
    body: 'Hi, do you stock [product]? If yes, what are your minimum order quantities and lead time?' },
  { label: '⏰ Delivery delay', subject: 'Delivery follow-up',
    body: 'Hi, checking on order ref [#]. When can we expect delivery?' },
  { label: '⭐ Quality issue',  subject: 'Quality concern',
    body: 'Hi, we noticed an issue with the recent delivery — [describe]. Can we discuss?' },
]

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function SupplierChatPage() {
  const qc = useQueryClient()
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [newMessage, setNewMessage] = useState('')
  const [showWizard, setShowWizard] = useState(false)

  const { data: conversations = [], isLoading: convLoading } = useQuery<Conversation[]>({
    queryKey: ['supplier-conversations'],
    queryFn: () => api.get('/procurement/conversations'),
    refetchInterval: 10_000,
  })

  const { data: suppliers = [] } = useQuery<Supplier[]>({
    queryKey: ['procurement-suppliers'],
    queryFn: () => api.get('/procurement/suppliers'),
  })

  const { data: messages = [] } = useQuery<Message[]>({
    queryKey: ['supplier-messages', selectedId],
    queryFn: () => api.get(`/procurement/conversations/${selectedId}/messages`),
    enabled: !!selectedId,
    refetchInterval: 5_000,
  })

  const sendMessage = useMutation({
    mutationFn: () => api.post(`/procurement/conversations/${selectedId}/messages`, { body: newMessage }),
    onSuccess: () => {
      setNewMessage('')
      void qc.invalidateQueries({ queryKey: ['supplier-messages', selectedId] })
      void qc.invalidateQueries({ queryKey: ['supplier-conversations'] })
    },
  })

  const selectedConv = conversations.find((c) => c.id === selectedId)
  const showFirstRun = !convLoading && conversations.length === 0 && suppliers.length === 0

  // ── First-run state: full-page onboarding hero ─────────────────────────────
  if (showFirstRun) {
    return (
      <>
        <FirstRunHero onAddSupplier={() => setShowWizard(true)} />
        {showWizard && (
          <SupplierOnboardingWizard
            existingSuppliers={suppliers}
            onClose={() => setShowWizard(false)}
            onCreated={(convId) => {
              setShowWizard(false)
              setSelectedId(convId)
              void qc.invalidateQueries({ queryKey: ['supplier-conversations'] })
              void qc.invalidateQueries({ queryKey: ['procurement-suppliers'] })
            }}
          />
        )}
      </>
    )
  }

  return (
    <div className="flex h-screen bg-s-bg">
      {/* Sidebar */}
      <div className="w-80 shrink-0 flex flex-col border-r border-s-border bg-s-surface">
        <div className="flex items-center justify-between p-4 border-b border-s-border">
          <div>
            <h1 className="font-black text-s-text">Suppliers</h1>
            <p className="text-xs text-s-muted mt-0.5">{conversations.length} active · {suppliers.length} total</p>
          </div>
          <button
            onClick={() => setShowWizard(true)}
            className="rounded-lg bg-primary px-3 py-1.5 text-xs font-bold text-primary-on hover:opacity-90"
          >
            + Add
          </button>
        </div>

        <div className="flex-1 overflow-y-auto">
          {convLoading && <p className="p-4 text-sm text-s-muted">Loading…</p>}

          {/* Active conversations */}
          {conversations.map((c) => {
            const lastMsg = c.messages[0]
            const lastDate = new Date(c.updatedAt)
            const isToday = lastDate.toDateString() === new Date().toDateString()
            return (
              <button
                key={c.id}
                onClick={() => setSelectedId(c.id)}
                className={`w-full p-4 text-left border-b border-s-border transition-colors hover:bg-s-bg/50 ${
                  c.id === selectedId ? 'bg-accent-dim shadow-[inset_3px_0_0_rgb(var(--erp-accent-rgb))]' : ''
                }`}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <p className="font-semibold text-sm text-s-text truncate">{c.supplier.name}</p>
                      {c.supplier.category && (
                        <span className="shrink-0 text-[10px] uppercase tracking-wider text-s-muted">
                          {c.supplier.category}
                        </span>
                      )}
                    </div>
                    {c.subject && <p className="text-xs text-s-muted truncate mt-0.5">{c.subject}</p>}
                    {lastMsg && (
                      <p className="text-xs text-s-muted mt-1 truncate">
                        {lastMsg.fromStaff ? 'You: ' : `${c.supplier.name}: `}
                        {lastMsg.body}
                      </p>
                    )}
                  </div>
                  <div className="shrink-0 text-right">
                    <p className="text-[10px] text-s-muted">
                      {isToday
                        ? lastDate.toLocaleTimeString('en-PK', { hour: '2-digit', minute: '2-digit' })
                        : lastDate.toLocaleDateString('en-PK', { day: 'numeric', month: 'short' })}
                    </p>
                  </div>
                </div>
              </button>
            )
          })}

          {/* Suppliers without conversations yet */}
          {suppliers
            .filter((s) => !conversations.some((c) => c.supplierId === s.id))
            .map((s) => (
              <SupplierStartCard
                key={s.id}
                supplier={s}
                onCreated={(convId) => {
                  setSelectedId(convId)
                  void qc.invalidateQueries({ queryKey: ['supplier-conversations'] })
                }}
              />
            ))}

          {!convLoading && conversations.length === 0 && suppliers.length > 0 && (
            <div className="p-6 text-center">
              <p className="text-3xl mb-2">💬</p>
              <p className="text-sm font-semibold text-s-text">Start your first conversation</p>
              <p className="text-xs text-s-muted mt-1">Pick a supplier above to begin chatting.</p>
            </div>
          )}
        </div>
      </div>

      {/* Message thread */}
      <div className="flex flex-1 flex-col">
        {selectedConv ? (
          <ConversationView
            conversation={selectedConv}
            messages={messages}
            newMessage={newMessage}
            setNewMessage={setNewMessage}
            sending={sendMessage.isPending}
            onSend={() => sendMessage.mutate()}
          />
        ) : (
          <div className="flex flex-1 items-center justify-center bg-s-bg/40">
            <div className="text-center max-w-sm px-6">
              <p className="text-5xl mb-3">💬</p>
              <p className="font-bold text-s-text">Pick a conversation to read</p>
              <p className="text-sm text-s-muted mt-1">
                Or hit <span className="font-bold text-primary-ink">+ Add</span> to onboard a new supplier in 30 seconds.
              </p>
            </div>
          </div>
        )}
      </div>

      {/* Wizard overlay */}
      {showWizard && (
        <SupplierOnboardingWizard
          existingSuppliers={suppliers}
          onClose={() => setShowWizard(false)}
          onCreated={(convId) => {
            setShowWizard(false)
            setSelectedId(convId)
            void qc.invalidateQueries({ queryKey: ['supplier-conversations'] })
            void qc.invalidateQueries({ queryKey: ['procurement-suppliers'] })
          }}
        />
      )}
    </div>
  )
}

// ─── First-run hero ───────────────────────────────────────────────────────────

function FirstRunHero({ onAddSupplier }: { onAddSupplier: () => void }) {
  return (
    <div className="flex h-screen flex-col items-center justify-center bg-s-bg p-8">
      <div className="max-w-2xl w-full">
        <div className="text-center mb-10">
          <span className="text-6xl">🏭</span>
          <h1 className="mt-4 text-3xl font-black text-s-text">Connect with your suppliers</h1>
          <p className="mt-3 text-s-muted max-w-md mx-auto leading-relaxed">
            Skip the WhatsApp scramble. Add your meat, produce, and dry-goods suppliers — they get a private portal link, you get every order in one thread.
          </p>
        </div>

        {/* Three example category tiles */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-8">
          {CATEGORY_PRESETS.slice(0, 3).map((cat) => (
            <div key={cat.value} className="rounded-xl border border-s-border bg-s-surface/50 p-4">
              <p className="text-3xl mb-2">{cat.emoji}</p>
              <p className="font-bold text-sm text-s-text">{cat.label}</p>
              <p className="text-xs text-s-muted mt-0.5">{cat.example}</p>
            </div>
          ))}
        </div>

        {/* How it works */}
        <div className="rounded-2xl border border-s-border bg-s-surface/40 p-5 mb-6">
          <p className="text-xs font-bold uppercase tracking-wider text-s-muted mb-3">How it works</p>
          <ol className="space-y-3 text-sm text-s-text">
            <li className="flex gap-3">
              <span className="shrink-0 h-6 w-6 rounded-full bg-primary text-primary-on font-black text-xs flex items-center justify-center">1</span>
              <span>Add the supplier — name, category, phone or email.</span>
            </li>
            <li className="flex gap-3">
              <span className="shrink-0 h-6 w-6 rounded-full bg-primary text-primary-on font-black text-xs flex items-center justify-center">2</span>
              <span>Send them a portal link via WhatsApp — one tap, pre-filled.</span>
            </li>
            <li className="flex gap-3">
              <span className="shrink-0 h-6 w-6 rounded-full bg-primary text-primary-on font-black text-xs flex items-center justify-center">3</span>
              <span>Pick a message template, send your first order. Done.</span>
            </li>
          </ol>
        </div>

        <button
          onClick={onAddSupplier}
          className="w-full rounded-xl bg-primary py-4 font-black text-primary-on hover:opacity-90 transition-opacity"
        >
          Add your first supplier →
        </button>
        <p className="text-center text-xs text-s-muted mt-3">
          Takes about 30 seconds. You can edit details later.
        </p>
      </div>
    </div>
  )
}

// ─── Supplier card (in sidebar) without conversation yet ─────────────────────

function SupplierStartCard({ supplier, onCreated }: { supplier: Supplier; onCreated: (id: string) => void }) {
  const [opening, setOpening] = useState(false)
  const open = useMutation({
    mutationFn: () =>
      api.post<{ id: string }>('/procurement/conversations', {
        supplierId: supplier.id,
        message: `Hi ${supplier.name}, just connecting on the portal. We'll send orders here.`,
      }),
    onSuccess: (data) => { onCreated(data.id); setOpening(false) },
    onError: () => setOpening(false),
  })
  return (
    <button
      onClick={() => { setOpening(true); open.mutate() }}
      disabled={opening}
      className="w-full p-4 text-left border-b border-s-border bg-s-bg/20 hover:bg-s-bg/50 transition-colors disabled:opacity-50"
    >
      <div className="flex items-center justify-between">
        <div className="min-w-0">
          <p className="font-semibold text-sm text-s-text truncate">{supplier.name}</p>
          <p className="text-xs text-s-muted">
            {supplier.category && <>{supplier.category} · </>}
            <span className="text-s-amber">No messages yet</span>
          </p>
        </div>
        <span className="shrink-0 text-xs font-bold text-primary-ink">{opening ? '…' : 'Start →'}</span>
      </div>
    </button>
  )
}

// ─── Conversation view (with WhatsApp invite + templates) ────────────────────

function ConversationView({
  conversation,
  messages,
  newMessage,
  setNewMessage,
  sending,
  onSend,
}: {
  conversation: Conversation
  messages: Message[]
  newMessage: string
  setNewMessage: (v: string) => void
  sending: boolean
  onSend: () => void
}) {
  const supplier = conversation.supplier
  // Resolved channels we'll fan-out to when staff hits send. Drives the
  // "Will reach via" hint above the input so operators know what's happening.
  const willReach = [
    '🌐 Portal',
    supplier.email ? '📧 ' + supplier.email : null,
    (supplier.whatsappPhone ?? supplier.phone) ? '💬 WhatsApp' : null,
  ].filter(Boolean) as string[]

  return (
    <>
      <div className="flex items-center justify-between border-b border-s-border bg-s-surface px-5 py-3">
        <div className="min-w-0">
          <h2 className="font-bold text-s-text truncate">{conversation.supplier.name}</h2>
          <p className="text-xs text-s-muted truncate">
            {conversation.supplier.category && `${conversation.supplier.category} · `}
            {conversation.subject ?? 'No subject'} · with {conversation.staff.name}
          </p>
          {/* Contact methods — shows operator which channels are wired up. Each
              chip is a quick-edit affordance; click "+ add" if missing. */}
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {supplier.email && (
              <span className="inline-flex items-center gap-1 rounded-full bg-blue-500/10 border border-blue-500/30 px-2 py-0.5 text-[10px] text-blue-700">
                📧 {supplier.email}
              </span>
            )}
            {(supplier.whatsappPhone ?? supplier.phone) && (
              <span className="inline-flex items-center gap-1 rounded-full bg-[#25D366]/10 border border-[#25D366]/30 px-2 py-0.5 text-[10px] text-[#25D366]">
                💬 {supplier.whatsappPhone ?? supplier.phone}
              </span>
            )}
            {!supplier.email && !supplier.whatsappPhone && !supplier.phone && (
              <span className="text-[10px] text-s-muted italic">
                No email or WhatsApp on file — only the portal link works.
              </span>
            )}
          </div>
        </div>
        <PortalTokenButton
          supplierId={conversation.supplierId}
          supplierName={conversation.supplier.name}
          supplierPhone={conversation.supplier.phone ?? null}
        />
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
                <p className={`text-xs mt-1 flex items-center gap-1.5 ${msg.fromStaff ? 'text-primary-on/70' : 'text-s-muted'}`}>
                  <span>
                    {new Date(msg.createdAt).toLocaleTimeString('en-PK', { hour: '2-digit', minute: '2-digit' })}
                    {msg.fromStaff && msg.seenAt && ' · Seen'}
                  </span>
                  {/* Channel chip — only shows non-default origins, since the
                      staff side is always portal-originated. Inbound replies
                      via email/WA stand out so operators know their messages
                      are reaching suppliers through real channels. */}
                  {channelMeta && (
                    <span className={`inline-flex items-center gap-0.5 ${channelMeta.color}`} title={`Replied via ${channelMeta.label}`}>
                      · {channelMeta.icon} {channelMeta.label}
                    </span>
                  )}
                </p>
              </div>
            </div>
          )
        })}
        {messages.length === 0 && (
          <div className="text-center mt-12">
            <p className="text-3xl mb-2">📬</p>
            <p className="text-sm text-s-muted">No messages yet — pick a template below to start.</p>
          </div>
        )}
      </div>

      {/* Template chips above input — visible only when input is empty */}
      {newMessage.trim().length === 0 && messages.length < 5 && (
        <div className="border-t border-s-border bg-s-surface/60 px-3 pt-2 pb-1 flex gap-1.5 overflow-x-auto">
          {MESSAGE_TEMPLATES.map((tpl) => (
            <button
              key={tpl.label}
              onClick={() => setNewMessage(tpl.body)}
              className="shrink-0 rounded-full border border-s-border bg-s-bg px-3 py-1 text-xs text-s-muted hover:text-s-text hover:border-primary transition-colors"
            >
              {tpl.label}
            </button>
          ))}
        </div>
      )}

      {/* Channel reach hint — surfaces which channels this message will fan
          out to. Reduces "did the supplier actually get this?" anxiety, and
          when a channel is missing it nudges operators to add the contact info. */}
      <div className="border-t border-s-border bg-s-surface/40 px-4 py-1.5 flex items-center justify-between text-[10px]">
        <span className="text-s-muted">
          On send: <span className="text-s-text font-semibold">{willReach.join(' · ')}</span>
        </span>
        {willReach.length === 1 && (
          <span className="text-s-amber">⚠ Only the portal — supplier sees nothing until they open the link.</span>
        )}
      </div>

      <div className="border-t border-s-border bg-s-surface p-3 flex gap-2">
        <textarea
          value={newMessage}
          onChange={(e) => setNewMessage(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && newMessage.trim()) { e.preventDefault(); onSend() } }}
          placeholder="Type a message… (Enter to send)"
          rows={2}
          className="flex-1 resize-none rounded-xl border border-s-border bg-s-bg px-3 py-2 text-sm text-s-text focus:border-primary focus:outline-none"
        />
        <button
          onClick={onSend}
          disabled={!newMessage.trim() || sending}
          className="rounded-xl bg-primary px-4 py-2 font-bold text-primary-on disabled:opacity-50 hover:opacity-90"
        >
          {sending ? '…' : '➤'}
        </button>
      </div>
    </>
  )
}

// ─── Portal token button (with WhatsApp share) ───────────────────────────────

function PortalTokenButton({
  supplierId,
  supplierName,
  supplierPhone,
}: { supplierId: string; supplierName: string; supplierPhone: string | null }) {
  const [token, setToken] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  // Check for an existing token first
  useQuery<PortalToken[]>({
    queryKey: ['supplier-portal-tokens', supplierId],
    queryFn: () => api.get(`/procurement/suppliers/${supplierId}/portal-tokens`),
    onSuccess: (tokens: PortalToken[]) => {
      const fresh = tokens?.[0]
      if (fresh && !token) setToken(fresh.token)
    },
  } as never)

  const generate = useMutation({
    mutationFn: () => api.post<{ token: string }>(`/procurement/suppliers/${supplierId}/portal-token`, {}),
    onSuccess: (data) => setToken(data.token),
  })

  const link = token && typeof window !== 'undefined'
    ? `${window.location.origin}/supplier/${token}`
    : null

  const waMessage = `Hi ${supplierName}, here's your private portal link to chat with our kitchen team:\n${link}\n\nNo download needed — just open in any browser.`
  const waNumber = (supplierPhone ?? '').replace(/[^0-9]/g, '')
  const waUrl = link && waNumber
    ? `https://wa.me/${waNumber}?text=${encodeURIComponent(waMessage)}`
    : null

  function copy() {
    if (!link) return
    navigator.clipboard.writeText(link)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  if (!link) {
    return (
      <button
        onClick={() => generate.mutate()}
        disabled={generate.isPending}
        className="rounded-lg border border-s-border px-3 py-1.5 text-xs text-s-muted hover:text-s-text"
      >
        {generate.isPending ? 'Generating…' : '🔗 Invite supplier'}
      </button>
    )
  }

  return (
    <div className="flex items-center gap-1.5">
      {waUrl && (
        <a
          href={waUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="rounded-lg bg-[#25D366] text-bone px-3 py-1.5 text-xs font-bold hover:opacity-90"
        >
          📱 WhatsApp
        </a>
      )}
      <button
        onClick={copy}
        className={`rounded-lg border px-3 py-1.5 text-xs font-bold transition-colors ${
          copied ? 'border-accent text-success' : 'border-s-border text-s-muted hover:text-s-text'
        }`}
      >
        {copied ? '✓ Copied' : '📋 Copy link'}
      </button>
    </div>
  )
}

// ─── Onboarding wizard (3 steps) ──────────────────────────────────────────────

function SupplierOnboardingWizard({
  existingSuppliers,
  onClose,
  onCreated,
}: {
  existingSuppliers: Supplier[]
  onClose: () => void
  onCreated: (conversationId: string) => void
}) {
  const [step, setStep] = useState<1 | 2 | 3>(1)
  const [mode, setMode] = useState<'new' | 'existing'>(existingSuppliers.length > 0 ? 'existing' : 'new')

  const [supplierId, setSupplierId] = useState<string>('')
  const [name, setName] = useState('')
  const [category, setCategory] = useState('meat')
  const [phone, setPhone] = useState('')
  const [whatsappPhone, setWhatsappPhone] = useState('')
  const [email, setEmail] = useState('')

  const [portalToken, setPortalToken] = useState<string | null>(null)

  const [subject, setSubject] = useState('')
  const [message, setMessage] = useState('')

  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const createSupplier = useMutation({
    mutationFn: () =>
      api.post<{ id: string }>('/procurement/suppliers', {
        name: name.trim(),
        phone: phone.trim() || undefined,
        whatsappPhone: whatsappPhone.trim() || undefined,
        email: email.trim() || undefined,
      }).then(async (s) => {
        // Persist category via the PATCH endpoint (matches existing API surface)
        if (category) {
          await api.patch(`/procurement/suppliers/${s.id}`, { category })
        }
        return s
      }),
  })

  const generateToken = useMutation({
    mutationFn: (id: string) => api.post<{ token: string }>(`/procurement/suppliers/${id}/portal-token`, {}),
  })

  const startConversation = useMutation({
    mutationFn: (id: string) =>
      api.post<{ id: string }>('/procurement/conversations', {
        supplierId: id,
        subject: subject || undefined,
        message: message.trim(),
      }),
  })

  async function handleStep1Next() {
    setError(null)
    if (mode === 'existing') {
      if (!supplierId) return setError('Pick a supplier or switch to "New supplier"')
      // Generate or fetch portal token for existing supplier
      setBusy(true)
      try {
        const t = await generateToken.mutateAsync(supplierId)
        setPortalToken(t.token)
        setStep(2)
      } catch { setError('Failed to generate portal link') }
      finally { setBusy(false) }
      return
    }
    if (!name.trim()) return setError('Supplier name is required')
    if (!phone.trim() && !email.trim()) return setError('Add a phone OR email so you can invite them')
    setBusy(true)
    try {
      const s = await createSupplier.mutateAsync()
      setSupplierId(s.id)
      const t = await generateToken.mutateAsync(s.id)
      setPortalToken(t.token)
      setStep(2)
    } catch { setError('Failed to create supplier') }
    finally { setBusy(false) }
  }

  async function handleStep3Finish() {
    setError(null)
    if (!message.trim()) return setError('Type a message or pick a template')
    setBusy(true)
    try {
      const conv = await startConversation.mutateAsync(supplierId)
      onCreated(conv.id)
    } catch { setError('Failed to start conversation') }
    finally { setBusy(false) }
  }

  const portalLink = portalToken && typeof window !== 'undefined'
    ? `${window.location.origin}/supplier/${portalToken}`
    : null

  const selectedSupplier = existingSuppliers.find((s) => s.id === supplierId)
  const supplierPhoneForWa = (mode === 'existing' ? selectedSupplier?.phone : phone)?.replace(/[^0-9]/g, '') ?? ''
  const supplierNameForWa = mode === 'existing' ? selectedSupplier?.name ?? '' : name

  const waMessage = `Hi ${supplierNameForWa}, here's your private portal link to chat with our kitchen team:\n${portalLink}\n\nNo download — just open in any browser.`
  const waUrl = portalLink && supplierPhoneForWa
    ? `https://wa.me/${supplierPhoneForWa}?text=${encodeURIComponent(waMessage)}`
    : null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-secondary/50 p-4" onClick={onClose}>
      <div
        className="w-full max-w-lg rounded-2xl bg-s-surface border border-s-border shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Step indicator */}
        <div className="flex items-center justify-between border-b border-s-border px-5 py-3">
          <div className="flex items-center gap-2">
            {[1, 2, 3].map((n) => (
              <div key={n} className="flex items-center gap-2">
                <div
                  className={`h-7 w-7 rounded-full flex items-center justify-center text-xs font-black ${
                    step > n
                      ? 'bg-accent text-accent-on'
                      : step === n
                      ? 'bg-primary text-primary-on'
                      : 'bg-s-bg text-s-muted border border-s-border'
                  }`}
                >
                  {step > n ? '✓' : n}
                </div>
                {n < 3 && <div className={`h-px w-8 ${step > n ? 'bg-accent' : 'bg-s-border'}`} />}
              </div>
            ))}
          </div>
          <button onClick={onClose} className="text-s-muted text-2xl leading-none hover:text-s-text">✕</button>
        </div>

        <div className="p-5 max-h-[70vh] overflow-y-auto">
          {/* ── Step 1: Supplier details ─────────────────────────────────── */}
          {step === 1 && (
            <div className="space-y-5">
              <div>
                <h2 className="text-lg font-black text-s-text">Who are we onboarding?</h2>
                <p className="text-sm text-s-muted mt-0.5">Pick from your existing suppliers, or add a new one.</p>
              </div>

              {existingSuppliers.length > 0 && (
                <div className="flex rounded-lg border border-s-border overflow-hidden text-xs font-bold">
                  <button
                    onClick={() => setMode('existing')}
                    className={`flex-1 px-3 py-2 ${mode === 'existing' ? 'bg-accent-dim text-s-text' : 'text-s-muted'}`}
                  >
                    Existing supplier
                  </button>
                  <button
                    onClick={() => setMode('new')}
                    className={`flex-1 px-3 py-2 border-l border-s-border ${mode === 'new' ? 'bg-accent-dim text-s-text' : 'text-s-muted'}`}
                  >
                    New supplier
                  </button>
                </div>
              )}

              {mode === 'existing' ? (
                <div>
                  <label className="text-xs text-s-muted">Supplier *</label>
                  <select
                    value={supplierId}
                    onChange={(e) => setSupplierId(e.target.value)}
                    className="w-full mt-1 rounded-lg border border-s-border bg-s-bg px-3 py-2.5 text-s-text focus:border-primary focus:outline-none text-sm"
                  >
                    <option value="">Select…</option>
                    {existingSuppliers.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}{s.category ? ` (${s.category})` : ''}
                      </option>
                    ))}
                  </select>
                </div>
              ) : (
                <>
                  <div>
                    <label className="text-xs text-s-muted">Supplier name *</label>
                    <input
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      placeholder="e.g. Mubarak Meat House"
                      className="w-full mt-1 rounded-lg border border-s-border bg-s-bg px-3 py-2.5 text-s-text focus:border-primary focus:outline-none text-sm"
                      autoFocus
                    />
                  </div>
                  <div>
                    <label className="text-xs text-s-muted">Category</label>
                    <div className="grid grid-cols-2 gap-1.5 mt-1">
                      {CATEGORY_PRESETS.map((cat) => (
                        <button
                          key={cat.value}
                          onClick={() => setCategory(cat.value)}
                          className={`flex items-center gap-2 rounded-lg border px-3 py-2 text-xs font-semibold text-left transition-colors ${
                            category === cat.value
                              ? 'border-accent bg-accent-dim text-s-text'
                              : 'border-s-border text-s-muted hover:text-s-text'
                          }`}
                        >
                          <span className="text-base">{cat.emoji}</span>
                          {cat.label}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="text-xs text-s-muted">Phone (calls)</label>
                      <input
                        value={phone}
                        onChange={(e) => {
                          setPhone(e.target.value)
                          // Auto-mirror into WhatsApp field if it's empty — most
                          // suppliers use the same number for both. User can
                          // override if they have separate lines.
                          if (!whatsappPhone) setWhatsappPhone(e.target.value)
                        }}
                        placeholder="+92 300 1234567"
                        className="w-full mt-1 rounded-lg border border-s-border bg-s-bg px-3 py-2.5 text-s-text focus:border-primary focus:outline-none text-sm"
                      />
                    </div>
                    <div>
                      <label className="text-xs text-s-muted">Email</label>
                      <input
                        value={email}
                        onChange={(e) => setEmail(e.target.value)}
                        placeholder="orders@supplier.com"
                        className="w-full mt-1 rounded-lg border border-s-border bg-s-bg px-3 py-2.5 text-s-text focus:border-primary focus:outline-none text-sm"
                      />
                    </div>
                  </div>
                  <div>
                    <label className="text-xs text-s-muted">WhatsApp number <span className="text-s-muted/60">(if different from phone)</span></label>
                    <input
                      value={whatsappPhone}
                      onChange={(e) => setWhatsappPhone(e.target.value)}
                      placeholder="+92 300 1234567"
                      className="w-full mt-1 rounded-lg border border-s-border bg-s-bg px-3 py-2.5 text-s-text focus:border-primary focus:outline-none text-sm"
                    />
                  </div>
                  <p className="text-xs text-s-muted">
                    💡 Email and WhatsApp both auto-deliver every message — supplier replies route back here as a chat.
                  </p>
                </>
              )}
            </div>
          )}

          {/* ── Step 2: Send invite ─────────────────────────────────────── */}
          {step === 2 && (
            <div className="space-y-5">
              <div>
                <h2 className="text-lg font-black text-s-text">Send them the portal link</h2>
                <p className="text-sm text-s-muted mt-0.5">
                  Suppliers don't need to install anything — they just open the link in WhatsApp's browser.
                </p>
              </div>

              <div className="rounded-xl border border-s-border bg-s-bg p-3">
                <p className="text-[10px] uppercase tracking-wider text-s-muted font-bold">Portal link</p>
                <p className="text-xs font-mono text-primary-ink break-all mt-1">{portalLink}</p>
              </div>

              <div className="grid grid-cols-1 gap-2">
                {waUrl ? (
                  <a
                    href={waUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center justify-center gap-2 rounded-xl bg-[#25D366] text-bone py-3 font-black hover:opacity-90"
                  >
                    📱 Send via WhatsApp
                  </a>
                ) : (
                  <div className="rounded-xl border border-dashed border-s-border p-3 text-center text-xs text-s-muted">
                    No phone on file — copy the link below or add a phone in step 1 to enable WhatsApp.
                  </div>
                )}
                <button
                  onClick={() => {
                    if (!portalLink) return
                    navigator.clipboard.writeText(portalLink)
                  }}
                  className="rounded-xl border border-s-border py-2.5 text-sm text-s-muted hover:text-s-text"
                >
                  📋 Copy link to clipboard
                </button>
                {email && (
                  <a
                    href={`mailto:${email}?subject=${encodeURIComponent('Your supplier portal')}&body=${encodeURIComponent(waMessage)}`}
                    className="rounded-xl border border-s-border py-2.5 text-sm text-s-muted hover:text-s-text text-center"
                  >
                    ✉ Email the link instead
                  </a>
                )}
              </div>

              <p className="text-xs text-s-muted text-center">
                Skip this if you'd rather invite later — they'll get a link when you tap <span className="font-bold">🔗 Invite</span> in the chat.
              </p>
            </div>
          )}

          {/* ── Step 3: First message ────────────────────────────────────── */}
          {step === 3 && (
            <div className="space-y-5">
              <div>
                <h2 className="text-lg font-black text-s-text">Send your first message</h2>
                <p className="text-sm text-s-muted mt-0.5">Pick a template or write your own.</p>
              </div>

              <div className="flex gap-1.5 flex-wrap">
                {MESSAGE_TEMPLATES.map((tpl) => (
                  <button
                    key={tpl.label}
                    onClick={() => { setSubject(tpl.subject); setMessage(tpl.body) }}
                    className="rounded-full border border-s-border bg-s-bg px-3 py-1 text-xs text-s-muted hover:text-s-text hover:border-primary transition-colors"
                  >
                    {tpl.label}
                  </button>
                ))}
              </div>

              <div>
                <label className="text-xs text-s-muted">Subject (optional)</label>
                <input
                  value={subject}
                  onChange={(e) => setSubject(e.target.value)}
                  placeholder="Weekly order, Price query…"
                  className="w-full mt-1 rounded-lg border border-s-border bg-s-bg px-3 py-2 text-s-text focus:border-primary focus:outline-none text-sm"
                />
              </div>
              <div>
                <label className="text-xs text-s-muted">Message *</label>
                <textarea
                  value={message}
                  onChange={(e) => setMessage(e.target.value)}
                  rows={6}
                  placeholder="Hi! Would like to place this week's order…"
                  className="w-full mt-1 rounded-lg border border-s-border bg-s-bg px-3 py-2 text-s-text focus:border-primary focus:outline-none text-sm resize-none"
                />
              </div>
            </div>
          )}

          {error && (
            <p className="mt-4 rounded-lg border border-s-red/40 bg-s-red/10 px-3 py-2 text-xs text-s-red">{error}</p>
          )}
        </div>

        <div className="flex items-center justify-between gap-3 border-t border-s-border bg-s-bg/40 p-4">
          <button
            onClick={() => (step === 1 ? onClose() : setStep((step - 1) as 1 | 2 | 3))}
            className="rounded-xl border border-s-border px-4 py-2.5 text-sm text-s-muted hover:text-s-text"
          >
            {step === 1 ? 'Cancel' : '← Back'}
          </button>
          {step === 1 && (
            <button
              onClick={handleStep1Next}
              disabled={busy}
              className="rounded-xl bg-primary px-5 py-2.5 text-sm font-black text-primary-on hover:opacity-90 disabled:opacity-50"
            >
              {busy ? 'Saving…' : 'Next: Send invite →'}
            </button>
          )}
          {step === 2 && (
            <button
              onClick={() => setStep(3)}
              className="rounded-xl bg-primary px-5 py-2.5 text-sm font-black text-primary-on hover:opacity-90"
            >
              Next: First message →
            </button>
          )}
          {step === 3 && (
            <button
              onClick={handleStep3Finish}
              disabled={busy || !message.trim()}
              className="rounded-xl bg-primary px-5 py-2.5 text-sm font-black text-primary-on hover:opacity-90 disabled:opacity-50"
            >
              {busy ? 'Starting…' : 'Send & open chat'}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
