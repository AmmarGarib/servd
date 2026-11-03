'use client'
// The card's staff fields (type, deadline, priority, owner, resources, link) — shared by the New card dialog and the
// card panel. People and link options come from the BOARD's company (the API refuses anyone / anything else).
import { useQuery } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { Select } from '@/components/ui/Select'
import { CheckLabel, Field, Input, fieldCls } from '@/components/finance/ui'
import { PRIORITY_LABEL, TYPE_LABEL, type CardType, type Person, type Priority } from './data'

export type LinkKind = '' | 'menu_item' | 'promo' | 'campaign'
export interface StaffFields {
  type: CardType; deadline: string; priority: Priority; ownerId: string; resourceIds: string[]; linkKind: LinkKind; linkId: string
}

export function usePeople(boardId: string, enabled = true) {
  return useQuery<Person[]>({ queryKey: ['mkb', 'people', boardId], queryFn: () => api.get(`/marketing-board/boards/${boardId}/people`), enabled })
}
interface LinkOptions { menuItems: Array<{ id: string; name: string }>; promos: Array<{ id: string; code: string }>; campaigns: Array<{ id: string; name: string }> }
export function useLinkOptions(boardId: string, enabled = true) {
  return useQuery<LinkOptions>({ queryKey: ['mkb', 'links', boardId], queryFn: () => api.get(`/marketing-board/boards/${boardId}/link-options`), enabled })
}

export function staffPayload(f: StaffFields) {
  return {
    type: f.type, deadline: f.deadline, priority: f.priority, ownerId: f.ownerId || null, resourceIds: f.resourceIds,
    link: f.linkKind && f.linkId ? { kind: f.linkKind, id: f.linkId } : null,
  }
}

export function CardStaffFields({ boardId, value, onChange }: { boardId: string; value: StaffFields; onChange: (v: StaffFields) => void }) {
  const { data: people = [] } = usePeople(boardId)
  const { data: links } = useLinkOptions(boardId)
  const set = <K extends keyof StaffFields>(k: K, v: StaffFields[K]) => onChange({ ...value, [k]: v })
  const options = value.linkKind === 'menu_item' ? (links?.menuItems ?? []).map((m) => ({ id: m.id, label: m.name }))
    : value.linkKind === 'promo' ? (links?.promos ?? []).map((p) => ({ id: p.id, label: p.code }))
    : value.linkKind === 'campaign' ? (links?.campaigns ?? []).map((c) => ({ id: c.id, label: c.name })) : []
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Field label="Type">
          <Select className={fieldCls} value={value.type} onChange={(e) => set('type', e.target.value as CardType)}>
            {Object.entries(TYPE_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </Select>
        </Field>
        <Field label="Deadline">
          <Input type="date" value={value.deadline} onChange={(e) => set('deadline', e.target.value)} required />
        </Field>
        <Field label="Priority">
          <Select className={fieldCls} value={value.priority} onChange={(e) => set('priority', e.target.value as Priority)}>
            {Object.entries(PRIORITY_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </Select>
        </Field>
      </div>
      <Field label="Owner">
        <Select className={fieldCls} value={value.ownerId} onChange={(e) => set('ownerId', e.target.value)}>
          <option value="">No owner</option>
          {people.map((p) => <option key={p.id} value={p.id}>{p.name ?? p.id}</option>)}
        </Select>
      </Field>
      <fieldset>
        <legend className="text-xs font-medium text-s-muted">People working on it</legend>
        <div className="mt-1 max-h-40 space-y-1.5 overflow-y-auto rounded-lg border border-s-border p-2">
          {people.length === 0 && <p className="text-xs text-s-muted">Loading…</p>}
          {people.map((p) => (
            <CheckLabel key={p.id} className="min-h-[32px]">
              <input type="checkbox" className="h-4 w-4" checked={value.resourceIds.includes(p.id)}
                onChange={(e) => set('resourceIds', e.target.checked ? [...value.resourceIds, p.id] : value.resourceIds.filter((x) => x !== p.id))} />
              <span>{p.name ?? p.id}</span>
              {p.role === 'marketing_intern' && <span className="text-s-muted">· intern</span>}
            </CheckLabel>
          ))}
        </div>
      </fieldset>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="Linked to">
          <Select className={fieldCls} value={value.linkKind} onChange={(e) => onChange({ ...value, linkKind: e.target.value as LinkKind, linkId: '' })}>
            <option value="">Nothing</option>
            <option value="menu_item">A dish</option>
            <option value="promo">A promo code</option>
            <option value="campaign">A CRM campaign</option>
          </Select>
        </Field>
        {value.linkKind && (
          <Field label="Which one">
            <Select className={fieldCls} value={value.linkId} onChange={(e) => set('linkId', e.target.value)}>
              <option value="">Pick…</option>
              {options.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
            </Select>
          </Field>
        )}
      </div>
    </div>
  )
}

/** Reference links: one per line → list (http / https only — the server refuses anything else). */
export function linesToLinks(text: string): string[] {
  return text.split('\n').map((l) => l.trim()).filter(Boolean)
}
