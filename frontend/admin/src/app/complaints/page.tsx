'use client'
import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '../../lib/api'
import Link from 'next/link'
import { ReachOutModal } from '../../components/crm/ReachOutModal'

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
  concept: { name: string; slug: string }
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
  open: 'bg-kds-red/20 text-kds-red',
  in_progress: 'bg-kds-amber/20 text-kds-amber',
  resolved: 'bg-kds-green/20 text-kds-green',
  closed: 'bg-kds-border text-kds-subtext',
}

const PRIORITY_COLORS: Record<string, string> = {
  urgent: 'text-kds-red font-bold',
  high: 'text-kds-amber font-semibold',
  medium: 'text-kds-text',
  low: 'text-kds-subtext',
}

const CATEGORIES = ['wrong_item', 'missing_item', 'quality', 'service', 'delivery', 'other']

export default function ComplaintsPage() {
  const qc = useQueryClient()
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

  const complaints = data?.complaints ?? []
  const stats = data?.stats ?? { total: 0, open: 0, resolved: 0, inProgress: 0 }

  return (
    <div className="min-h-screen bg-kds-bg p-6">
      <header className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-black text-kds-text mt-1">Order Complaints</h1>
        </div>
        <button onClick={() => setShowNew(true)}
          className="rounded-xl bg-kds-green text-black font-bold px-4 py-2 text-sm hover:opacity-90">
          + New complaint
        </button>
      </header>

      {/* Stats */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-6">
        {[
          { label: 'Total', value: stats.total, color: 'text-kds-text' },
          { label: 'Open', value: stats.open, color: 'text-kds-red' },
          { label: 'In progress', value: stats.inProgress, color: 'text-kds-amber' },
          { label: 'Resolved', value: stats.resolved, color: 'text-kds-green' },
        ].map((s) => (
          <div key={s.label} className="rounded-xl border border-kds-border bg-kds-card p-4">
            <p className="text-xs text-kds-subtext">{s.label}</p>
            <p className={`text-3xl font-black ${s.color}`}>{s.value}</p>
          </div>
        ))}
      </div>

      {/* New complaint form */}
      {showNew && (
        <div className="mb-6 rounded-xl border border-kds-green bg-kds-card p-4 space-y-3">
          <h3 className="font-bold text-kds-text">Log Complaint</h3>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs text-kds-subtext">Concept</label>
              <select value={newForm.conceptId} onChange={(e) => setNewForm({ ...newForm, conceptId: e.target.value })} className={inp}>
                <option value="">Select…</option>
                {concepts.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </div>
            <div>
              <label className="text-xs text-kds-subtext">Category</label>
              <select value={newForm.category} onChange={(e) => setNewForm({ ...newForm, category: e.target.value })} className={inp}>
                {CATEGORIES.map((c) => <option key={c} value={c}>{c.replace('_', ' ')}</option>)}
              </select>
            </div>
            <div>
              <label className="text-xs text-kds-subtext">Priority</label>
              <select value={newForm.priority} onChange={(e) => setNewForm({ ...newForm, priority: e.target.value })} className={inp}>
                {['low', 'medium', 'high', 'urgent'].map((p) => <option key={p} value={p}>{p}</option>)}
              </select>
            </div>
            <div>
              <label className="text-xs text-kds-subtext">Order ID (optional)</label>
              <input value={newForm.orderId} onChange={(e) => setNewForm({ ...newForm, orderId: e.target.value })}
                placeholder="paste order UUID" className={inp} />
            </div>
            <div className="col-span-2">
              <label className="text-xs text-kds-subtext">Title</label>
              <input value={newForm.title} onChange={(e) => setNewForm({ ...newForm, title: e.target.value })}
                placeholder="e.g. Missing item from order" className={inp} />
            </div>
            <div className="col-span-2">
              <label className="text-xs text-kds-subtext">Description</label>
              <textarea value={newForm.description} rows={3}
                onChange={(e) => setNewForm({ ...newForm, description: e.target.value })}
                placeholder="What happened?" className={`${inp} resize-none`} />
            </div>
          </div>
          <div className="flex gap-2">
            <button onClick={() => createMutation.mutate(newForm)}
              disabled={!newForm.conceptId || !newForm.title || !newForm.description || createMutation.isPending}
              className="rounded-lg bg-kds-green text-black font-bold px-4 py-2 text-sm disabled:opacity-50">
              {createMutation.isPending ? 'Saving…' : 'Save'}
            </button>
            <button onClick={() => setShowNew(false)} className="rounded-lg border border-kds-border text-kds-subtext px-4 py-2 text-sm">
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
      </div>

      {/* Complaints table */}
      <div className="rounded-xl border border-kds-border overflow-hidden">
        {isLoading && <p className="px-4 py-6 text-center text-kds-subtext">Loading…</p>}
        {!isLoading && complaints.length === 0 && (
          <p className="px-4 py-10 text-center text-kds-subtext">No complaints — nice!</p>
        )}
        {complaints.map((c) => (
          <div key={c.id} className="px-4 py-4 border-b border-kds-border last:border-0 space-y-2">
            <div className="flex items-start gap-3 flex-wrap">
              {/* Priority dot */}
              <div className={`h-2 w-2 rounded-full mt-2 shrink-0 ${
                c.priority === 'urgent' ? 'bg-kds-red' :
                c.priority === 'high' ? 'bg-kds-amber' :
                c.priority === 'medium' ? 'bg-kds-text' : 'bg-kds-border'
              }`} />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <p className="font-semibold text-kds-text">{c.title}</p>
                  <span className={`text-xs px-2 py-0.5 rounded-full ${STATUS_COLORS[c.status]}`}>
                    {c.status.replace('_', ' ')}
                  </span>
                  <span className={`text-xs ${PRIORITY_COLORS[c.priority]}`}>{c.priority}</span>
                </div>
                <div className="flex gap-3 mt-0.5 flex-wrap">
                  <span className="text-xs text-kds-subtext">{c.concept.name}</span>
                  <span className="text-xs text-kds-subtext capitalize">{c.category.replace('_', ' ')}</span>
                  {c.order?.customerName && <span className="text-xs text-kds-subtext">{c.order.customerName}</span>}
                  <span className="text-xs text-kds-subtext">{new Date(c.createdAt).toLocaleDateString()}</span>
                </div>
                <p className="text-sm text-kds-subtext mt-1">{c.description}</p>
                {c.resolution && (
                  <p className="text-xs text-kds-green mt-1">Resolution: {c.resolution}</p>
                )}
              </div>
              {/* Actions */}
              <div className="flex gap-2 shrink-0">
                {/* Reach out via email + WhatsApp — opens a CustomerConversation
                    pre-filled with the complaint context. Only enabled when
                    the order has a linked customer (anonymous orders have only
                    a name string, no contact info to reach them on). */}
                {c.order?.customer && (c.order.customer.email || c.order.customer.phone) && (
                  <button onClick={() => setReachingOut(c)}
                    className="rounded-lg border border-blue-400 text-blue-400 px-3 py-1 text-xs hover:bg-blue-400/10 transition-colors">
                    💬 Reach out
                  </button>
                )}
                {c.status !== 'resolved' && c.status !== 'closed' && (
                  <>
                    {c.status === 'open' && (
                      <button onClick={() => updateMutation.mutate({ id: c.id, body: { status: 'in_progress' } })}
                        className="rounded-lg border border-kds-amber text-kds-amber px-3 py-1 text-xs hover:bg-kds-amber/10 transition-colors">
                        Start
                      </button>
                    )}
                    <button onClick={() => { setResolving(c.id); setResolution('') }}
                      className="rounded-lg border border-kds-green text-kds-green px-3 py-1 text-xs hover:bg-kds-green/10 transition-colors">
                      Resolve
                    </button>
                  </>
                )}
                {c.status !== 'closed' && (
                  <button onClick={() => updateMutation.mutate({ id: c.id, body: { status: 'closed' } })}
                    className="rounded-lg border border-kds-border text-kds-subtext px-3 py-1 text-xs hover:border-kds-red hover:text-kds-red transition-colors">
                    Close
                  </button>
                )}
              </div>
            </div>

            {/* Resolve inline */}
            {resolving === c.id && (
              <div className="flex gap-2 mt-2 ml-5">
                <input value={resolution} onChange={(e) => setResolution(e.target.value)}
                  placeholder="Describe the resolution…" className={`${inp} flex-1`} />
                <button onClick={() => updateMutation.mutate({ id: c.id, body: { status: 'resolved', resolution } })}
                  disabled={!resolution || updateMutation.isPending}
                  className="rounded-lg bg-kds-green text-black font-bold px-3 py-1.5 text-xs disabled:opacity-50">
                  Save
                </button>
                <button onClick={() => setResolving(null)} className="rounded-lg border border-kds-border text-kds-subtext px-3 py-1.5 text-xs">
                  Cancel
                </button>
              </div>
            )}
          </div>
        ))}
      </div>

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

const inp = 'w-full rounded-lg bg-kds-bg border border-kds-border px-3 py-2 text-kds-text text-sm focus:border-kds-green focus:outline-none'
