'use client'
import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import Link from 'next/link'
import { api, deleteWithUndo } from '../../../lib/api'
import { Select } from '@/components/ui/Select'
import { NavIcon } from '../../../components/ui/NavIcon'

interface Option {
  id?: string
  name: string
  priceDeltaCents: number
  isDefault: boolean
}
interface Template {
  id: string
  name: string
  description: string | null
  isRequired: boolean
  minSelect: number
  maxSelect: number
  isActive: boolean
  options: Option[]
}

export default function ModifiersPage() {
  const qc = useQueryClient()
  const [editing, setEditing] = useState<Template | null>(null)
  const [adding, setAdding] = useState(false)

  const { data = [], isLoading } = useQuery<Template[]>({
    queryKey: ['modifier-templates'],
    queryFn: () => api.get('/setup/modifier-templates'),
  })

  const del = useMutation({
    mutationFn: (id: string) => deleteWithUndo(`/setup/modifier-templates/${id}`, { trashType: 'modifier_template', id, onRestored: () => void qc.invalidateQueries({ queryKey: ['modifier-templates'] }) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['modifier-templates'] }),
  })

  return (
    <div className="min-h-screen" style={{ background: 'var(--bg)' }}>
      <header className="px-7 py-6 border-b border-white/[0.05]">
        <Link href="/configuration" className="text-xs text-white/40 hover:text-white/70">← Configuration Hub</Link>
        <div className="flex items-start justify-between gap-4 mt-2">
          <div>
            <h1 className="text-2xl font-black text-white/90">Modifier templates</h1>
            <p className="text-sm text-white/40 mt-1 max-w-2xl">
              Reusable option groups you can attach to any menu item — sauces, sizes, spice level, sides.
              Define once here, attach in the menu editor.
            </p>
          </div>
          <button onClick={() => setAdding(true)}
            className="rounded-xl bg-primary px-4 py-2.5 text-sm font-black text-primary-on hover:opacity-90">
            + New template
          </button>
        </div>
      </header>

      <div className="px-7 py-6 max-w-4xl mx-auto space-y-3">
        {isLoading && <p className="text-sm text-white/40">Loading…</p>}
        {!isLoading && data.length === 0 && (
          <Empty label="No modifier templates yet" hint="Create reusable option groups for your menu." />
        )}
        {data.map((t) => (
          <div key={t.id} className="rounded-2xl p-5"
            style={{ background: 'rgb(var(--fg-rgb) / 0.025)', border: '1px solid rgb(var(--fg-rgb) / 0.06)' }}>
            <div className="flex items-start justify-between gap-3">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <h3 className="text-lg font-black text-white/90">{t.name}</h3>
                  {t.isRequired && <span className="s-badge-red">Required</span>}
                  <Pill bg="rgb(var(--fg-rgb) / 0.06)" fg="rgb(var(--fg-rgb) / 0.55)">
                    {t.minSelect === t.maxSelect ? `Pick ${t.maxSelect}` : `Pick ${t.minSelect}-${t.maxSelect}`}
                  </Pill>
                </div>
                {t.description && <p className="text-sm text-white/55 mt-1">{t.description}</p>}
                {t.options.length > 0 && (
                  <div className="flex flex-wrap gap-1.5 mt-3">
                    {t.options.map((o, i) => (
                      <span key={i} className="text-xs font-semibold px-2 py-0.5 rounded-full"
                        style={o.isDefault
                          ? { background: 'var(--erp-accent-dim)', color: 'var(--erp-success)', border: '1px solid var(--erp-accent)' }
                          : { background: 'rgb(var(--erp-primary-rgb) / 0.08)', color: 'var(--erp-primary-ink)', border: '1px solid rgb(var(--erp-primary-rgb) / 0.15)' }}>
                        {o.name}{o.priceDeltaCents > 0 ? ` +${(o.priceDeltaCents / 100).toFixed(0)}` : o.priceDeltaCents < 0 ? ` ${(o.priceDeltaCents / 100).toFixed(0)}` : ''}
                        {o.isDefault ? <NavIcon name="star" size={11} className="ml-1 inline fill-current" /> : null}
                      </span>
                    ))}
                  </div>
                )}
              </div>
              <div className="flex flex-col gap-2 shrink-0">
                <button onClick={() => setEditing(t)} className="rounded-lg border border-white/10 px-3 py-1.5 text-xs text-white/55 hover:text-white">Edit</button>
                <button onClick={() => { if (confirm(`Delete "${t.name}"?`)) del.mutate(t.id) }}
                  className="rounded-lg border border-red-500/20 text-red-700/70 px-3 py-1.5 text-xs hover:text-red-700">Delete</button>
              </div>
            </div>
          </div>
        ))}
      </div>

      <AddOnIngredients />

      {(adding || editing) && (
        <Modal template={editing} onClose={() => { setAdding(false); setEditing(null) }}
          onSaved={() => { setAdding(false); setEditing(null); void qc.invalidateQueries({ queryKey: ['modifier-templates'] }) }} />
      )}
    </div>
  )
}

// ─── Add-on ingredients ─────────────────────────────────────────────────────
// Templates above are reusable option lists; the add-ons a dish actually
// sells are its modifier groups' options (menu editor). Each add-on can have
// ONE recipe (kind 'modifier'): what one of it adds to the dish — or takes
// off it ("No onion") — so its stock and food cost are counted on every sale.
// "Ingredients" opens that recipe, or starts it.

interface MenuTreeGroup { id: string; name: string; modifiers: Array<{ id: string; name: string; priceDeltaCents: number }> }
interface MenuTreeCategory { id: string; name: string; items: Array<{ id: string; name: string; modifierGroups?: MenuTreeGroup[] }> }
interface AddOnRecipe { id: string; kind: string; modifierId?: string | null; status: string }

function AddOnIngredients() {
  const { data: brands = [] } = useQuery<Array<{ id: string; name: string }>>({
    queryKey: ['concepts', 'picker'],
    queryFn: () => api.get('/concepts?view=picker'),
  })
  const [brandId, setBrandId] = useState('')
  const activeBrand = brandId || brands[0]?.id || ''
  const { data: menu = [], isLoading } = useQuery<MenuTreeCategory[]>({
    queryKey: ['recipes', 'brand-menu', activeBrand],
    queryFn: () => api.get(`/menu/${activeBrand}`),
    enabled: !!activeBrand,
  })
  // The brand's recipes include its add-on recipes (kind 'modifier').
  const { data: recipes = [] } = useQuery<AddOnRecipe[]>({
    queryKey: ['recipes', 'by-brand', activeBrand],
    queryFn: () => api.get(`/recipes?conceptId=${activeBrand}`),
    enabled: !!activeBrand,
    // A role without the recipes module just sees "No recipe" — not an error toast.
    meta: { background: true },
  })
  const recipeOf = new Map(recipes.filter((r) => r.kind === 'modifier' && r.modifierId).map((r) => [r.modifierId!, r]))
  const dishes = menu.flatMap((c) => c.items).filter((d) => (d.modifierGroups ?? []).some((g) => g.modifiers.length > 0))

  return (
    <section className="px-4 sm:px-7 pb-10 max-w-4xl mx-auto space-y-3">
      <div className="flex items-end justify-between gap-3 flex-wrap">
        <div>
          <p className="text-xs text-success">Food cost</p>
          <h2 className="text-lg font-black text-white/90">Add-on ingredients</h2>
          <p className="text-sm text-white/45 mt-1 max-w-2xl">
            What one of each add-on adds to the dish, or takes off it. Without it, an add-on sells with no stock or food cost.
          </p>
        </div>
        {brands.length > 1 && (
          <Select value={activeBrand} onChange={(e) => setBrandId(e.target.value)} className={fieldCls + ' w-auto'}>
            {brands.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
          </Select>
        )}
      </div>
      {isLoading && <p className="text-sm text-white/40">Loading…</p>}
      {!isLoading && activeBrand && dishes.length === 0 && (
        <Empty label="No add-ons on this brand's menu" hint="Add modifier groups to a dish in the menu editor first." />
      )}
      {dishes.map((d) => (
        <div key={d.id} className="rounded-2xl p-4"
          style={{ background: 'rgb(var(--fg-rgb) / 0.025)', border: '1px solid rgb(var(--fg-rgb) / 0.06)' }}>
          <h3 className="font-black text-white/90">{d.name}</h3>
          {(d.modifierGroups ?? []).filter((g) => g.modifiers.length > 0).map((g) => (
            <div key={g.id} className="mt-2">
              <p className="text-[10px] font-bold uppercase tracking-wider text-white/45">{g.name}</p>
              <ul className="mt-1 divide-y divide-white/[0.05]">
                {g.modifiers.map((m) => {
                  const r = recipeOf.get(m.id)
                  const href = r
                    ? `/accounting/recipes/${r.id}`
                    : `/accounting/recipes/new?brandId=${activeBrand}&menuItemId=${d.id}&groupId=${g.id}&modifierId=${m.id}`
                  return (
                    <li key={m.id} className="flex items-center justify-between gap-3 py-1.5">
                      <span className="text-sm text-white/80 min-w-0 truncate">{m.name}</span>
                      <span className="flex items-center gap-2 shrink-0">
                        {r
                          ? <span className="s-badge-green">Has a recipe</span>
                          : <span className="s-badge-amber">No recipe</span>}
                        <Link href={href} className="rounded-lg border border-white/10 px-3 py-1 text-xs text-primary-ink hover:bg-primary/10">
                          Ingredients
                        </Link>
                      </span>
                    </li>
                  )
                })}
              </ul>
            </div>
          ))}
        </div>
      ))}
    </section>
  )
}

function Empty({ label, hint }: { label: string; hint: string }) {
  return (
    <div className="rounded-2xl p-10 text-center"
      style={{ background: 'rgb(var(--fg-rgb) / 0.02)', border: '1px solid rgb(var(--fg-rgb) / 0.05)' }}>
      <p className="font-bold text-white/85">{label}</p>
      <p className="text-sm text-white/45 mt-1">{hint}</p>
    </div>
  )
}

function Pill({ bg, fg, children }: { bg: string; fg: string; children: React.ReactNode }) {
  return <span className="rounded-full px-2 py-0.5 text-[10px] font-black uppercase tracking-wider" style={{ background: bg, color: fg }}>{children}</span>
}

function Modal({ template, onClose, onSaved }: { template: Template | null; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(template?.name ?? '')
  const [description, setDescription] = useState(template?.description ?? '')
  const [isRequired, setIsRequired] = useState(template?.isRequired ?? false)
  const [minSelect, setMinSelect] = useState(template?.minSelect ?? 0)
  const [maxSelect, setMaxSelect] = useState(template?.maxSelect ?? 1)
  const [options, setOptions] = useState<Option[]>(template?.options ?? [{ name: '', priceDeltaCents: 0, isDefault: false }])

  const save = useMutation({
    mutationFn: () => {
      const payload = {
        name: name.trim(),
        description: description.trim() || undefined,
        isRequired,
        minSelect,
        maxSelect,
        options: options.filter((o) => o.name.trim().length > 0),
      }
      if (template) return api.patch(`/setup/modifier-templates/${template.id}`, payload)
      return api.post('/setup/modifier-templates', payload)
    },
    onSuccess: () => onSaved(),
  })

  function update(idx: number, patch: Partial<Option>) {
    setOptions((prev) => prev.map((o, i) => i === idx ? { ...o, ...patch } : o))
  }
  function add() { setOptions((prev) => [...prev, { name: '', priceDeltaCents: 0, isDefault: false }]) }
  function rm(idx: number) { setOptions((prev) => prev.filter((_, i) => i !== idx)) }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-secondary/40 p-4" onClick={onClose}>
      <div className="w-full max-w-xl rounded-2xl overflow-hidden"
        style={{ background: 'var(--surface)', border: '1px solid rgb(var(--fg-rgb) / 0.08)' }}
        onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-white/[0.05] px-5 py-3">
          <h2 className="font-black text-white/90">{template ? 'Edit template' : 'New modifier template'}</h2>
          <button onClick={onClose} className="text-white/40 text-xl"><NavIcon name="x" size={16} /></button>
        </div>
        <div className="p-5 space-y-4 max-h-[70vh] overflow-y-auto">
          <Field label="Name *">
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Spice level" className={fieldCls} autoFocus />
          </Field>
          <Field label="Description">
            <input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Customer-facing helper text" className={fieldCls} />
          </Field>
          <div className="grid grid-cols-3 gap-3">
            <Field label="Min picks">
              <input type="number" value={minSelect} onChange={(e) => setMinSelect(Math.max(0, parseInt(e.target.value) || 0))} className={fieldCls} />
            </Field>
            <Field label="Max picks">
              <input type="number" value={maxSelect} onChange={(e) => setMaxSelect(Math.max(1, parseInt(e.target.value) || 1))} className={fieldCls} />
            </Field>
            <label className="flex items-end gap-2 pb-2 cursor-pointer">
              <input type="checkbox" checked={isRequired} onChange={(e) => setIsRequired(e.target.checked)} className="accent-accent" />
              <span className="text-xs text-white/65">Required</span>
            </label>
          </div>

          <div>
            <label className="text-xs text-white/55">Options</label>
            <div className="space-y-2 mt-2">
              {options.map((o, idx) => (
                <div key={idx} className="grid grid-cols-[1fr_100px_auto_auto] gap-2 items-center">
                  <input value={o.name} onChange={(e) => update(idx, { name: e.target.value })} placeholder="Option name" className={fieldCls} />
                  <input type="number" value={o.priceDeltaCents} onChange={(e) => update(idx, { priceDeltaCents: parseInt(e.target.value) || 0 })} placeholder="±cents" className={fieldCls} />
                  <label className="flex items-center gap-1 text-[10px] text-white/55 cursor-pointer">
                    <input type="checkbox" checked={o.isDefault} onChange={(e) => update(idx, { isDefault: e.target.checked })} className="accent-accent" />
                    Default
                  </label>
                  <button onClick={() => rm(idx)} className="text-white/30 hover:text-red-700 px-2"><NavIcon name="x" size={16} /></button>
                </div>
              ))}
            </div>
            <button onClick={add} className="mt-2 text-xs text-primary-ink hover:underline">+ Add option</button>
          </div>
        </div>
        <div className="flex justify-between gap-3 border-t border-white/[0.05] p-4 bg-white/[0.01]">
          <button onClick={onClose} className="rounded-xl border border-white/10 px-4 py-2.5 text-sm text-white/55 hover:text-white">Cancel</button>
          <button onClick={() => save.mutate()} disabled={save.isPending || !name.trim()}
            className="rounded-xl bg-primary px-5 py-2.5 text-sm font-black text-primary-on hover:opacity-90 disabled:opacity-50">
            {save.isPending ? 'Saving…' : template ? 'Save changes' : 'Create template'}
          </button>
        </div>
      </div>
    </div>
  )
}

const fieldCls = "w-full rounded-lg bg-white/[0.03] border border-white/[0.08] px-3 py-2 text-sm text-white/85 focus:border-primary focus:outline-none"
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <div><label className="text-xs text-white/55">{label}</label><div className="mt-1">{children}</div></div>
}
