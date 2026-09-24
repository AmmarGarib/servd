'use client'
// Every section's format, and whether HR has replaced the default yet.

import Link from 'next/link'
import { card } from '../../../lib/hr'
import { HrShell, useHrSections } from '../../../components/hr/HrShell'

export default function FormatsPage() {
  const { data: sections = [] } = useHrSections()
  const editable = sections.filter((s) => s.format)
  const done = editable.filter((s) => !s.format!.isDefault).length
  return (
    <HrShell title="Formats" subtitle={`The field list behind each section. Replace the defaults with your HR team's formats — ${done} of ${editable.length} done so far. Every save is a new version; old records keep the version they were captured with.`}>
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {editable.sort((a, b) => a.specNo - b.specNo).map((s) => (
          <Link key={s.key} href={`/hr/formats/${s.key}`} className="rounded-xl p-3 hover:bg-white/[0.05]" style={card}>
            <div className="flex justify-between gap-2">
              <p className="text-sm font-bold text-white/85">{s.title}</p>
              <span className="text-[10px] font-black text-white/30">§{s.specNo}</span>
            </div>
            <p className="text-[11px] mt-0.5" style={{ color: s.format!.isDefault ? 'rgba(255,255,255,0.4)' : '#00D4B1' }}>
              {s.format!.isDefault ? 'Default format' : `HR format v${s.format!.version}`} · {s.format!.fields.length} fields
            </p>
          </Link>
        ))}
      </div>
    </HrShell>
  )
}
