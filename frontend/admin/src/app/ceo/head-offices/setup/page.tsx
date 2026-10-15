'use client'
// CEO → Head offices → Set up from today's records (D1/D3 spec §14.3). Preview
// first (people, seats, the suggested split, planning before and after), tick
// any HODs to add as members, then apply. Recharge stays off.

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useMutation, useQuery } from '@tanstack/react-query'
import { toast } from 'sonner'
import { ApiError } from '../../../../lib/api'
import { fmtPkr } from '../../../../lib/money'
import { headOfficeApi, bpsToPct, pctToBps, monthLabel, type PlanningRow } from '../../../../lib/headOfficeApi'

const card = { background: 'var(--surface)', border: '1px solid var(--border)' }

function PlanTable({ title, rows }: { title: string; rows: PlanningRow[] }) {
  return (
    <div className="rounded-2xl overflow-x-auto" style={card}>
      <p className="px-4 pt-3 text-xs font-bold uppercase tracking-wider text-white/45">{title}</p>
      <table className="s-table">
        <thead><tr><th>Company</th><th className="text-right">Seats</th><th className="text-right">Head office charges</th><th className="text-right">Net a month</th></tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.tenantId}>
              <td className="font-semibold">{r.name}</td>
              <td className="text-right">{fmtPkr(r.seatsMonthlyCents)}</td>
              <td className="text-right">{fmtPkr(r.headOfficeChargesMonthlyCents - r.rechargedOutMonthlyCents)}</td>
              <td className="text-right">{fmtPkr(r.netMonthlyCents)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export default function HeadOfficeSetupPage() {
  const router = useRouter()
  const q = useQuery({ queryKey: ['ho-setup-preview'], queryFn: () => headOfficeApi.setupPreview() })
  const [pct, setPct] = useState<Record<string, string>>({})
  const [hods, setHods] = useState<Set<string>>(new Set())
  const [done409, setDone409] = useState(false)
  const p = q.data

  useEffect(() => {
    if (p && Object.keys(pct).length === 0) {
      setPct(Object.fromEntries(p.suggestedSplit.lines.map((l) => [l.companyTenantId, bpsToPct(l.shareBps)])))
    }
  }, [p, pct])

  const lines = (p?.suggestedSplit.lines ?? []).map((l) => ({ companyTenantId: l.companyTenantId, shareBps: pctToBps(pct[l.companyTenantId] ?? '0') }))
  const total = lines.reduce((a, l) => a + l.shareBps, 0)
  const apply = useMutation({
    mutationFn: () => headOfficeApi.setupApply({
      split: lines.filter((l) => l.shareBps > 0),
      addHodMemberships: [...hods],
    }),
    onSuccess: (r) => { toast.success('Head office set up. Recharge is off until the CA confirms.'); router.push(`/ceo/head-offices/${r.headOffice.id}`) },
    onError: (e) => {
      if (e instanceof ApiError && e.code === 'SETUP_ALREADY_DONE') setDone409(true)
      else toast.error(e instanceof Error ? e.message : 'Could not set up')
    },
  })

  return (
    <div className="p-4 sm:p-6 max-w-5xl mx-auto">
      <Link href="/ceo/head-offices" className="text-xs font-bold hover:underline" style={{ color: 'var(--erp-primary-ink)' }}>Head offices</Link>
      <h1 className="text-2xl font-black text-white/90 mt-1">Set up head office from today&rsquo;s records</h1>
      <p className="text-sm text-white/50 mt-1 max-w-2xl">Preview what would move. Nothing changes until you apply, and recharge stays off.</p>

      {(done409 || p?.alreadyApplied) && (
        <div className="mt-4 rounded-xl p-3 text-sm" style={{ background: '#f6e2bf', color: '#a15c00' }}>
          The head office has already been set up from today&rsquo;s records
          {p?.alreadyApplied ? ` (${p.alreadyApplied.name})` : ''}. It can only be done once.{' '}
          {p?.alreadyApplied && <Link href={`/ceo/head-offices/${p.alreadyApplied.headOfficeId}`} className="font-bold underline">Open it</Link>}
        </div>
      )}
      {q.isLoading && <p className="mt-4 text-sm text-white/40">Loading…</p>}
      {q.error && <p className="mt-4 text-sm text-red-600">Could not load the preview.</p>}

      {p && (
        <div className="mt-5 space-y-5">
          {p.warnings.length > 0 && <ul className="rounded-xl p-3 text-xs space-y-1" style={{ background: '#f6e2bf', color: '#a15c00' }}>{p.warnings.map((w) => <li key={w}>{w}</li>)}</ul>}

          <section className="rounded-2xl p-4" style={card}>
            <h2 className="text-sm font-black text-white/85">{p.hoName} will serve</h2>
            <p className="text-xs text-white/55 mt-1">{p.companies.map((c) => c.name).join(', ') || 'No company'}. The first split starts {monthLabel(p.effectiveFrom)}.</p>
          </section>

          <section className="rounded-2xl p-4" style={card}>
            <h2 className="text-sm font-black text-white/85">Suggested split</h2>
            <p className="text-[11px] text-white/45 mb-3">{p.suggestedSplit.note}</p>
            <div className="space-y-2">
              {p.suggestedSplit.lines.map((l) => (
                <div key={l.companyTenantId} className="flex items-center gap-3">
                  <span className="flex-1 text-sm text-white/80">{l.name}</span>
                  <input className="s-input w-24 text-right" inputMode="decimal" aria-label={`${l.name} share`} value={pct[l.companyTenantId] ?? ''}
                    onChange={(e) => setPct((s) => ({ ...s, [l.companyTenantId]: e.target.value }))} />
                  <span className="text-xs text-white/50">%</span>
                </div>
              ))}
            </div>
            <p className={`mt-2 text-xs font-bold ${total > 10000 ? 'text-red-600' : 'text-white/70'}`}>Total {bpsToPct(total)}%</p>
          </section>

          <section className="rounded-2xl p-4" style={card}>
            <h2 className="text-sm font-black text-white/85">People and seats that move</h2>
            {p.departments.length === 0 && <p className="text-xs text-white/45 mt-1">No head-office department found.</p>}
            {p.departments.map((d) => (
              <div key={d.id} className="mt-3">
                <p className="text-xs font-bold text-white/75">{d.name} <span className="font-normal text-white/45">({d.companyName})</span></p>
                <ul className="mt-1 text-xs text-white/65 space-y-0.5">
                  {d.seats.map((s) => <li key={s.id}>Seat: {s.title}{s.headcount > 1 ? ` x${s.headcount}` : ''} · {fmtPkr(s.monthlySalaryCents)} a month · {s.status}</li>)}
                  {d.employees.map((e) => <li key={e.id}>{e.fullName} ({e.employeeCode})</li>)}
                </ul>
              </div>
            ))}
            {p.contributions.length > 0 && (
              <div className="mt-3">
                <p className="text-xs font-bold text-white/75">Old head-office contributions that end</p>
                <ul className="mt-1 text-xs text-white/65 space-y-0.5">
                  {p.contributions.map((c) => <li key={c.id}>{c.label}: {c.sourceName} to {c.destinationName}, {fmtPkr(c.monthlyCents)} a month</li>)}
                </ul>
              </div>
            )}
          </section>

          <div className="grid gap-4 md:grid-cols-2">
            <PlanTable title="Planning before" rows={p.planning.before.companies} />
            <PlanTable title="Planning after" rows={[...p.planning.after.companies, p.planning.after.headOffice]} />
          </div>

          {p.hodCandidates.length > 0 && (
            <section className="rounded-2xl p-4" style={card}>
              <h2 className="text-sm font-black text-white/85">Add as head office members now (optional)</h2>
              <p className="text-[11px] text-white/45 mb-2">Their payroll moves later, at the CA&rsquo;s cutover month, with &ldquo;Move people to head office&rdquo;.</p>
              {p.hodCandidates.map((u) => (
                <label key={u.userId} className="flex items-center gap-2 text-sm text-white/80 py-0.5">
                  <input type="checkbox" checked={hods.has(u.userId)} onChange={(e) => setHods((s) => { const n = new Set(s); if (e.target.checked) n.add(u.userId); else n.delete(u.userId); return n })} />
                  {u.name} {u.email && <span className="text-xs text-white/45">{u.email}</span>}
                </label>
              ))}
            </section>
          )}

          <div className="flex justify-end">
            <button type="button" className="s-btn-primary text-sm" disabled={apply.isPending || total === 0 || total > 10000 || !!p.alreadyApplied || done409} onClick={() => apply.mutate()}>
              {apply.isPending ? 'Setting up…' : 'Set up head office'}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
