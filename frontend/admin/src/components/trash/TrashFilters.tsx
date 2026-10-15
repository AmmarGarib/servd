'use client'
import { Select } from '../ui/Select'
import { FormField } from '../ui/FormField'
import { EMPTY_FILTERS, type TrashFilters, type TrashState, type TrashTypeInfo } from '../../lib/trash'

const TABS: Array<{ id: TrashFilters['tab']; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'master', label: 'Deleted items' },
  { id: 'transaction', label: 'Cancelled & voided' },
]
const field = 'w-full rounded-xl px-3 py-2 text-sm text-white/90 outline-none'
const fieldStyle = { background: 'var(--bg)', border: '1px solid var(--border)' }

export function TrashFilterBar({ value, onChange, types, isCeo }: {
  value: TrashFilters; onChange: (f: TrashFilters) => void; types: TrashTypeInfo[]; isCeo: boolean
}) {
  const set = (p: Partial<TrashFilters>) => onChange({ ...value, ...p })
  const visible = types.filter((t) => value.tab === 'all' || t.kind === value.tab)
  const modules = Array.from(new Set(types.map((t) => t.moduleId).filter(Boolean) as string[])).sort()
  const dirty = JSON.stringify({ ...value, tab: 'all' }) !== JSON.stringify(EMPTY_FILTERS)
  return (
    <div className="mt-5 space-y-3">
      <div className="flex gap-2 overflow-x-auto pb-1 [scrollbar-width:thin]" role="tablist" aria-label="Kind">
        {TABS.map((t) => {
          const on = value.tab === t.id
          return (
            <button key={t.id} role="tab" aria-selected={on} onClick={() => set({ tab: t.id, type: '' })}
              className="shrink-0 min-h-[44px] px-4 text-sm font-bold border-b-2"
              style={{ borderColor: on ? 'var(--erp-accent)' : 'transparent', color: on ? 'var(--text)' : 'var(--muted)' }}>
              {t.label}
            </button>
          )
        })}
      </div>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-6">
        <FormField label="Search" className="lg:col-span-2">
          <input className={field} style={fieldStyle} type="search" placeholder="Name, number, code" value={value.q} onChange={(e) => set({ q: e.target.value })} />
        </FormField>
        <FormField label="Type">
          <Select className={field} style={fieldStyle} value={value.type} onChange={(e) => set({ type: e.target.value })}>
            <option value="">All types</option>
            {visible.map((t) => <option key={t.key} value={t.key}>{t.label}{t.count ? ` (${t.count})` : ''}</option>)}
          </Select>
        </FormField>
        {modules.length > 1 && (
          <FormField label="Module">
            <Select className={field} style={fieldStyle} value={value.module} onChange={(e) => set({ module: e.target.value })}>
              <option value="">All modules</option>
              {modules.map((m) => <option key={m} value={m}>{m.replace(/_/g, ' ')}</option>)}
            </Select>
          </FormField>
        )}
        <FormField label="Show">
          <Select className={field} style={fieldStyle} value={value.state} onChange={(e) => set({ state: e.target.value as TrashState })}>
            <option value="in_trash">In trash</option>
            <option value="restored">Restored</option>
            {isCeo && <option value="purged">Deleted forever</option>}
            {isCeo && <option value="archived">Archived</option>}
          </Select>
        </FormField>
        <FormField label="From"><input className={field} style={fieldStyle} type="date" value={value.from} onChange={(e) => set({ from: e.target.value })} /></FormField>
        <FormField label="To"><input className={field} style={fieldStyle} type="date" value={value.to} onChange={(e) => set({ to: e.target.value })} /></FormField>
      </div>
      {dirty && <button className="s-btn-ghost" onClick={() => onChange({ ...EMPTY_FILTERS, tab: value.tab })}>Clear filters</button>}
    </div>
  )
}
