'use client'
// Hand-over dialogs (D3). The CEO hands a section's approvals to a
// head-office person, for the whole head office or one company, until a date;
// and takes it back with a reason. Exported for the head-office page (HO-D1)
// as well as /ceo/approvals/hand-over.
//
// The API decides everything (POST /approvals/delegations, .../:id/revoke);
// SECTION_NOT_YET_DELEGABLE is shown as "Waiting for owner confirmation".

import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, ApiError } from '../../lib/api'
import { Modal } from '../hr/HrShell'
import Select from '../ui/Select'
import {
  APPROVALS_CATALOG_KEY, APPROVALS_ROOT, useHeadOffices,
  type CatalogSection, type EligibleDelegate,
} from '../../app/ceo/approvalsData'

const field = { background: 'var(--surface)', border: '1px solid var(--border)', color: 'var(--text)' }
const WAITING = 'Waiting for owner confirmation'

function errorText(e: unknown): string {
  if (e instanceof ApiError && e.code === 'SECTION_NOT_YET_DELEGABLE') return `${WAITING}. ${e.message}`
  return (e as Error).message
}

export interface DelegationGrantDialogProps {
  /** Preselect (and lock) the head office. */
  headOfficeId?: string
  /** Preselect (and lock) one company; absent = the whole head office. */
  companyId?: string
  onDone: () => void
  onClose?: () => void
}

export function DelegationGrantDialog({ headOfficeId, companyId, onDone, onClose }: DelegationGrantDialogProps) {
  const qc = useQueryClient()
  const { data: offices = [] } = useHeadOffices()
  const { data: catalog = [] } = useQuery({
    queryKey: APPROVALS_CATALOG_KEY,
    queryFn: async () => (await api.get<{ sections: CatalogSection[] }>('/approvals/catalog')).sections,
  })
  const [ho, setHo] = useState(headOfficeId ?? '')
  const [scope, setScope] = useState<string>(companyId ?? '') // '' = whole head office
  const [section, setSection] = useState('')
  const [types, setTypes] = useState<string[]>([])
  const [person, setPerson] = useState('')
  const [endsAt, setEndsAt] = useState('')
  const [note, setNote] = useState('')
  const [err, setErr] = useState<string | null>(null)

  const hoId = headOfficeId ?? ho
  const office = offices.find((o) => o.id === hoId)
  const sections = catalog.filter((s) => s.delegable)
  const sec = sections.find((s) => s.id === section)

  const { data: eligible = [] } = useQuery({
    queryKey: [APPROVALS_ROOT, 'eligible', hoId, section],
    queryFn: async () => (await api.get<{ delegates: EligibleDelegate[] }>(
      `/approvals/delegations/eligible?headOfficeId=${encodeURIComponent(hoId)}&section=${encodeURIComponent(section)}`)).delegates,
    enabled: !!hoId && !!section,
  })

  const chosen = useMemo(() => eligible.find((d) => d.id === person), [eligible, person])
  const wholeHo = !scope
  const lacks = chosen?.lacks ?? []
  // The API refuses the WHOLE grant (422 DELEGATE_LACKS_MODULE) if any handed
  // type needs a module the person lacks; with nothing ticked every enabled
  // type counts. So those types can't be ticked, and something must be.
  const needsPick = lacks.length > 0 && types.length === 0

  function pickSection(id: string) { setSection(id); setTypes([]); setPerson('') }
  function pickPerson(id: string) {
    setPerson(id)
    const l = eligible.find((d) => d.id === id)?.lacks ?? []
    if (l.length) setTypes((cur) => cur.filter((t) => !l.includes(t)))
  }
  function toggle(t: string) { setTypes((cur) => cur.includes(t) ? cur.filter((x) => x !== t) : [...cur, t]) }

  const grant = useMutation({
    mutationFn: () => api.post('/approvals/delegations', {
      headOfficeId: hoId,
      companyTenantId: scope || null,
      section,
      ...(types.length ? { approvalTypes: types } : {}),
      delegateUserId: person,
      endsAt: endsAt ? new Date(`${endsAt}T23:59:59`).toISOString() : null,
      note: note.trim(),
    }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: [APPROVALS_ROOT] }); onDone() },
    onError: (e: Error) => setErr(errorText(e)),
  })

  const ready = !!hoId && !!section && !!person && !needsPick && note.trim().length >= 3 && !grant.isPending

  return (
    <Modal title="Hand over approvals" onClose={onClose ?? onDone}>
      <div className="space-y-3 text-sm">
        {!headOfficeId && (
          <div>
            <label className="text-[11px] font-bold text-white/60">Head office</label>
            <Select value={ho} onChange={(e) => { setHo(e.target.value); setScope(''); setPerson('') }}
              className="mt-1 w-full rounded-lg px-2 py-1.5" style={field}>
              <option value="">Choose a head office</option>
              {offices.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
            </Select>
          </div>
        )}
        <div>
          <label className="text-[11px] font-bold text-white/60">Covers</label>
          <Select value={scope} disabled={!!companyId} onChange={(e) => {
            const next = e.target.value
            setScope(next)
            // A type the whole head office must hold (ho_recharge) cannot go to one company.
            if (next && sec) {
              const hoOnly = new Set(sec.types.filter((t) => t.hoWideOnly).map((t) => t.type))
              setTypes((cur) => cur.filter((t) => !hoOnly.has(t)))
            }
          }}
            className="mt-1 w-full rounded-lg px-2 py-1.5" style={field}>
            <option value="">The whole head office and every company it serves</option>
            {(office?.companies ?? []).map((c) => <option key={c.id} value={c.id}>Only {c.name}</option>)}
            {companyId && !(office?.companies ?? []).some((c) => c.id === companyId) && <option value={companyId}>This company</option>}
          </Select>
        </div>
        <div>
          <label className="text-[11px] font-bold text-white/60">Section</label>
          <Select value={section} onChange={(e) => pickSection(e.target.value)}
            className="mt-1 w-full rounded-lg px-2 py-1.5" style={field}>
            <option value="">Choose a section</option>
            {sections.map((s) => <option key={s.id} value={s.id}>{s.title}{s.notYet ? ` (${WAITING.toLowerCase()})` : ''}</option>)}
          </Select>
        </div>
        {sec && (
          <div>
            <label className="text-[11px] font-bold text-white/60">Approval types (none ticked = every type in the section)</label>
            <div className="mt-1 space-y-1.5">
              {sec.types.map((t) => {
                const lacking = lacks.includes(t.type)
                const blocked = !t.enabled || (t.hoWideOnly && !wholeHo) || lacking
                return (
                  <label key={t.type} className="flex items-start gap-2 text-xs text-white/75" style={{ opacity: blocked ? 0.55 : 1 }}>
                    <input type="checkbox" className="mt-0.5" disabled={blocked} checked={types.includes(t.type)} onChange={() => toggle(t.type)} />
                    <span>
                      {t.label}
                      {!t.enabled && <em className="ml-1 not-italic" style={{ color: 'var(--erp-warning)' }}>{WAITING}</em>}
                      {t.enabled && t.hoWideOnly && !wholeHo && <em className="ml-1 not-italic text-white/45">whole head office only</em>}
                      {t.enabled && lacking && <em className="ml-1 not-italic" style={{ color: 'var(--erp-warning)' }}>this person needs the module first</em>}
                      {t.note && <span className="ml-1 text-white/45">{t.note}</span>}
                    </span>
                  </label>
                )
              })}
            </div>
          </div>
        )}
        <div>
          <label className="text-[11px] font-bold text-white/60">Person</label>
          <Select value={person} disabled={!hoId || !section} onChange={(e) => pickPerson(e.target.value)}
            className="mt-1 w-full rounded-lg px-2 py-1.5" style={field}>
            <option value="">{hoId && section ? 'Choose a person' : 'Pick a head office and section first'}</option>
            {eligible.map((d) => <option key={d.id} value={d.id}>{d.name ?? d.id} ({d.role})</option>)}
          </Select>
          {lacks.length > 0 && (
            <p className="mt-1 text-[11px]" style={{ color: 'var(--erp-warning)' }}>
              This person needs the module for {lacks.length} type{lacks.length === 1 ? '' : 's'} before {lacks.length === 1 ? 'it' : 'they'} can be handed to them.
              Tick the types to hand over (at least one), or give them the module in Module Access first.
            </p>
          )}
        </div>
        <div>
          <label className="text-[11px] font-bold text-white/60">Until (leave empty for no end date)</label>
          <input type="date" value={endsAt} onChange={(e) => setEndsAt(e.target.value)}
            min={new Date(Date.now() + 86_400_000).toISOString().slice(0, 10)}
            className="mt-1 w-full rounded-lg px-2 py-1.5" style={field} />
        </div>
        <div>
          <label className="text-[11px] font-bold text-white/60">Note (why, for the record)</label>
          <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2}
            className="mt-1 w-full rounded-lg px-2 py-1.5" style={field} />
        </div>
        {err && <p className="text-xs" style={{ color: err.startsWith(WAITING) ? 'var(--erp-warning)' : 'var(--erp-danger)' }}>{err}</p>}
        <div className="flex gap-2 pt-1">
          <button disabled={!ready} onClick={() => grant.mutate()}
            className="rounded-lg px-3 py-1.5 text-xs font-black disabled:opacity-50"
            style={{ background: 'var(--erp-primary)', color: 'var(--erp-on-primary)' }}>Hand over</button>
          <button onClick={onClose ?? onDone} className="text-xs font-bold text-white/50 px-2">Cancel</button>
        </div>
      </div>
    </Modal>
  )
}

export interface DelegationRevokeDialogProps {
  delegationId: string
  /** Shown in the title, e.g. "Finance to Sara". */
  label?: string
  headOfficeId?: string
  companyId?: string
  onDone: () => void
  onClose?: () => void
}

export function DelegationRevokeDialog({ delegationId, label, onDone, onClose }: DelegationRevokeDialogProps) {
  const qc = useQueryClient()
  const [reason, setReason] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const revoke = useMutation({
    mutationFn: () => api.post(`/approvals/delegations/${delegationId}/revoke`, { reason: reason.trim() }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: [APPROVALS_ROOT] }); onDone() },
    onError: (e: Error) => setErr(e.message),
  })
  return (
    <Modal title={label ? `Take back: ${label}` : 'Take back this hand-over'} onClose={onClose ?? onDone}>
      <p className="text-xs text-white/55">Their access ends at once. Items already waiting come back to you.</p>
      <label className="mt-3 block text-[11px] font-bold text-white/60">Reason</label>
      <textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={2}
        className="mt-1 w-full rounded-lg px-2 py-1.5 text-sm" style={field} />
      {err && <p className="mt-2 text-xs" style={{ color: 'var(--erp-danger)' }}>{err}</p>}
      <div className="mt-3 flex gap-2">
        <button disabled={reason.trim().length < 3 || revoke.isPending} onClick={() => revoke.mutate()}
          className="rounded-lg px-3 py-1.5 text-xs font-black disabled:opacity-50"
          style={{ background: 'var(--erp-danger)', color: 'var(--erp-on-secondary)' }}>Take back</button>
        <button onClick={onClose ?? onDone} className="text-xs font-bold text-white/50 px-2">Cancel</button>
      </div>
    </Modal>
  )
}
