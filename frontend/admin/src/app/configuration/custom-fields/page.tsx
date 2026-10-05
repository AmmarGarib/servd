'use client'
import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import Link from 'next/link'
import { api } from '../../../lib/api'

type Scope = 'customer' | 'order' | 'menu_item' | 'supplier'
type FieldType = 'text' | 'number' | 'date' | 'select' | 'boolean'

interface Def {
  id: string
  scope: Scope
  key: string
  label: string
  type: FieldType
  options: string[]
  helpText: string | null
  isRequired: boolean
  showInList: boolean
  isActive: boolean
}

const SCOPES: { value: Scope; label: string; desc: string }[] = [
  { value: 'customer', label: 'Customer', desc: 'CRM profile fields' },
  { value: 'order', label: 'Order', desc: 'Captured at checkout' },
  { value: 'menu_item', label: 'Menu item', desc: 'Item metadata' },
  { value: 'supplier', label: 'Supplier', desc: 'Vendor profile' },
]

export default function CustomFieldsPage() {
  const qc = useQueryClient()
  const [editing, setEditing] = useState<Def | null>(null)
  const [adding, setAdding] = useState(false)
  const { data = [] } = useQuery<Def[]>({ queryKey: ['custom-fields'], queryFn: () => api.get('/setup/custom-fields') })
  const del = useMutation({ mutationFn: (id: string) => api.delete(`/setup/custom-fields/${id}`), onSuccess: () => qc.invalidateQueries({ queryKey: ['custom-fields'] }) })

  return (
    <div className="min-h-screen" style={{ background: 'var(--bg)' }}>
      <header className="px-7 py-6 border-b border-white/[0.05]">
        <Link href="/configuration" className="text-xs text-white/40 hover:text-white/70">← Configuration Hub</Link>
        <div className="flex items-start justify-between gap-4 mt-2">
          <div>
            <h1 className="text-2xl font-black text-white/90">🧩 Custom fields</h1>
            <p className="text-sm text-white/40 mt-1 max-w-2xl">
              Add fields to customers, orders, menu items, or suppliers — without changing code. They'll appear in the matching record's edit form.
            </p>
          </div>
          <button onClick={() => setAdding(true)} className="rounded-xl bg-primary px-4 py-2.5 text-sm font-black text-primary-on hover:opacity-90">+ New field</button>
        </div>
      </header>

      <div className="px-7 py-6 max-w-4xl mx-auto space-y-6">
        {SCOPES.map((s) => {
          const fields = data.filter((d) => d.scope === s.value)
          return (
            <section key={s.value}>
              <div className="flex items-baseline justify-between mb-3">
                <div>
                  <h2 className="text-xs font-black uppercase tracking-[0.24em] text-white/65">{s.label}</h2>
                  <p className="text-[11px] text-white/35">{s.desc}</p>
                </div>
                <span className="text-[10px] text-white/30 font-mono">{fields.length} fields</span>
              </div>
              <div className="rounded-2xl overflow-hidden" style={{ background: 'rgb(var(--fg-rgb) / 0.025)', border: '1px solid rgb(var(--fg-rgb) / 0.06)' }}>
                {fields.length === 0 && <p className="p-5 text-xs text-white/35">None.</p>}
                {fields.map((f) => (
                  <div key={f.id} className="px-4 py-3 flex items-center justify-between gap-3 border-b border-white/[0.04] last:border-b-0 hover:bg-white/[0.02]">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <p className="text-sm font-semibold text-white/85">{f.label}</p>
                        <code className="text-[10px] text-white/40 font-mono">{f.key}</code>
                        <span className="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full" style={{ background: 'rgb(61 31 59 / 0.12)', color: '#6b2f68' }}>{f.type}</span>
                        {f.isRequired && <span className="text-[10px] text-red-700">required</span>}
                      </div>
                      {f.helpText && <p className="text-xs text-white/40 mt-0.5">{f.helpText}</p>}
                    </div>
                    <div className="flex gap-2 shrink-0">
                      <button onClick={() => setEditing(f)} className="text-xs text-white/55 hover:text-white">Edit</button>
                      <button onClick={() => { if (confirm(`Delete "${f.label}"?`)) del.mutate(f.id) }} className="text-xs text-red-700/70 hover:text-red-700">Delete</button>
                    </div>
                  </div>
                ))}
              </div>
            </section>
          )
        })}
      </div>

      {(adding || editing) && (
        <Modal field={editing} onClose={() => { setAdding(false); setEditing(null) }}
          onSaved={() => { setAdding(false); setEditing(null); void qc.invalidateQueries({ queryKey: ['custom-fields'] }) }} />
      )}
    </div>
  )
}

function Modal({ field, onClose, onSaved }: { field: Def | null; onClose: () => void; onSaved: () => void }) {
  const [scope, setScope] = useState<Scope>(field?.scope ?? 'customer')
  const [key, setKey] = useState(field?.key ?? '')
  const [label, setLabel] = useState(field?.label ?? '')
  const [type, setType] = useState<FieldType>(field?.type ?? 'text')
  const [optionsInput, setOptionsInput] = useState((field?.options ?? []).join('\n'))
  const [helpText, setHelpText] = useState(field?.helpText ?? '')
  const [isRequired, setIsRequired] = useState(field?.isRequired ?? false)
  const [showInList, setShowInList] = useState(field?.showInList ?? false)

  const save = useMutation({
    mutationFn: () => {
      const options = optionsInput.split('\n').map((s) => s.trim()).filter(Boolean)
      const payload = { scope, key, label, type, options, helpText: helpText || null, isRequired, showInList }
      const updatePayload = { label, options, helpText: helpText || null, isRequired, showInList }
      if (field) return api.patch(`/setup/custom-fields/${field.id}`, updatePayload)
      return api.post('/setup/custom-fields', payload)
    },
    onSuccess: () => onSaved(),
  })

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-secondary/40 p-4" onClick={onClose}>
      <div className="w-full max-w-lg rounded-2xl overflow-hidden" style={{ background: 'var(--surface)', border: '1px solid rgb(var(--fg-rgb) / 0.08)' }} onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-white/[0.05] px-5 py-3">
          <h2 className="font-black text-white/90">{field ? 'Edit field' : 'New custom field'}</h2>
          <button onClick={onClose} className="text-white/40 text-xl">✕</button>
        </div>
        <div className="p-5 space-y-3 max-h-[70vh] overflow-y-auto">
          {!field && (
            <div className="grid grid-cols-2 gap-3">
              <Field label="Scope">
                <select value={scope} onChange={(e) => setScope(e.target.value as Scope)} className={fieldCls}>
                  {SCOPES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
                </select>
              </Field>
              <Field label="Type">
                <select value={type} onChange={(e) => setType(e.target.value as FieldType)} className={fieldCls}>
                  <option value="text">Text</option>
                  <option value="number">Number</option>
                  <option value="date">Date</option>
                  <option value="select">Select</option>
                  <option value="boolean">Boolean</option>
                </select>
              </Field>
            </div>
          )}
          {!field && (
            <Field label="Key (snake_case) *">
              <input value={key} onChange={(e) => setKey(e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '_'))} placeholder="dietary_restriction" className={fieldCls + ' font-mono'} />
            </Field>
          )}
          <Field label="Label *"><input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Dietary restriction" className={fieldCls} /></Field>
          {type === 'select' && (
            <Field label="Options (one per line)">
              <textarea value={optionsInput} onChange={(e) => setOptionsInput(e.target.value)} rows={4} className={fieldCls + ' font-mono'} placeholder="Vegetarian&#10;Vegan&#10;Halal&#10;None" />
            </Field>
          )}
          <Field label="Help text"><input value={helpText} onChange={(e) => setHelpText(e.target.value)} placeholder="Shown below the field" className={fieldCls} /></Field>
          <div className="flex gap-4">
            <label className="flex items-center gap-2 cursor-pointer"><input type="checkbox" checked={isRequired} onChange={(e) => setIsRequired(e.target.checked)} className="accent-primary" /><span className="text-xs text-white/65">Required</span></label>
            <label className="flex items-center gap-2 cursor-pointer"><input type="checkbox" checked={showInList} onChange={(e) => setShowInList(e.target.checked)} className="accent-primary" /><span className="text-xs text-white/65">Show in list view</span></label>
          </div>
        </div>
        <div className="flex justify-between gap-3 border-t border-white/[0.05] p-4 bg-white/[0.01]">
          <button onClick={onClose} className="rounded-xl border border-white/10 px-4 py-2.5 text-sm text-white/55 hover:text-white">Cancel</button>
          <button onClick={() => save.mutate()} disabled={save.isPending || !label || (!field && !key)}
            className="rounded-xl bg-primary px-5 py-2.5 text-sm font-black text-primary-on hover:opacity-90 disabled:opacity-50">
            {save.isPending ? 'Saving…' : field ? 'Save' : 'Create'}
          </button>
        </div>
      </div>
    </div>
  )
}

const fieldCls = "w-full rounded-lg bg-white/[0.03] border border-white/[0.08] px-3 py-2 text-sm text-white/85 focus:border-primary focus:outline-none"
function Field({ label, children }: { label: string; children: React.ReactNode }) { return <div><label className="text-xs text-white/55">{label}</label><div className="mt-1">{children}</div></div> }
