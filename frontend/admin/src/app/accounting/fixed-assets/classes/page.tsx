'use client'
// Asset classes and register policy. A class sets the default life and the tax
// rates for everything bought into it (kitchen equipment, furniture, IT,
// vehicles, smallwares …); the ledger accounts of a class never change. The
// CEO edits; everyone else reads. Depreciation is always automatic, so there is
// no switch here.

import { CheckLabel, Input, LinkButton } from '@/components/finance/ui'
import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../../../../lib/api'
import { NumberField } from '../../../../components/ui/NumberField'
import {
  FA_BASE, FaFrame, Notice, Modal, L, ErrorLine, card, inp, btnPrimary, btnGhost, fmtLife, pct, errorWords,
} from '../../../../components/fixedAssets/shared'

interface ClassRow {
  id: string; tenantId: string; companyName: string; key: string; label: string
  costAccountCode: string; accumAccountCode: string | null; depreciable: boolean; pooled: boolean
  defaultLifeMonths: number | null; taxRateBp: number; taxInitialAllowanceBp: number; isActive: boolean; assetCount: number
}
interface PolicyRow { tenantId: string; companyName: string; capexUncapitalisedAlertDays: number; capexAdvanceOverdueDays: number; assetTagPrefix: string }

export default function ClassesPage() {
  const qc = useQueryClient()
  const [editing, setEditing] = useState<ClassRow | null>(null)
  const [editingPolicy, setEditingPolicy] = useState<PolicyRow | null>(null)
  const [notice, setNotice] = useState<{ tone: 'ok' | 'wait' | 'bad'; text: string } | null>(null)

  const classes = useQuery<{ classes: ClassRow[]; canEdit: boolean }>({
    queryKey: ['fa-classes'],
    queryFn: () => api.get(`${FA_BASE}/classes`),
  })
  const policy = useQuery<{ policies: PolicyRow[]; canEdit: boolean }>({
    queryKey: ['fa-policy'],
    queryFn: () => api.get(`${FA_BASE}/policy`),
  })

  const canEdit = !!classes.data?.canEdit
  const rows = classes.data?.classes ?? []
  const multi = new Set(rows.map((r) => r.tenantId)).size > 1
  const policies = policy.data?.policies ?? []

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['fa-classes'] })
    void qc.invalidateQueries({ queryKey: ['fa-policy'] })
    void qc.invalidateQueries({ queryKey: ['fa-lookups'] })
  }

  return (
    <FaFrame
      title="Classes & policy"
      subtitle={canEdit
        ? 'Lives and tax rates for each kind of asset, and the register policy. Changes apply to assets bought from now on; posted depreciation never changes.'
        : 'Lives and tax rates for each kind of asset, and the register policy. Only the CEO can change them.'}
    >
      {notice && <Notice tone={notice.tone} onClose={() => setNotice(null)}>{notice.text}</Notice>}
      {classes.error && <Notice tone="bad">{errorWords(classes.error)}</Notice>}

      <section className="rounded-2xl overflow-x-auto" style={card} aria-label="Asset classes">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs uppercase tracking-wider text-white/40">
              {[...(multi ? ['Company'] : []), 'Class', 'Ledger accounts', 'Default life', 'Tax rate', 'First-year allowance', 'Pooled', 'Assets', ''].map((h) => (
                <th key={h || 'edit'} className="px-4 py-3 font-bold whitespace-nowrap">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((c) => (
              <tr key={c.id} className="border-t border-white/[0.05]" style={{ opacity: c.isActive ? 1 : 0.55 }}>
                {multi && <td className="px-4 py-3 text-white/60">{c.companyName}</td>}
                <td className="px-4 py-3 font-bold text-white/90">{c.label}{!c.isActive && <span className="s-badge-muted ml-2">Switched off</span>}</td>
                <td className="px-4 py-3 text-white/55 whitespace-nowrap">{c.costAccountCode}{c.accumAccountCode ? ` / ${c.accumAccountCode}` : ''}</td>
                <td className="px-4 py-3 text-white/75 whitespace-nowrap">{c.depreciable ? fmtLife(c.defaultLifeMonths) : 'Not depreciated'}</td>
                <td className="px-4 py-3 text-white/75">{c.taxRateBp ? pct(c.taxRateBp) : '—'}</td>
                <td className="px-4 py-3 text-white/75">{c.taxInitialAllowanceBp ? pct(c.taxInitialAllowanceBp) : '—'}</td>
                <td className="px-4 py-3">{c.pooled ? <span className="s-badge-green">Pooled</span> : <span className="text-white/40">Item by item</span>}</td>
                <td className="px-4 py-3 text-white/60">{c.assetCount}</td>
                <td className="px-4 py-3 text-right">{canEdit && <LinkButton type="button"  onClick={() => { setNotice(null); setEditing(c) }}>Edit</LinkButton>}</td>
              </tr>
            ))}
            {classes.data && rows.length === 0 && <tr><td colSpan={9} className="px-4 py-6 text-white/45">No classes yet.</td></tr>}
          </tbody>
        </table>
      </section>
      <p className="text-xs text-s-muted">
        Tax rates follow the Third Schedule of the Income Tax Ordinance; smallwares are deducted in full for tax in the year they are bought, and initial allowance applies to kitchen and power equipment only.
      </p>

      <section className="space-y-3" aria-label="Register policy">
        <p className="text-xs font-bold uppercase tracking-wider text-white/45">Register policy</p>
        {policies.map((p) => (
          <div key={p.tenantId} className="rounded-2xl p-4" style={card}>
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div>
                <p className="font-black text-white/90">{p.companyName}</p>
                <p className="text-xs text-s-muted mt-0.5">Depreciation: automatic, every night, for completed months.</p>
              </div>
              {canEdit && <button className={btnGhost} onClick={() => { setNotice(null); setEditingPolicy(p) }}>Edit policy</button>}
            </div>
            <dl className="grid grid-cols-1 sm:grid-cols-3 gap-4 mt-3 text-sm">
              <div><dt className="text-xs font-bold uppercase tracking-wider text-white/40">Asset tag prefix</dt><dd className="text-white/85 font-mono">{p.assetTagPrefix}</dd></div>
              <div><dt className="text-xs font-bold uppercase tracking-wider text-white/40">Flag delivered items not capitalised after</dt><dd className="text-white/85">{p.capexUncapitalisedAlertDays} days</dd></div>
              <div><dt className="text-xs font-bold uppercase tracking-wider text-white/40">Flag supplier advances overdue after</dt><dd className="text-white/85">{p.capexAdvanceOverdueDays} days</dd></div>
            </dl>
          </div>
        ))}
        {policy.data && policies.length === 0 && <p className="text-sm text-white/45">No company in view.</p>}
      </section>

      {editing && (
        <EditClass row={editing} onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); setNotice({ tone: 'ok', text: 'Class saved.' }); refresh() }} />
      )}
      {editingPolicy && (
        <EditPolicy row={editingPolicy} onClose={() => setEditingPolicy(null)}
          onSaved={() => { setEditingPolicy(null); setNotice({ tone: 'ok', text: 'Policy saved.' }); refresh() }} />
      )}
    </FaFrame>
  )
}

/** Digits-only text state ↔ NumberField value (the state stays the string the form always held). */
const asNum = (v: string): number | null => (v.trim() === '' || !Number.isFinite(Number(v)) ? null : Number(v))
const fromNum = (n: number | null): string => (n == null ? '' : String(n))

function EditClass({ row, onClose, onSaved }: { row: ClassRow; onClose: () => void; onSaved: () => void }) {
  const [label, setLabel] = useState(row.label)
  const [life, setLife] = useState(row.defaultLifeMonths ? String(row.defaultLifeMonths) : '')
  const [rate, setRate] = useState(String(row.taxRateBp / 100))
  const [allowance, setAllowance] = useState(String(row.taxInitialAllowanceBp / 100))
  const [pooled, setPooled] = useState(row.pooled)
  const [active, setActive] = useState(row.isActive)

  const save = useMutation({
    mutationFn: () => api.patch(`${FA_BASE}/classes/${row.id}`, {
      label: label.trim(),
      ...(row.depreciable ? { defaultLifeMonths: Number(life) } : {}),
      taxRateBp: Math.round(Number(rate) * 100),
      taxInitialAllowanceBp: Math.round(Number(allowance) * 100),
      ...(pooled !== row.pooled ? { pooled } : {}),
      isActive: active,
    }, { tenantId: row.tenantId }),
    onSuccess: onSaved,
  })
  const lifeOk = !row.depreciable || (Number(life) >= 1 && Number(life) <= 600)
  const ratesOk = rate.trim() !== '' && allowance.trim() !== '' && Number(rate) >= 0 && Number(rate) <= 100 && Number(allowance) >= 0 && Number(allowance) <= 100
  const [problem, setProblem] = useState<string | null>(null)
  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (save.isPending) return
    const bad: [string, string] | null = !label.trim() ? ['ec-name', 'The class needs a name.']
      : !lifeOk ? ['ec-life', 'Default life must be 1 to 600 months.']
      : !ratesOk ? ['ec-rate', 'The tax rate and the first-year allowance must each be 0 to 100%.']
      : null
    if (bad) { setProblem(bad[1]); document.getElementById(bad[0])?.focus(); return }
    setProblem(null)
    save.mutate()
  }
  const dirty = !save.isPending && (label !== row.label || life !== (row.defaultLifeMonths ? String(row.defaultLifeMonths) : '') || rate !== String(row.taxRateBp / 100)
    || allowance !== String(row.taxInitialAllowanceBp / 100) || pooled !== row.pooled || active !== row.isActive)

  return (
    <Modal title={`Edit ${row.label}`} onClose={onClose} dirty={dirty}>
      <form onSubmit={onSubmit} noValidate className="space-y-3">
        <p className="text-xs text-s-muted">Ledger accounts {row.costAccountCode}{row.accumAccountCode ? ` / ${row.accumAccountCode}` : ''} are fixed for the class and cannot change.</p>
        <L t="Name"><Input id="ec-name" className={inp} value={label} onChange={(e) => setLabel(e.target.value)} /></L>
        {row.depreciable ? (
          <L t="Default life (months)" hint={Number(life) > 0 ? `That is ${fmtLife(Number(life))}. Used when an item is prepared for the register without its own life.` : undefined}>
            <NumberField id="ec-life" min={1} max={600} className={inp} value={asNum(life)} onValueChange={(n) => setLife(fromNum(n))} />
          </L>
        ) : <p className="text-sm text-white/60">This class is never depreciated, so it has no life.</p>}
        <div className="grid grid-cols-2 gap-3">
          <L t="Tax depreciation rate (%)"><NumberField id="ec-rate" decimals={2} min={0} max={100} className={inp} value={asNum(rate)} onValueChange={(n) => setRate(fromNum(n))} /></L>
          <L t="First-year allowance (%)"><NumberField decimals={2} min={0} max={100} className={inp} value={asNum(allowance)} onValueChange={(n) => setAllowance(fromNum(n))} /></L>
        </div>
        <CheckLabel className="flex items-start gap-2 text-sm text-white/75">
          <input type="checkbox" className="mt-0.5" checked={pooled} disabled={row.assetCount > 0} onChange={(e) => setPooled(e.target.checked)} style={{ accentColor: 'var(--erp-accent)' }} />
          <span>Pooled: tracked as units per outlet, brand and type instead of item by item
            {row.assetCount > 0 && <span className="block text-xs text-s-muted">Locked: this class already has {row.assetCount} asset{row.assetCount === 1 ? '' : 's'} on the register.</span>}</span>
        </CheckLabel>
        <CheckLabel className="flex items-center gap-2 text-sm text-white/75">
          <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} style={{ accentColor: 'var(--erp-accent)' }} />
          In use (switched-off classes cannot be picked for new assets)
        </CheckLabel>
        {problem && <p role="alert" className="text-xs font-bold text-s-red">{problem}</p>}
        <ErrorLine error={save.error} />
        <div className="flex gap-2 pt-2">
          <button type="submit" disabled={save.isPending} className={btnPrimary}>{save.isPending ? 'Saving…' : 'Save class'}</button>
          <button type="button" onClick={onClose} className={btnGhost}>Cancel</button>
        </div>
      </form>
    </Modal>
  )
}

function EditPolicy({ row, onClose, onSaved }: { row: PolicyRow; onClose: () => void; onSaved: () => void }) {
  const [prefix, setPrefix] = useState(row.assetTagPrefix)
  const [uncap, setUncap] = useState(String(row.capexUncapitalisedAlertDays))
  const [overdue, setOverdue] = useState(String(row.capexAdvanceOverdueDays))

  const save = useMutation({
    mutationFn: () => api.patch(`${FA_BASE}/policy`, {
      assetTagPrefix: prefix.trim(),
      capexUncapitalisedAlertDays: Number(uncap),
      capexAdvanceOverdueDays: Number(overdue),
    }, { tenantId: row.tenantId }),
    onSuccess: onSaved,
  })
  const [problem, setProblem] = useState<string | null>(null)
  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (save.isPending) return
    const bad: [string, string] | null = !/^[A-Za-z0-9_-]{1,12}$/.test(prefix.trim()) ? ['ep-prefix', 'The tag prefix is 1 to 12 letters, digits, - or _.']
      : !(Number(uncap) >= 1 && Number(uncap) <= 365) ? ['ep-uncap', 'Days must be 1 to 365.']
      : !(Number(overdue) >= 1 && Number(overdue) <= 365) ? ['ep-overdue', 'Days must be 1 to 365.']
      : null
    if (bad) { setProblem(bad[1]); document.getElementById(bad[0])?.focus(); return }
    setProblem(null)
    save.mutate()
  }
  const dirty = !save.isPending && (prefix !== row.assetTagPrefix || uncap !== String(row.capexUncapitalisedAlertDays) || overdue !== String(row.capexAdvanceOverdueDays))

  return (
    <Modal title={`Register policy: ${row.companyName}`} onClose={onClose} dirty={dirty}>
      <form onSubmit={onSubmit} noValidate className="space-y-3">
        <L t="Asset tag prefix" hint="Letters, digits, - and _ only, up to 12. New tags are the prefix and a running number, like FA-00001. Existing tags do not change.">
          <Input id="ep-prefix" className={inp} value={prefix} onChange={(e) => setPrefix(e.target.value)} maxLength={12} />
        </L>
        <L t="Flag a delivered item not yet capitalised after (days)">
          <NumberField id="ep-uncap" min={1} max={365} className={inp} value={asNum(uncap)} onValueChange={(n) => setUncap(fromNum(n))} />
        </L>
        <L t="Flag a supplier advance with no delivery after (days)">
          <NumberField id="ep-overdue" min={1} max={365} className={inp} value={asNum(overdue)} onValueChange={(n) => setOverdue(fromNum(n))} />
        </L>
        {problem && <p role="alert" className="text-xs font-bold text-s-red">{problem}</p>}
        <ErrorLine error={save.error} />
        <div className="flex gap-2 pt-2">
          <button type="submit" disabled={save.isPending} className={btnPrimary}>{save.isPending ? 'Saving…' : 'Save policy'}</button>
          <button type="button" onClick={onClose} className={btnGhost}>Cancel</button>
        </div>
      </form>
    </Modal>
  )
}
