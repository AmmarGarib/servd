'use client'
import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import Link from 'next/link'
import { api, deleteWithUndo } from '../../../lib/api'
import { Select } from '@/components/ui/Select'
import { NavIcon } from '../../../components/ui/NavIcon'
import { CompactEmptyState } from '../../../components/ui/CompactEmptyState'

interface Template {
  id: string
  conceptId: string | null
  channel: 'email' | 'sms' | 'whatsapp' | 'push'
  event: string
  subject: string | null
  body: string
  language: 'en' | 'ur'
  isActive: boolean
  notes: string | null
}
interface Concept { id: string; name: string }

const EVENTS = [
  'order.confirmed', 'order.ready', 'order.dispatched', 'order.delivered',
  'order.refunded', 'reservation.confirmed', 'reservation.reminder',
  'shift.opened', 'shift.closed', 'low_stock', 'daily_digest',
]

export default function TemplatesPage() {
  const qc = useQueryClient()
  const [editing, setEditing] = useState<Template | null>(null)
  const [adding, setAdding] = useState(false)
  const { data: templates = [] } = useQuery<Template[]>({ queryKey: ['notification-templates'], queryFn: () => api.get('/setup/notification-templates') })
  const { data: concepts = [] } = useQuery<Concept[]>({ queryKey: ['concepts'], queryFn: () => api.get('/concepts') })
  const del = useMutation({ mutationFn: (id: string) => deleteWithUndo(`/setup/notification-templates/${id}`, { trashType: 'notification_template', id, onRestored: () => void qc.invalidateQueries({ queryKey: ['notification-templates'] }) }), onSuccess: () => qc.invalidateQueries({ queryKey: ['notification-templates'] }) })

  return (
    <div className="min-h-screen" style={{ background: 'var(--bg)' }}>
      <header className="px-7 py-6 border-b border-white/[0.05]">
        <Link href="/configuration" className="text-xs text-white/40 hover:text-white/70">← Configuration Hub</Link>
        <div className="flex items-start justify-between gap-4 mt-2">
          <div>
            <h1 className="text-2xl font-black text-white/90">Email / SMS / WhatsApp templates</h1>
            <p className="text-sm text-white/40 mt-1 max-w-2xl">
              Edit the actual text customers receive. Use <code className="bg-white/5 rounded px-1 text-primary-ink">{'{{var}}'}</code> placeholders. Override per concept + language.
            </p>
          </div>
          <button onClick={() => setAdding(true)} className="rounded-xl bg-primary px-4 py-2.5 text-sm font-black text-primary-on hover:opacity-90">+ New template</button>
        </div>
      </header>

      <div className="px-7 py-6 max-w-4xl mx-auto space-y-2">
        {templates.length === 0 && (
          <CompactEmptyState message="No custom templates" detail="System defaults are in use. Add one to override." />
        )}
        {templates.map((t) => {
          const concept = concepts.find((c) => c.id === t.conceptId)
          return (
            <div key={t.id} className="rounded-2xl p-5"
              style={{ background: 'rgb(var(--fg-rgb) / 0.025)', border: '1px solid rgb(var(--fg-rgb) / 0.06)' }}>
              <div className="flex items-start justify-between gap-3">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full" style={{ background: 'rgb(var(--ink-rgb) / 0.15)', color: 'var(--erp-primary-ink)' }}>{t.channel}</span>
                    <span className="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full" style={{ background: 'rgb(var(--erp-primary-rgb) / 0.12)', color: 'var(--erp-primary-ink)' }}>{t.event}</span>
                    <span className="text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded bg-white/5 text-white/55">{t.language}</span>
                    {concept && <span className="text-[10px] text-white/55">{concept.name}</span>}
                    {!t.isActive && <span className="text-[10px] text-white/30">PAUSED</span>}
                  </div>
                  {t.subject && <p className="text-sm font-bold text-white/85 mt-2">{t.subject}</p>}
                  <p className="text-xs text-white/55 mt-1 whitespace-pre-wrap line-clamp-3">{t.body}</p>
                </div>
                <div className="flex flex-col gap-2 shrink-0">
                  <button onClick={() => setEditing(t)} className="rounded-lg border border-white/10 px-3 py-1.5 text-xs text-white/55 hover:text-white">Edit</button>
                  <button onClick={() => { if (confirm('Delete template?')) del.mutate(t.id) }} className="rounded-lg border border-red-500/20 text-red-700/70 px-3 py-1.5 text-xs">Delete</button>
                </div>
              </div>
            </div>
          )
        })}
      </div>

      {(adding || editing) && (
        <Modal template={editing} concepts={concepts}
          onClose={() => { setAdding(false); setEditing(null) }}
          onSaved={() => { setAdding(false); setEditing(null); void qc.invalidateQueries({ queryKey: ['notification-templates'] }) }} />
      )}
    </div>
  )
}

function Modal({ template, concepts, onClose, onSaved }: { template: Template | null; concepts: Concept[]; onClose: () => void; onSaved: () => void }) {
  const [conceptId, setConceptId] = useState(template?.conceptId ?? '')
  const [channel, setChannel] = useState<Template['channel']>(template?.channel ?? 'email')
  const [event, setEvent] = useState(template?.event ?? 'order.confirmed')
  const [subject, setSubject] = useState(template?.subject ?? '')
  const [body, setBody] = useState(template?.body ?? '')
  const [language, setLanguage] = useState<Template['language']>(template?.language ?? 'en')

  const save = useMutation({
    mutationFn: () => {
      if (template) {
        return api.patch(`/setup/notification-templates/${template.id}`, { subject: subject || null, body })
      }
      return api.post('/setup/notification-templates', { conceptId: conceptId || null, channel, event, subject: subject || null, body, language })
    },
    onSuccess: () => onSaved(),
  })

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-secondary/40 p-4" onClick={onClose}>
      <div className="w-full max-w-2xl rounded-2xl overflow-hidden"
        style={{ background: 'var(--surface)', border: '1px solid rgb(var(--fg-rgb) / 0.08)' }}
        onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-white/[0.05] px-5 py-3">
          <h2 className="font-black text-white/90">{template ? 'Edit template' : 'New template'}</h2>
          <button onClick={onClose} className="text-white/40 text-xl"><NavIcon name="x" size={16} /></button>
        </div>
        <div className="p-5 space-y-3 max-h-[70vh] overflow-y-auto">
          {!template && (
            <>
              <div className="grid grid-cols-3 gap-3">
                <Field label="Channel">
                  <Select value={channel} onChange={(e) => setChannel(e.target.value as Template['channel'])} className={fieldCls}>
                    <option value="email">Email</option>
                    <option value="sms">SMS</option>
                    <option value="whatsapp">WhatsApp</option>
                    <option value="push">Push</option>
                  </Select>
                </Field>
                <Field label="Event">
                  <Select value={event} onChange={(e) => setEvent(e.target.value)} className={fieldCls}>
                    {EVENTS.map((e) => <option key={e} value={e}>{e}</option>)}
                  </Select>
                </Field>
                <Field label="Language">
                  <Select value={language} onChange={(e) => setLanguage(e.target.value as Template['language'])} className={fieldCls}>
                    <option value="en">English</option>
                    <option value="ur">Urdu</option>
                  </Select>
                </Field>
              </div>
              <Field label="Concept (blank = all)">
                <Select value={conceptId} onChange={(e) => setConceptId(e.target.value)} className={fieldCls}>
                  <option value="">All</option>
                  {concepts.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </Select>
              </Field>
            </>
          )}
          {channel === 'email' && (
            <Field label="Subject"><input value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="Your order is on the way!" className={fieldCls} /></Field>
          )}
          <Field label="Body">
            <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={10} placeholder="Hi {{customerName}}, your order #{{orderId}} is ready." className={fieldCls + ' font-mono'} />
            <p className="text-[10px] text-white/30 mt-1">Available variables: {`{{customerName}}, {{orderId}}, {{total}}, {{conceptName}}, {{eta}}, {{trackUrl}}`}</p>
          </Field>
        </div>
        <div className="flex justify-between gap-3 border-t border-white/[0.05] p-4 bg-white/[0.01]">
          <button onClick={onClose} className="rounded-xl border border-white/10 px-4 py-2.5 text-sm text-white/55 hover:text-white">Cancel</button>
          <button onClick={() => save.mutate()} disabled={save.isPending || body.length < 1}
            className="rounded-xl bg-primary px-5 py-2.5 text-sm font-black text-primary-on hover:opacity-90 disabled:opacity-50">
            {save.isPending ? 'Saving…' : template ? 'Save' : 'Create'}
          </button>
        </div>
      </div>
    </div>
  )
}

const fieldCls = "w-full rounded-lg bg-white/[0.03] border border-white/[0.08] px-3 py-2 text-sm text-white/85 focus:border-primary focus:outline-none"
function Field({ label, children }: { label: string; children: React.ReactNode }) { return <div><label className="text-xs text-white/55">{label}</label><div className="mt-1">{children}</div></div> }
