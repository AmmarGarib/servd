'use client'
// Head office → Companies: link a company (with the A12 extend / revoke answer
// for every head-office-wide hand-over) and end a link (last charged month +
// reason, A11).

import { useState, type ReactNode } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { toast } from 'sonner'
import { ApiError } from '../../../../lib/api'
import { Select } from '../../../../components/ui/Select'
import { Modal as SharedModal } from '../../../../components/ui/Modal'
import {
  headOfficeApi, monthLabel, monthRange, addMonthsTo, currentMonthPkt,
  type HeadOfficeDetail, type HeadOfficeLinkRow,
} from '../../../../lib/headOfficeApi'

export function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  return <SharedModal title={title} onClose={onClose}>{children}</SharedModal>
}

export function errText(e: unknown): string {
  if (e instanceof ApiError) {
    const d = e.details as { runs?: Array<{ period: string; status: string }> } | undefined
    const extra = d?.runs?.length ? ` (${d.runs.map((r) => `${monthLabel(r.period)} ${r.status}`).join(', ')})` : ''
    return `${e.message}${extra}`
  }
  return e instanceof Error ? e.message : 'Something went wrong'
}

type Answer = 'extend' | 'revoke'

function LinkDialog({ hoId, detail, onClose, onDone }: { hoId: string; detail: HeadOfficeDetail; onClose: () => void; onDone: () => void }) {
  const { data: mine } = useQuery({ queryKey: ['ho-my-companies'], queryFn: headOfficeApi.myCompanies })
  const liveIds = new Set(detail.links.filter((l) => l.live).map((l) => l.companyTenantId))
  const options = (mine ?? []).filter((t) => t.kind === 'company' && !liveIds.has(t.id))
  const [companyId, setCompanyId] = useState('')
  const [answers, setAnswers] = useState<Record<string, Answer | ''>>({})
  const wide = detail.hoWideDelegations
  const unanswered = wide.some((d) => !answers[d.id])
  const save = useMutation({
    mutationFn: () => headOfficeApi.link(hoId, {
      companyTenantId: companyId,
      extendDelegationIds: wide.filter((d) => answers[d.id] === 'extend').map((d) => d.id),
      revokeDelegationIds: wide.filter((d) => answers[d.id] === 'revoke').map((d) => d.id),
    }),
    onSuccess: (r) => { toast.success(`${r.companyName} linked. Confirm the accounts with your CA again before recharge.`); onDone() },
    onError: (e) => toast.error(errText(e)),
  })
  return (
    <Modal title="Link a company" onClose={onClose}>
      <label className="block text-xs font-bold text-white/60 mb-1">Company</label>
      <Select className="s-select w-full" value={companyId} onChange={(e) => setCompanyId(e.target.value)}>
        <option value="">Pick a company…</option>
        {options.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
      </Select>
      {wide.length > 0 && (
        <div className="mt-4">
          <p className="text-xs font-bold text-white/70">Hand-overs that cover the whole head office</p>
          <p className="text-[11px] text-white/45 mb-2">A new company joins the head office. For each hand-over, say whether it reaches the new company too or is withdrawn.</p>
          <ul className="space-y-2">
            {wide.map((d) => (
              <li key={d.id} className="rounded-xl p-3" style={{ border: '1px solid var(--border)' }}>
                <p className="text-xs font-bold text-white/80">{d.delegateName ?? 'A login'} <span className="font-normal text-white/45">· {d.section}{d.approvalTypes.length ? ` · ${d.approvalTypes.join(', ')}` : ''}</span></p>
                <div className="mt-1.5 flex gap-4 text-xs text-white/70">
                  {(['extend', 'revoke'] as const).map((a) => (
                    <label key={a} className="flex items-center gap-1.5">
                      <input type="radio" name={`d-${d.id}`} checked={answers[d.id] === a} onChange={() => setAnswers((s) => ({ ...s, [d.id]: a }))} />
                      {a === 'extend' ? 'Extend to the new company' : 'Revoke'}
                    </label>
                  ))}
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
      <p className="mt-3 text-[11px] text-white/45">Linking clears the CA confirmation and switches recharge off until you confirm again.</p>
      <div className="mt-4 flex justify-end gap-2">
        <button type="button" className="s-btn-secondary text-xs" onClick={onClose}>Cancel</button>
        <button type="button" className="s-btn-primary text-xs" disabled={!companyId || unanswered || save.isPending} onClick={() => save.mutate()}>
          {save.isPending ? 'Linking…' : 'Link company'}
        </button>
      </div>
    </Modal>
  )
}

function EndDialog({ hoId, link, onClose, onDone }: { hoId: string; link: HeadOfficeLinkRow; onClose: () => void; onDone: () => void }) {
  const now = currentMonthPkt()
  const months = monthRange(addMonthsTo(now, -6), 9)
  const [last, setLast] = useState(addMonthsTo(now, -1))
  const [reason, setReason] = useState('')
  const save = useMutation({
    mutationFn: () => headOfficeApi.endLink(hoId, link.companyTenantId, { reason: reason.trim(), lastChargedPeriod: last }),
    onSuccess: () => { toast.success(`${link.companyName} unlinked`); onDone() },
    onError: (e) => toast.error(errText(e)),
  })
  return (
    <Modal title={`End link with ${link.companyName}`} onClose={onClose}>
      <label className="block text-xs font-bold text-white/60 mb-1">Last charged month</label>
      <Select className="s-select w-full" value={last} onChange={(e) => setLast(e.target.value)}>
        {months.map((m) => <option key={m} value={m}>{monthLabel(m)}</option>)}
      </Select>
      <p className="mt-1 text-[11px] text-white/45">The company is charged up to and including this month. A run for a later month blocks this.</p>
      <label className="block text-xs font-bold text-white/60 mt-3 mb-1">Reason</label>
      <textarea className="s-input w-full" rows={3} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why is this company leaving the head office?" />
      <p className="mt-2 text-[11px] text-white/45">Hand-overs for this company end, a new split without it is made when needed, and recharge is switched off until the accounts are confirmed again.</p>
      <div className="mt-4 flex justify-end gap-2">
        <button type="button" className="s-btn-secondary text-xs" onClick={onClose}>Cancel</button>
        <button type="button" className="s-btn-danger text-xs" disabled={reason.trim().length < 3 || save.isPending} onClick={() => save.mutate()}>
          {save.isPending ? 'Ending…' : 'End link'}
        </button>
      </div>
    </Modal>
  )
}

export default function CompaniesTab({ hoId, detail, reload }: { hoId: string; detail: HeadOfficeDetail; reload: () => void }) {
  const [linking, setLinking] = useState(false)
  const [ending, setEnding] = useState<HeadOfficeLinkRow | null>(null)
  const live = detail.links.filter((l) => l.live)
  const ended = detail.links.filter((l) => !l.live)
  return (
    <div>
      <div className="flex items-center justify-between gap-3 mb-3">
        <p className="text-sm text-white/60">Companies this head office serves and recharges.</p>
        <button type="button" className="s-btn-primary text-xs" onClick={() => setLinking(true)}>Link a company</button>
      </div>
      <div className="rounded-2xl overflow-x-auto" style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}>
        <table className="s-table">
          <thead><tr><th>Company</th><th>Since</th><th>Charges account</th><th /></tr></thead>
          <tbody>
            {live.length === 0 && <tr><td colSpan={4} className="text-white/45">No company is linked yet.</td></tr>}
            {live.map((l) => (
              <tr key={l.id}>
                <td className="font-semibold">{l.companyName}{l.companyIsTest && <span className="s-badge-muted ml-2">Test</span>}</td>
                <td>{new Date(l.startedAt).toLocaleDateString('en-GB')}</td>
                <td>{l.chargesAccount ? `${l.chargesAccount.code} ${l.chargesAccount.name}` : '—'}</td>
                <td className="text-right"><button type="button" className="s-btn-secondary text-xs" onClick={() => setEnding(l)}>End link</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {ended.length > 0 && (
        <div className="mt-5">
          <p className="text-xs font-bold uppercase tracking-wider text-white/45 mb-2">Ended links</p>
          <ul className="space-y-1 text-xs text-white/60">
            {ended.map((l) => (
              <li key={l.id}>{l.companyName}: last charged {monthLabel(l.lastChargedPeriod)}{l.endReason ? `, ${l.endReason}` : ''}</li>
            ))}
          </ul>
        </div>
      )}
      {linking && <LinkDialog hoId={hoId} detail={detail} onClose={() => setLinking(false)} onDone={() => { setLinking(false); reload() }} />}
      {ending && <EndDialog hoId={hoId} link={ending} onClose={() => setEnding(null)} onDone={() => { setEnding(null); reload() }} />}
    </div>
  )
}
