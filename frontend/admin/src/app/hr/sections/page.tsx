'use client'
// Every section of the HR team's spec, by its spec number, and where it lives.

import Link from 'next/link'
import { card } from '../../../lib/hr'
import { HrShell, useHrSections } from '../../../components/hr/HrShell'

const PAGE_HREF: Record<string, string> = {
  dashboard: '/dashboard/hr', org: '/hr/org', employees: '/hr/employees', documents: '/hr/documents',
  payroll: '/hr/payroll', letters: '/hr/letters', ess: '/hr/me', manager: '/ceo/approvals?type=hr_request', reports: '/hr/reports',
}

export default function HrSectionsPage() {
  const { data: sections = [] } = useHrSections()
  const groups = Array.from(new Set(sections.map((s) => s.group)))
  return (
    <HrShell title="All sections" subtitle="Everything in the HR module spec, numbered as in the spec. Each record section uses a format your HR team can change in Formats.">
      <div className="space-y-6">
        {groups.map((g) => (
          <div key={g}>
            <p className="text-[11px] font-black uppercase tracking-wider text-white/40 mb-2">{g}</p>
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {sections.filter((s) => s.group === g).sort((a, b) => a.specNo - b.specNo).map((s) => (
                <Link key={s.key} href={PAGE_HREF[s.key] ?? `/hr/s/${s.key}`} className="rounded-xl p-3 hover:bg-white/[0.05] transition-colors" style={card}>
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-sm font-bold text-white/85">{s.title}</p>
                    <span className="text-[10px] font-black text-white/30">§{s.specNo}</span>
                  </div>
                  {s.movedTo && (
                    <span className="s-badge-purple mt-1 text-[10px]" title={s.movedTo.message}>
                      Moved to {s.movedTo.label}
                    </span>
                  )}
                  <p className="text-[11px] text-white/40 mt-0.5">
                    {s.kind === 'page' ? 'Screen' : s.config ? 'Setup list' : 'Records'}
                    {s.format && !s.format.isDefault && <span className="text-primary-ink"> · HR format v{s.format.version}</span>}
                    {s.format?.workflow?.length ? ` · ${s.format.workflow.length}-step approval` : ''}
                  </p>
                </Link>
              ))}
            </div>
          </div>
        ))}
      </div>
    </HrShell>
  )
}
