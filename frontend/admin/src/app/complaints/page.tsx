'use client'
import { useState, useEffect, useRef } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '../../lib/api'
import Link from 'next/link'
import { ReachOutModal } from '../../components/crm/ReachOutModal'
import { TenantChip, useMyTenants } from '../../components/ui/TenantPicker'

interface Complaint {
  id: string
  orderId: string | null
  conceptId: string
  title: string
  description: string
  category: string
  status: 'open' | 'in_progress' | 'resolved' | 'closed'
  priority: 'low' | 'medium' | 'high' | 'urgent'
  resolution: string | null
  resolvedAt: string | null
  createdAt: string
  // Concept comes with its tenant in portfolio mode — drives the indigo
  // brand chip on each complaint row.
  concept: {
    name: string; slug: string; tenantId?: string | null
    tenant?: { id: string; name: string; slug: string } | null
  }
  order: {
    id: string; source: string; customerName: string | null; placedAt: string
    customer?: { id: string; name: string; email: string | null; phone: string | null } | null
  } | null
}

interface ComplaintsResponse {
  complaints: Complaint[]
  stats: { total: number; open: number; resolved: number; inProgress: number }
}

interface Concept { id: string; name: string }

const STATUS_COLORS: Record<string, string> = {
  open: 'bg-s-red/20 text-s-red',
  in_progress: 'bg-s-amber/20 text-s-amber',
  resolved: 'bg-primary/20 text-primary-ink',
  closed: 'bg-s-border text-s-muted',
}

const PRIORITY_COLORS: Record<string, string> = {
  urgent: 'text-s-red font-bold',
  high: 'text-s-amber font-semibold',
  medium: 'text-s-text',
  low: 'text-s-muted',
}

const CATEGORIES = ['wrong_item', 'missing_item', 'quality', 'service', 'delivery', 'other']

const RESOLUTION_TEMPLATES = [
  'Refund issued to customer',
  'Replacement dispatched',
  'Apologies sent + 10% off next order',
  'Escalated to senior management',
  'Customer contacted and issue resolved',
]

function AgeBadge({ createdAt, now }: { createdAt: string; now: number }) {
  const diffMs = now - new Date(createdAt).getTime()
  const diffMins = Math.floor(diffMs / 60000)
  const diffHours = diffMs / 3600000
  const diffDays = Math.floor(diffHours / 24)

  if (diffMins < 120) {
    return (
      <span className="text-xs text-s-muted whitespace-nowrap">
        {diffMins < 1 ? 'just now' : `${diffMins}m ago`}
      </span>
    )
  }
  if (diffHours < 24) {
    return (
      <span className="text-xs font-semibold text-s-amber whitespace-nowrap">
        ⚠ {Math.floor(diffHours)}h
      </span>
    )
  }
  return (
    <span className="text-xs font-bold text-s-red whitespace-nowrap">
      🔥 {diffDays}d — overdue
    </span>
  )
}

export default function ComplaintsPage() {
  const qc = useQueryClient()
  const { data: tenants = [] } = useMyTenants()
  const [statusFilter, setStatusFilter] = useState('')
  const [priorityFilter, setPriorityFilter] = useState('')
  const [conceptFilter, setConceptFilter] = useState('')
  const [showNew, setShowNew] = useState(false)
  const [resolving, setResolving] = useState<string | null>(null)
  const [resolution, setResolution] = useState('')
  const [reachingOut, setReachingOut] = useState<Complaint | null>(null)
  const [newForm, setNewForm] = useState({
    conceptId: '', title: '', description: '', category: 'quality',
    priority: 'medium', orderId: '',
  })
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [now, setNow] = useState(Date.now())
  const [templateOpen, setTemplateOpen] = useState<string | null>(null)
  const templateRef = useRef<HTMLDivElement>(null)

  // Refresh age badges every minute
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 60000)
    return () => clearInterval(t)
  }, [])

  // Close template dropdown on outside click
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (templateRef.current && !templateRef.current.contains(e.target as Node)) {
        setTemplateOpen(null)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [])

  const { data: concepts = [] } = useQuery({
    queryKey: ['concepts'],
    queryFn: () => api.get<Concept[]>('/concepts'),
  })

  const { data, isLoading } = useQuery({
    queryKey: ['complaints', statusFilter, priorityFilter, conceptFilter],
    queryFn: () => api.get<ComplaintsResponse>(
      `/complaints?${new URLSearchParams({
        ...(statusFilter && { status: statusFilter }),
        ...(priorityFilter && { priority: priorityFilter }),
        ...(conceptFilter && { conceptId: conceptFilter }),
        limit: '100',
      }).toString()}`
    ),
  })

  const createMutation = useMutation({
    mutationFn: (body: typeof newForm) => api.post('/complaints', body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['complaints'] })
      setShowNew(false)
      setNewForm({ conceptId: '', title: '', description: '', category: 'quality', priority: 'medium', orderId: '' })
    },
  })

  const updateMutation = useMutation({
    mutationFn: ({ id, body }: { id: string; body: Record<string, unknown> }) =>
      api.patch(`/complaints/${id}`, body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['complaints'] })
      setResolving(null)
      setResolution('')
    },
  })

  async function bulkUpdate(status: string) {
    await Promise.all([...selectedIds].map(id => api.patch(`/complaints/${id}`, { status })))
    setSelectedIds(new Set())
    void qc.invalidateQueries({ queryKey: ['complaints'] })
  }

  function toggleSelect(id: string) {
    setSelectedIds(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const complaints = data?.complaints ?? []
  const stats = data?.stats ?? { total: 0, open: 0, resolved: 0, inProgress: 0 }

  return (
    <div className="min-h-screen bg-s-bg p-6 pb-24">
      <header className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-black text-s-text mt-1">Order Complaints</h1>
        </div>
        <button onClick={() => setShowNew(true)}
          className="rounded-xl bg-primary text-primary-on font-bold px-4 py-2 text-sm hover:opacity-90">
          + New complaint
        </button>
      </header>

      {/* Stats */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-6">
        {[
          { label: 'Total', value: stats.total, color: 'text-s-text' },
          { label: 'Open', value: stats.open, color: 'text-s-red' },
          { label: 'In progress', value: stats.inProgress, color: 'text-s-amber' },
          { label: 'Resolved', value: stats.resolved, color: 'text-primary-ink' },
        ].map((s) => (
          <div key={s.label} className="rounded-xl border border-s-border bg-s-surface p-4">
            <p className="text-xs text-s-muted">{s.label}</p>
            <p className={`text-3xl font-black ${s.color}`}>{s.value}</p>
          </div>
        ))}
      </div>

      {/* New complaint form */}
      {showNew && (
        <div className="mb-6 rounded-xl border border-primary bg-s-surface p-4 space-y-3">
          <h3 className="font-bold text-s-text">Log Complaint</h3>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs text-s-muted">Concept</label>
              <select value={newForm.conceptId} onChange={(e) => setNewForm({ ...newForm, conceptId: e.target.value })} className={inp}>
                <option value="">Select…</option>
                {concepts.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </div>
            <div>
              <label className="text-xs text-s-muted">Category</label>
              <select value={newForm.category} onChange={(e) => setNewForm({ ...newForm, category: e.target.value })} className={inp}>
                {CATEGORIES.map((c) => <option key={c} value={c}>{c.replace('_', ' ')}</option>)}
              </select>
            </div>
            <div>
              <label className="text-xs text-s-muted">Priority</label>
              <select value={newForm.priority} onChange={(e) => setNewForm({ ...newForm, priority: e.target.value })} className={inp}>
                {['low', 'medium', 'high', 'urgent'].map((p) => <option key={p} value={p}>{p}</option>)}
              </select>
            </div>
            <div>
              <label className="text-xs text-s-muted">Order ID (optional)</label>
              <input value={newForm.orderId} onChange={(e) => setNewForm({ ...newForm, orderId: e.target.value })}
                placeholder="paste order UUID" className={inp} />
            </div>
            <div className="col-span-2">
              <label className="text-xs text-s-muted">Title</label>
              <input value={newForm.title} onChange={(e) => setNewForm({ ...newForm, title: e.target.value })}
                placeholder="e.g. Missing item from order" className={inp} />
            </div>
            <div className="col-span-2">
              <label className="text-xs text-s-muted">Description</label>
              <textarea value={newForm.description} rows={3}
                onChange={(e) => setNewForm({ ...newForm, description: e.target.value })}
                placeholder="What happened?" className={`${inp} resize-none`} />
            </div>
          </div>
          <div className="flex gap-2">
            <button onClick={() => createMutation.mutate(newForm)}
              disabled={!newForm.conceptId || !newForm.title || !newForm.description || createMutation.isPending}
              className="rounded-lg bg-primary text-primary-on font-bold px-4 py-2 text-sm disabled:opacity-50">
              {createMutation.isPending ? 'Saving…' : 'Save'}
            </button>
            <button onClick={() => setShowNew(false)} className="rounded-lg border border-s-border text-s-muted px-4 py-2 text-sm">
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Filters */}
      <div className="flex flex-wrap gap-3 mb-4">
        <select value={conceptFilter} onChange={(e) => setConceptFilter(e.target.value)} className={`${inp} w-auto`}>
          <option value="">All concepts</option>
          {concepts.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} className={`${inp} w-auto`}>
          <option value="">All statuses</option>
          {['open', 'in_progress', 'resolved', 'closed'].map((s) => <option key={s} value={s}>{s.replace('_', ' ')}</option>)}
        </select>
        <select value={priorityFilter} onChange={(e) => setPriorityFilter(e.target.value)} className={`${inp} w-auto`}>
          <option value="">All priorities</option>
          {['urgent', 'high', 'medium', 'low'].map((p) => <option key={p} value={p}>{p}</option>)}
        </select>
        {selectedIds.size > 0 && (
          <button onClick={() => setSelectedIds(new Set())}
            className="rounded-lg border border-s-border text-s-muted px-3 py-2 text-xs hover:text-s-red hover:border-s-red transition-colors">
            Clear selection ({selectedIds.size})
          </button>
        )}
      </div>

      {/* Complaints list */}
      <div className="rounded-xl border border-s-border overflow-hidden">
        {isLoading && <p className="px-4 py-6 text-center text-s-muted">Loading…</p>}
        {!isLoading && complaints.length === 0 && (
          <p className="px-4 py-10 text-center text-s-muted">No complaints — nice!</p>
        )}
        {complaints.map((c) => (
          <div key={c.id} className="px-4 py-4 border-b border-s-border last:border-0 space-y-2">
            <div className="flex items-start gap-3 flex-wrap">
              {/* Checkbox */}
              <input
                type="checkbox"
                checked={selectedIds.has(c.id)}
                onChange={() => toggleSelect(c.id)}
                className="mt-2 h-3.5 w-3.5 shrink-0 cursor-pointer accent-primary"
              />
              {/* Priority dot */}
              <div className={`h-2 w-2 rounded-full mt-2.5 shrink-0 ${
                c.priority === 'urgent' ? 'bg-s-red' :
                c.priority === 'high' ? 'bg-s-amber' :
                c.priority === 'medium' ? 'bg-s-text' : 'bg-s-border'
              }`} />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <p className="font-semibold text-s-text">{c.title}</p>
                  <span className={`text-xs px-2 py-0.5 rounded-full ${STATUS_COLORS[c.status]}`}>
                    {c.status.replace('_', ' ')}
                  </span>
                  <span className={`text-xs ${PRIORITY_COLORS[c.priority]}`}>{c.priority}</span>
                  <AgeBadge createdAt={c.createdAt} now={now} />
                </div>
                <div className="flex gap-3 mt-0.5 flex-wrap items-center">
                  <span className="text-xs text-s-muted">{c.concept.name}</span>
                  {/* Brand chip — in portfolio view shows which company this
                      complaint's brand belongs to. Hidden in single-tenant
                      view since every row would carry the same name. */}
                  <TenantChip tenant={c.concept.tenant} tenantId={c.concept.tenantId} tenants={tenants} />
                  <span className="text-xs text-s-muted capitalize">{c.category.replace('_', ' ')}</span>
                  {c.order?.customer ? (
                    <Link href={`/crm?customer=${c.order.customer.id}`} className="text-xs text-blue-700 hover:text-blue-700 hover:underline transition-colors">
                      {c.order.customer.name}
                    </Link>
                  ) : c.order?.customerName ? (
                    <Link href={`/crm?search=${encodeURIComponent(c.order.customerName)}`} className="text-xs text-blue-700 hover:text-blue-700 hover:underline transition-colors">
                      {c.order.customerName}
                    </Link>
                  ) : null}
                  {c.orderId && (
                    <Link href={`/orders?search=${c.orderId.slice(0, 8)}`} className="text-xs text-primary-ink hover:text-primary-ink/80 hover:underline transition-colors font-mono">
                      #{c.orderId.slice(-6).toUpperCase()} →
                    </Link>
                  )}
                  <span className="text-xs text-s-muted">{new Date(c.createdAt).toLocaleDateString()}</span>
                </div>
                <p className="text-sm text-s-muted mt-1">{c.description}</p>
                {c.resolution && (
                  <p className="text-xs text-primary-ink mt-1">Resolution: {c.resolution}</p>
                )}
              </div>
              {/* Actions */}
              <div className="flex gap-2 shrink-0">
                {c.order?.customer && (c.order.customer.email || c.order.customer.phone) && (
                  <button onClick={() => setReachingOut(c)}
                    className="rounded-lg border border-blue-400 text-blue-700 px-3 py-1 text-xs hover:bg-blue-400/10 transition-colors">
                    💬 Reach out
                  </button>
                )}
                {c.status !== 'resolved' && c.status !== 'closed' && (
                  <>
                    {c.status === 'open' && (
                      <button onClick={() => updateMutation.mutate({ id: c.id, body: { status: 'in_progress' } })}
                        className="rounded-lg border border-s-amber text-s-amber px-3 py-1 text-xs hover:bg-s-amber/10 transition-colors">
                        Start
                      </button>
                    )}
                    <button onClick={() => { setResolving(c.id); setResolution(''); setTemplateOpen(null) }}
                      className="rounded-lg border border-primary text-primary-ink px-3 py-1 text-xs hover:bg-primary/10 transition-colors">
                      Resolve
                    </button>
                  </>
                )}
                {c.status !== 'closed' && (
                  <button onClick={() => updateMutation.mutate({ id: c.id, body: { status: 'closed' } })}
                    className="rounded-lg border border-s-border text-s-muted px-3 py-1 text-xs hover:border-s-red hover:text-s-red transition-colors">
                    Close
                  </button>
                )}
              </div>
            </div>

            {/* Resolve inline with template dropdown */}
            {resolving === c.id && (
              <div className="flex gap-2 mt-2 ml-8 flex-wrap items-start">
                <div className="flex-1 min-w-[200px] space-y-1.5">
                  <div className="flex gap-2 items-center">
                    <input value={resolution} onChange={(e) => setResolution(e.target.value)}
                      placeholder="Describe the resolution…" className={`${inp} flex-1`} />
                    {/* Templates dropdown */}
                    <div className="relative" ref={templateRef}>
                      <button
                        type="button"
                        onClick={() => setTemplateOpen(templateOpen === c.id ? null : c.id)}
                        className="rounded-lg border border-s-border text-s-muted px-3 py-2 text-xs hover:border-primary hover:text-primary-ink transition-colors whitespace-nowrap">
                        Templates ▾
                      </button>
                      {templateOpen === c.id && (
                        <div className="absolute right-0 top-full mt-1 z-30 w-64 rounded-xl border border-s-border bg-s-surface shadow-xl overflow-hidden">
                          {RESOLUTION_TEMPLATES.map((tpl) => (
                            <button
                              key={tpl}
                              type="button"
                              onClick={() => { setResolution(tpl); setTemplateOpen(null) }}
                              className="w-full text-left px-4 py-2.5 text-xs text-s-text hover:bg-primary/10 hover:text-primary-ink transition-colors border-b border-s-border last:border-0">
                              {tpl}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                </div>
                <button onClick={() => updateMutation.mutate({ id: c.id, body: { status: 'resolved', resolution } })}
                  disabled={!resolution || updateMutation.isPending}
                  className="rounded-lg bg-primary text-primary-on font-bold px-3 py-1.5 text-xs disabled:opacity-50 self-start mt-0.5">
                  Save
                </button>
                <button onClick={() => { setResolving(null); setTemplateOpen(null) }}
                  className="rounded-lg border border-s-border text-s-muted px-3 py-1.5 text-xs self-start mt-0.5">
                  Cancel
                </button>
              </div>
            )}
          </div>
        ))}
      </div>

      {/* Bulk action floating bar */}
      {selectedIds.size >= 2 && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-40 flex items-center gap-3 px-5 py-3 rounded-2xl shadow-2xl"
          style={{ background: 'var(--surface)', border: '1px solid rgb(var(--fg-rgb) / 0.12)', boxShadow: '0 8px 32px rgb(61 31 59 / 0.18)' }}>
          <span className="text-sm font-semibold text-s-text whitespace-nowrap">
            {selectedIds.size} selected
          </span>
          <span className="text-s-dim">·</span>
          <button onClick={() => void bulkUpdate('in_progress')}
            className="rounded-lg border border-s-amber text-s-amber px-3 py-1.5 text-xs font-semibold hover:bg-s-amber/10 transition-colors">
            In Progress
          </button>
          <button onClick={() => void bulkUpdate('resolved')}
            className="rounded-lg border border-primary text-primary-ink px-3 py-1.5 text-xs font-semibold hover:bg-primary/10 transition-colors">
            Resolved
          </button>
          <button onClick={() => void bulkUpdate('closed')}
            className="rounded-lg border border-s-border text-s-muted px-3 py-1.5 text-xs font-semibold hover:border-s-red hover:text-s-red transition-colors">
            Close
          </button>
        </div>
      )}

      {reachingOut && reachingOut.order?.customer && (
        <ReachOutModal
          context={{
            source: 'complaint',
            sourceRefId: reachingOut.id,
            contextTitle: reachingOut.title,
            contextSubtitle: `${reachingOut.priority} priority · ${reachingOut.category}`,
            conceptName: reachingOut.concept.name,
            customer: reachingOut.order.customer,
          }}
          onClose={() => setReachingOut(null)}
          onSent={() => {
            setReachingOut(null)
            void qc.invalidateQueries({ queryKey: ['complaints'] })
          }}
        />
      )}
    </div>
  )
}

const inp = 'w-full rounded-lg bg-s-bg border border-s-border px-3 py-2 text-s-text text-sm focus:border-primary focus:outline-none'
