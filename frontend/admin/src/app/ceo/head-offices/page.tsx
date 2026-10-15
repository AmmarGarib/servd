'use client'
// CEO → Head offices (D1/D3 spec §10): each head office with its companies,
// split status and books status; "New head office"; and the setup wizard link.

import { useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useMutation, useQuery } from '@tanstack/react-query'
import { toast } from 'sonner'
import { headOfficeApi, booksStatus } from '../../../lib/headOfficeApi'
import { Modal, errText } from './[id]/CompaniesTab'

export default function HeadOfficesPage() {
  const router = useRouter()
  const q = useQuery({ queryKey: ['head-offices'], queryFn: headOfficeApi.list })
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState('')
  const create = useMutation({
    mutationFn: () => headOfficeApi.create({ name: name.trim() }),
    onSuccess: (r) => { toast.success('Head office created. Recharge stays off.'); router.push(`/ceo/head-offices/${r.headOffice.id}`) },
    onError: (e) => toast.error(errText(e)),
  })
  const rows = q.data?.headOffices ?? []
  const setupDone = rows.some((r) => r.setupAppliedAt)
  const card = { background: 'var(--surface)', border: '1px solid var(--border)' }
  return (
    <div className="p-4 sm:p-6 max-w-5xl mx-auto">
      <p className="text-[11px] font-bold uppercase tracking-wider text-success">CEO</p>
      <div className="flex items-center gap-3 flex-wrap">
        <h1 className="text-2xl font-black text-white/90">Head offices</h1>
        <div className="ml-auto flex gap-2">
          {!setupDone && <Link href="/ceo/head-offices/setup" className="s-btn-secondary text-xs">Set up head office from today&rsquo;s records</Link>}
          <button type="button" className="s-btn-primary text-xs" onClick={() => setCreating(true)}>New head office</button>
        </div>
      </div>
      <p className="text-sm text-white/50 mt-1 max-w-2xl">A head office carries shared staff and costs and recharges the companies it serves each month. Companies are managed in Onboarding.</p>

      <div className="mt-5 space-y-3">
        {q.isLoading && <p className="text-sm text-white/40">Loading…</p>}
        {!q.isLoading && rows.length === 0 && <p className="text-sm text-white/45">No head office yet.</p>}
        {rows.map((h) => {
          const st = booksStatus(h)
          return (
            <Link key={h.id} href={`/ceo/head-offices/${h.id}`} className="block rounded-2xl p-4 hover:opacity-95" style={card}>
              <div className="flex items-center gap-3 flex-wrap">
                <span className="text-base font-black text-white/90">{h.name}</span>
                {h.isTest && <span className="s-badge-muted">Test</span>}
                {!h.isActive && <span className="s-badge-muted">Switched off</span>}
                <span className={`ml-auto ${st.tone === 'green' ? 's-badge-green' : st.tone === 'purple' ? 's-badge-purple' : 's-badge-amber'}`}>{st.label}</span>
              </div>
              <p className="text-xs text-white/55 mt-1">
                {h.companies.length ? `Serves ${h.companies.map((c) => c.name).join(', ')}` : 'No company linked yet'}
              </p>
            </Link>
          )
        })}
      </div>
      {creating && (
        <Modal title="New head office" onClose={() => setCreating(false)}>
          <label className="block text-xs font-bold text-white/60 mb-1">Name</label>
          <input className="s-input w-full" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. GS Head Office" autoFocus />
          <p className="mt-2 text-[11px] text-white/45">It starts with its own chart of accounts and HR. Recharge is off until you confirm the accounts with your CA.</p>
          <div className="mt-4 flex justify-end gap-2">
            <button type="button" className="s-btn-secondary text-xs" onClick={() => setCreating(false)}>Cancel</button>
            <button type="button" className="s-btn-primary text-xs" disabled={name.trim().length < 2 || create.isPending} onClick={() => create.mutate()}>Create</button>
          </div>
        </Modal>
      )}
    </div>
  )
}
