'use client'
// Dish options (owner, 2026-11-12: "i cant add variation to the menu item. For
// example a single patty and double patty version").
//
// The dish editor's "Options" section. A group ("Patty") holds options
// ("Single" +0, "Double" +PKR 400). It saves through the existing engine:
// POST /menu/modifier-groups (new), PATCH /menu/modifier-groups/:id (edit —
// the full option list; options left out are soft-removed), DELETE (to the
// Trash), and a saved list through POST /setup/modifier-templates/:id/apply.
// Each saved option links to its add-on recipe, so "Double" can add a patty to
// stock and food cost (same link rule as Configuration -> Modifiers).

import Link from 'next/link'
import { useState } from 'react'
import { Trash2, X } from 'lucide-react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { api, deleteWithUndo, menuApi, type Category, type MenuItem } from '../../lib/api'
import { MoneyInput } from '../ui/MoneyInput'
import { useConfirm } from '../ui/ConfirmDialog'

interface ServerOption { id: string; name: string; priceDeltaCents: number; isDefault: boolean; sortOrder?: number }
interface ServerGroup { id: string; name: string; isRequired: boolean; minSelect: number; maxSelect: number; sortOrder?: number; modifiers: ServerOption[] }
interface Template { id: string; name: string; isActive?: boolean; options: Array<{ name: string }> }
interface AddOnRecipe { id: string; kind?: string; modifierId?: string | null }

type Mode = 'one' | 'optional' | 'some'
interface OptionDraft { key: string; id?: string; name: string; priceDeltaCents: number; isDefault: boolean }

const inputCls = 'w-full rounded-lg border border-s-border bg-s-bg px-3 py-2 text-sm text-s-text focus:border-primary focus:outline-none'
let seq = 0
const nextKey = () => `new-${++seq}`

function modeOf(g: { isRequired: boolean; minSelect: number; maxSelect: number }): Mode {
  if (g.maxSelect === 1 && (g.isRequired || g.minSelect >= 1)) return 'one'
  if (!g.isRequired && g.minSelect === 0) return 'optional'
  return 'some'
}

/** The dish editor's Options section. */
export function DishOptions({ item }: { item: MenuItem }) {
  const qc = useQueryClient()
  const conceptId = item.conceptId
  // The live menu (the page's own query) so a save shows at once.
  const { data: menu } = useQuery<Category[]>({
    queryKey: ['menu', conceptId],
    queryFn: () => menuApi.getMenu(conceptId),
    enabled: !!conceptId,
  })
  const live = menu?.flatMap((c) => c.items).find((i) => i.id === item.id)
  const groups = ((live ?? item).modifierGroups ?? []) as unknown as ServerGroup[]

  const { data: recipes = [] } = useQuery<AddOnRecipe[]>({
    queryKey: ['recipes', 'by-brand', conceptId],
    queryFn: () => api.get(`/recipes?conceptId=${conceptId}`),
    enabled: !!conceptId,
    meta: { background: true },
  })
  const recipeOf = new Map(recipes.filter((r) => r.kind === 'modifier' && r.modifierId).map((r) => [r.modifierId!, r.id]))

  const { data: templates = [] } = useQuery<Template[]>({
    queryKey: ['modifier-templates'],
    queryFn: () => api.get('/setup/modifier-templates'),
    meta: { background: true },
  })
  const usable = templates.filter((t) => t.isActive !== false && t.options.length > 0)

  const [newKeys, setNewKeys] = useState<string[]>([])
  const refresh = () => qc.invalidateQueries({ queryKey: ['menu', conceptId] })

  const apply = useMutation({
    mutationFn: (templateId: string) => api.post(`/setup/modifier-templates/${templateId}/apply`, { menuItemId: item.id }),
    onSuccess: () => { toast.success('Option group added'); void refresh() },
    onError: (e: Error) => toast.error(e.message || 'Could not add the saved list'),
  })

  return (
    <section className="border-t border-s-border pt-3 space-y-3"
      // Enter in an option field never saves the whole dish.
      onKeyDown={(e) => { if (e.key === 'Enter' && (e.target as HTMLElement).tagName === 'INPUT') e.preventDefault() }}>
      <div>
        <h3 className="text-xs font-semibold text-s-muted uppercase tracking-wide">Options</h3>
        <p className="text-xs text-s-muted mt-1">
          Example: group &lsquo;Patty&rsquo;, options &lsquo;Single&rsquo; (+0, default) and &lsquo;Double&rsquo; (+PKR 400).
          Give &lsquo;Double&rsquo; its ingredients so stock and food cost count the extra patty.
        </p>
      </div>

      {groups.length === 0 && newKeys.length === 0 && (
        <p className="text-sm text-s-muted">No options on this dish yet.</p>
      )}

      {groups.map((g) => (
        <GroupEditor key={g.id} group={g} menuItemId={item.id} conceptId={conceptId} recipeOf={recipeOf} onSaved={refresh} />
      ))}
      {newKeys.map((k) => (
        <GroupEditor key={k} group={null} menuItemId={item.id} conceptId={conceptId} recipeOf={recipeOf}
          onSaved={() => { setNewKeys((ks) => ks.filter((x) => x !== k)); void refresh() }}
          onDiscard={() => setNewKeys((ks) => ks.filter((x) => x !== k))} />
      ))}

      <div className="flex flex-col sm:flex-row gap-2">
        <button type="button" onClick={() => setNewKeys((ks) => [...ks, nextKey()])}
          className="rounded-lg border border-s-border px-3 py-2 text-sm text-primary-ink hover:bg-primary/10">
          + Add option group
        </button>
        {usable.length > 0 && (
          <select aria-label="Use a saved list" value="" disabled={apply.isPending}
            onChange={(e) => { if (e.target.value) apply.mutate(e.target.value) }}
            className="rounded-lg border border-s-border bg-s-bg px-3 py-2 text-sm text-s-text focus:border-primary focus:outline-none sm:w-auto">
            <option value="">{apply.isPending ? 'Adding…' : 'Use a saved list…'}</option>
            {usable.map((t) => (
              <option key={t.id} value={t.id}>{t.name} ({t.options.length} option{t.options.length === 1 ? '' : 's'})</option>
            ))}
          </select>
        )}
      </div>
    </section>
  )
}

function GroupEditor({ group, menuItemId, conceptId, recipeOf, onSaved, onDiscard }: {
  group: ServerGroup | null
  menuItemId: string
  conceptId: string
  recipeOf: Map<string, string>
  onSaved: () => void
  onDiscard?: () => void
}) {
  const confirm = useConfirm()
  const fromServer = (g: ServerGroup | null): { name: string; mode: Mode; max: number; min: number; options: OptionDraft[] } => ({
    name: g?.name ?? '',
    mode: g ? modeOf(g) : 'one',
    max: g ? Math.max(1, g.maxSelect) : 1,
    min: g ? g.minSelect : 1,
    options: g
      ? g.modifiers.map((m) => ({ key: m.id, id: m.id, name: m.name, priceDeltaCents: m.priceDeltaCents, isDefault: m.isDefault }))
      : [{ key: nextKey(), name: '', priceDeltaCents: 0, isDefault: true }],
  })
  const [draft, setDraft] = useState(() => fromServer(group))
  const [dirty, setDirty] = useState(!group)
  const [error, setError] = useState('')
  const set = (patch: Partial<typeof draft>) => { setDraft((d) => ({ ...d, ...patch })); setDirty(true); setError('') }
  const setOption = (key: string, patch: Partial<OptionDraft>) =>
    set({ options: draft.options.map((o) => (o.key === key ? { ...o, ...patch } : o)) })
  const pickOne = draft.mode === 'one'

  const payload = () => {
    const max = pickOne ? 1 : Math.max(1, draft.max)
    const rules = draft.mode === 'one'
      ? { isRequired: true, minSelect: 1, maxSelect: 1 }
      : draft.mode === 'optional'
        ? { isRequired: false, minSelect: 0, maxSelect: max }
        : { isRequired: true, minSelect: Math.min(Math.max(1, draft.min), max), maxSelect: max }
    return {
      name: draft.name.trim(),
      ...rules,
      modifiers: draft.options.map((o, i) => ({
        ...(o.id ? { id: o.id } : {}),
        name: o.name.trim(), priceDeltaCents: o.priceDeltaCents, isDefault: o.isDefault, sortOrder: i,
      })),
    }
  }

  const save = useMutation({
    mutationFn: () => {
      const body = payload()
      if (!body.name) throw new Error('Give the group a name, e.g. Patty.')
      if (body.modifiers.length === 0) throw new Error('Add at least one option.')
      if (body.modifiers.some((m) => !m.name)) throw new Error('Every option needs a name.')
      if (body.maxSelect === 1 && body.modifiers.filter((m) => m.isDefault).length > 1) throw new Error('Only one option can be the default.')
      return group
        ? api.patch<ServerGroup>(`/menu/modifier-groups/${group.id}`, body)
        : api.post<ServerGroup>('/menu/modifier-groups', { menuItemId, ...body })
    },
    onSuccess: (saved) => {
      toast.success(`${saved.name} saved`)
      if (group) { setDraft(fromServer(saved)); setDirty(false) }
      onSaved()
    },
    onError: (e: Error) => setError(e.message || 'Could not save the options'),
  })

  async function remove() {
    if (!group) { onDiscard?.(); return }
    const ok = await confirm({
      title: `Remove "${group.name}" from this dish?`,
      body: 'The group and its options leave the menu. It goes to the Trash, so you can bring it back.',
      confirmLabel: 'Remove group', danger: true,
    })
    if (!ok) return
    try {
      await deleteWithUndo(`/menu/modifier-groups/${group.id}`, { trashType: 'modifier_group', id: group.id, label: group.name, onRestored: onSaved })
      onSaved()
    } catch (e) {
      toast.error((e as Error).message || 'Could not remove the group')
    }
  }

  const radioName = `default-${group?.id ?? draft.options[0]?.key ?? 'new'}`

  return (
    <div className="rounded-xl border border-s-border p-3 space-y-3">
      <div className="flex flex-col sm:flex-row sm:items-end gap-2">
        <label className="flex-1 min-w-0">
          <span className="text-xs text-s-muted">Group name</span>
          <input value={draft.name} onChange={(e) => set({ name: e.target.value })} placeholder="e.g. Patty" maxLength={80} className={inputCls} />
        </label>
        <label className="sm:w-56">
          <span className="text-xs text-s-muted">Customer</span>
          <select value={draft.mode} onChange={(e) => set({ mode: e.target.value as Mode, ...(e.target.value === 'one' ? { max: 1 } : {}) })} className={inputCls}>
            <option value="one">Must pick one</option>
            <option value="optional">Optional, may pick up to…</option>
            <option value="some">Must pick at least one, up to…</option>
          </select>
        </label>
        {!pickOne && (
          <label className="sm:w-24">
            <span className="text-xs text-s-muted">Up to</span>
            <input type="number" inputMode="numeric" min={1} max={50} value={draft.max}
              onChange={(e) => set({ max: Math.max(1, Math.min(50, Number(e.target.value) || 1)) })} className={inputCls} />
          </label>
        )}
      </div>

      <ul className="space-y-2">
        {draft.options.map((o) => {
          const recipeId = o.id ? recipeOf.get(o.id) : undefined
          const href = o.id && group
            ? recipeId
              ? `/accounting/recipes/${recipeId}`
              : `/accounting/recipes/new?brandId=${conceptId}&menuItemId=${menuItemId}&groupId=${group.id}&modifierId=${o.id}`
            : null
          return (
            <li key={o.key} className="grid grid-cols-1 gap-2 sm:grid-cols-[minmax(0,1fr)_8rem_auto_auto] sm:items-center rounded-lg sm:rounded-none bg-s-bg/40 sm:bg-transparent p-2 sm:p-0">
              <input aria-label="Option name" value={o.name} placeholder="e.g. Double" maxLength={80}
                onChange={(e) => setOption(o.key, { name: e.target.value })} className={inputCls} />
              <div className="flex items-center gap-1">
                <span className="text-xs text-s-muted shrink-0">+PKR</span>
                <MoneyInput value={o.priceDeltaCents} allowNegative ariaLabel="Price change (PKR)"
                  onChange={(c) => setOption(o.key, { priceDeltaCents: c })} className={inputCls} />
              </div>
              <label className="flex items-center gap-1.5 text-xs text-s-muted">
                {pickOne
                  ? <input type="radio" name={radioName} checked={o.isDefault}
                      onChange={() => set({ options: draft.options.map((x) => ({ ...x, isDefault: x.key === o.key })) })} />
                  : <input type="checkbox" checked={o.isDefault} onChange={(e) => setOption(o.key, { isDefault: e.target.checked })} />}
                Default
              </label>
              <div className="flex items-center gap-3">
                {href
                  ? <Link href={href} className="text-xs text-primary-ink hover:underline">
                      Ingredients{recipeId ? '' : ' (none yet)'}
                    </Link>
                  : <span className="text-xs text-s-muted">Save to add ingredients</span>}
                <button type="button" aria-label={`Remove option ${o.name || ''}`}
                  onClick={() => set({ options: draft.options.filter((x) => x.key !== o.key) })}
                  className="text-s-muted hover:text-s-red p-1"><X size={16} aria-hidden="true" /></button>
              </div>
            </li>
          )
        })}
      </ul>

      <div className="flex flex-col-reverse sm:flex-row sm:items-center gap-2">
        <button type="button" onClick={() => set({ options: [...draft.options, { key: nextKey(), name: '', priceDeltaCents: 0, isDefault: false }] })}
          className="rounded-lg border border-s-border px-3 py-2 text-sm text-s-text hover:bg-primary/10">
          + Add option
        </button>
        <div className="sm:ml-auto flex gap-2">
          <button type="button" onClick={() => void remove()}
            className="flex-1 sm:flex-none inline-flex items-center justify-center gap-1 rounded-lg border border-s-border px-3 py-2 text-sm text-s-red hover:bg-s-red/10">
            <Trash2 size={14} aria-hidden="true" /> {group ? 'Remove group' : 'Discard'}
          </button>
          <button type="button" disabled={!dirty || save.isPending} onClick={() => save.mutate()}
            className="flex-1 sm:flex-none rounded-lg bg-primary px-4 py-2 text-sm font-bold text-primary-on disabled:opacity-50 hover:opacity-90">
            {save.isPending ? 'Saving…' : group ? (dirty ? 'Save group' : 'Saved') : 'Save group'}
          </button>
        </div>
      </div>
      {error && <p role="alert" className="text-sm text-s-red">{error}</p>}
    </div>
  )
}
