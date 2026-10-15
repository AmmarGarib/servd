'use client'
// Head office home (D3, spec §10). Always open — the API scopes what each
// login can read, and every part answers for itself: a login that cannot read
// a section's numbers simply does not see that section. Nothing here changes
// anything; changes are sent for approval from the module pages.

import Link from 'next/link'
import { useQuery } from '@tanstack/react-query'
import { useHeadOfficeMe, type MyHeadOffice, type ReachEntry, type MyDelegation } from '../../hooks/useWorkspaces'
import { usePermissions } from '../../hooks/useCan'
import { useLens } from '../../hooks/useLens'
import { headOfficeApi, bpsToPct, currentMonthPkt, addMonthsTo, monthLabel, type PairBalance } from '../../lib/headOfficeApi'
import { fmtPkrWhole } from '../../lib/money'

const SECTION_LABEL: Record<string, string> = {
  procurement: 'Procurement', hr: 'HR', finance: 'Finance', marketing: 'Marketing', operations: 'Operations',
}
const sectionLabel = (s: string): string => SECTION_LABEL[s] ?? s.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase())

function dateText(iso: string | null): string {
  if (!iso) return 'further notice'
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? 'further notice' : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
}

const RUN_BADGE: Record<string, string> = { posted: 's-badge-green', approved: 's-badge-green', submitted: 's-badge-amber', draft: 's-badge-muted' }

export default function HeadOfficeHome() {
  const { headOffices, reach, delegations, loaded } = useHeadOfficeMe()
  const { data: me } = usePermissions()
  const isCeo = me?.role === 'admin'

  return (
    <div className="p-4 sm:p-6 max-w-5xl mx-auto space-y-6">
      <header>
        <p className="text-[11px] font-black uppercase tracking-wider text-success">Head office</p>
        <h1 className="text-2xl font-black text-white/90 mt-1">Head office</h1>
        <p className="text-sm text-white/50 mt-1">The companies you serve, how the cost is shared, and what has been handed to you. You can look, and send changes for approval.</p>
      </header>

      {!loaded && <p className="text-sm text-white/40">Loading…</p>}

      {delegations.length > 0 && <HandedToYou rows={delegations} />}

      {loaded && headOffices.length === 0 && reach.length === 0 && delegations.length === 0 && (
        <div className="s-card p-5">
          <p className="text-sm font-bold text-white/80">No head office is linked to your login yet.</p>
          <p className="text-xs text-white/50 mt-1">When the CEO links a head office and adds you to it, the companies you serve appear here.</p>
        </div>
      )}

      {headOffices.map((ho) => <HeadOfficeBlock key={ho.id} ho={ho} reach={reach} isCeo={isCeo} />)}

      {headOffices.length === 0 && reach.length > 0 && <ServedList companies={reach.map((r) => ({ id: r.companyId, name: r.name }))} />}

      <Links isCeo={isCeo} hoIds={headOffices.map((h) => h.id)} />
    </div>
  )
}

function HandedToYou({ rows }: { rows: MyDelegation[] }) {
  return (
    <section className="s-card p-5">
      <h2 className="text-sm font-black text-white/85">Handed to you</h2>
      <ul className="mt-2 space-y-1.5">
        {rows.map((d) => (
          <li key={d.id} className="text-sm text-white/75">
            Handed to you by the CEO: <strong>{sectionLabel(d.section)}</strong> for <strong>{d.scopeName || 'your companies'}</strong> until <strong>{dateText(d.endsAt)}</strong>
          </li>
        ))}
      </ul>
      <Link href="/ceo/approvals" className="inline-block mt-3 text-xs font-bold hover:underline" style={{ color: 'var(--erp-primary-ink)' }}>Open approvals</Link>
    </section>
  )
}

function ServedList({ companies }: { companies: Array<{ id: string; name: string }> }) {
  const { lensId, setLens } = useLens()
  return (
    <section className="s-card p-5">
      <h2 className="text-sm font-black text-white/85">Companies you serve</h2>
      {companies.length === 0 ? <p className="text-xs text-white/45 mt-2">None linked yet.</p> : (
        <ul className="mt-2 divide-y" style={{ borderColor: 'var(--border)' }}>
          {companies.map((c) => (
            <li key={c.id} className="flex items-center gap-3 py-2">
              <span className="flex-1 min-w-0 text-sm font-bold text-white/85 truncate">{c.name}</span>
              {lensId === c.id
                ? <span className="s-badge-green">Viewing</span>
                : <button type="button" onClick={() => setLens(c.id)} className="text-xs font-bold hover:underline" style={{ color: 'var(--erp-primary-ink)' }}>View</button>}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

function HeadOfficeBlock({ ho, reach, isCeo }: { ho: MyHeadOffice; reach: ReachEntry[]; isCeo: boolean }) {
  // Each read is allowed or refused by the API for THIS login; a refusal is
  // not an error to show (inlineErrors), the section just stays out.
  const detail = useQuery({ queryKey: ['head-office', ho.id], queryFn: () => headOfficeApi.detail(ho.id), enabled: isCeo, retry: false, meta: { inlineErrors: true } })
  const summary = useQuery({ queryKey: ['ho-home-summary', ho.id], queryFn: () => headOfficeApi.runsSummary(ho.id), retry: false, meta: { inlineErrors: true } })
  const runs = useQuery({ queryKey: ['ho-home-runs', ho.id], queryFn: () => headOfficeApi.runs(ho.id), retry: false, meta: { inlineErrors: true } })
  const balances = useQuery({ queryKey: ['ho-home-balances'], queryFn: () => headOfficeApi.balances(), retry: false, meta: { inlineErrors: true } })

  const served = (() => {
    const fromDetail = detail.data?.links.filter((l) => l.live).map((l) => ({ id: l.companyTenantId, name: l.companyName }))
    if (fromDetail && fromDetail.length > 0) return fromDetail
    const fromSummary = summary.data?.companies.filter((c) => !c.endedAt).map((c) => ({ id: c.companyTenantId, name: c.companyName }))
    if (fromSummary && fromSummary.length > 0) return fromSummary
    return reach.filter((r) => r.via.some((v) => v.id === ho.id)).map((r) => ({ id: r.companyId, name: r.name }))
  })()

  const lastMonth = summary.data?.lastMonth ?? addMonthsTo(currentMonthPkt(), -1)
  const lastRun = runs.data?.items?.find((r) => r.period === lastMonth)
  const books = summary.data?.books ?? null
  const shares = summary.data?.companies.filter((c) => !c.endedAt) ?? []
  const retainedBps = shares.length > 0 ? Math.max(0, 10000 - shares.reduce((n, c) => n + c.shareBps, 0)) : null
  const pairs: PairBalance[] = (balances.data?.pairs ?? []).filter((p) => p.headOfficePair && (p.a.id === ho.id || p.b.id === ho.id))

  return (
    <section className="space-y-4">
      <h2 className="text-lg font-black text-white/90">{ho.name}</h2>
      <ServedList companies={served} />

      {shares.length > 0 && (
        <div className="s-card p-5">
          <h3 className="text-sm font-black text-white/85">Shares</h3>
          <table className="s-table mt-2">
            <thead><tr><th>Company</th><th className="text-right">Share</th></tr></thead>
            <tbody>
              {shares.map((c) => <tr key={c.linkId}><td className="font-semibold">{c.companyName}</td><td className="text-right">{bpsToPct(c.shareBps)}%</td></tr>)}
              {retainedBps != null && retainedBps > 0 && <tr><td className="text-white/55">Kept by {ho.name}</td><td className="text-right">{bpsToPct(retainedBps)}%</td></tr>}
            </tbody>
          </table>
        </div>
      )}

      {(summary.data || runs.data) && (
        <div className="s-card p-5">
          <h3 className="text-sm font-black text-white/85">{monthLabel(lastMonth)} recharge</h3>
          <div className="mt-2 flex items-center gap-2 flex-wrap text-sm">
            {books && !books.rechargeEnabled
              ? <span className="s-badge-muted">Recharge is off</span>
              : lastRun
                ? <span className={RUN_BADGE[lastRun.status] ?? 's-badge-muted'}>{lastRun.status}</span>
                : <span className="s-badge-amber">Not run yet</span>}
            {lastRun && <span className="text-white/60">Recharged {fmtPkrWhole(lastRun.rechargedCents)} of {fmtPkrWhole(lastRun.baseCents)}</span>}
          </div>
        </div>
      )}

      {(pairs.length > 0 || shares.length > 0) && (
        <div className="s-card p-5">
          <h3 className="text-sm font-black text-white/85">Balances</h3>
          {pairs.length > 0 ? (
            <ul className="mt-2 space-y-1.5">
              {pairs.map((p, i) => {
                const net = p.netOwedByA
                const debtor = net != null && net < 0 ? p.b : p.a
                const creditor = net != null && net < 0 ? p.a : p.b
                return (
                  <li key={i} className="text-sm text-white/75 flex items-center gap-2 flex-wrap">
                    {net == null ? <span>{p.a.name} and {p.b.name}: not visible to your login</span>
                      : net === 0 ? <span>{p.a.name} and {p.b.name}: <span className="text-success font-bold">settled</span></span>
                      : <span>{debtor.name} owes {creditor.name} <strong>{fmtPkrWhole(Math.abs(net))}</strong></span>}
                    {p.mismatchCents != null && p.mismatchCents !== 0 && <span className="s-badge-red">Books differ by {fmtPkrWhole(p.mismatchCents)}</span>}
                  </li>
                )
              })}
            </ul>
          ) : (
            <ul className="mt-2 space-y-1.5">
              {shares.map((c) => (
                <li key={c.linkId} className="text-sm text-white/75">
                  {c.companyName} owes {ho.name} <strong>{fmtPkrWhole(c.owedByCompanyCents)}</strong>
                  {c.mismatchCents !== 0 && <span className="s-badge-red ml-2">Books differ by {fmtPkrWhole(c.mismatchCents)}</span>}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  )
}

function Links({ isCeo, hoIds }: { isCeo: boolean; hoIds: string[] }) {
  const links: Array<{ href: string; label: string }> = [
    { href: '/ceo/approvals', label: 'Approvals' },
    { href: '/accounting/intercompany', label: 'Inter-company' },
    ...(isCeo ? [{ href: '/ceo/head-offices', label: 'Head offices (setup)' }] : []),
    ...(isCeo ? hoIds.map((id) => ({ href: `/ceo/head-offices/${id}`, label: 'Hand-over and runs' })) : []),
  ]
  return (
    <section className="flex flex-wrap gap-2">
      {links.map((l) => (
        <Link key={l.href} href={l.href} className="rounded-xl px-3 py-1.5 text-xs font-bold"
          style={{ color: 'var(--erp-primary-ink)', border: '1px solid rgb(var(--erp-primary-rgb) / 0.35)' }}>{l.label}</Link>
      ))}
    </section>
  )
}
