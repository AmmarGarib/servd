'use client'
// My HR → My interns: the interns whose supervisor is the signed-in person (GET /hr/my-interns). Never stipend or CNIC.

import Link from 'next/link'
import { useQuery } from '@tanstack/react-query'
import { api } from '../../../../lib/api'
import { card } from '../../../../lib/hr'
import { INTERN_BADGE, shortDate, type SupervisedIntern } from '../../../../lib/interns'
import { HrShell } from '../../../../components/hr/HrShell'
import { Badge, LoadState } from '../../../../components/hr/interns/ui'

export default function MyInternsPage() {
  const { data, error, isLoading, refetch } = useQuery({ queryKey: ['my-interns'], queryFn: () => api.get<{ items: SupervisedIntern[] }>('/hr/my-interns'), retry: false })
  const items = data?.items ?? []
  return (
    <HrShell title="My interns" subtitle="Interns you supervise — mark their attendance and keep performance remarks."
      actions={<Link href="/hr/me" className="rounded-lg px-4 py-2 text-sm text-white/60 border border-white/10 hover:text-white">My HR</Link>}>
      <LoadState loading={isLoading} error={error} onRetry={() => void refetch()} />
      {data && items.length === 0 && <div className="rounded-2xl p-8 text-center text-sm text-white/60" style={card}>No interns are assigned to you right now.</div>}
      <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {items.map((i) => (
          <li key={i.id}>
            <Link href={`/hr/me/interns/${i.id}`} className="block rounded-2xl p-4 hover:opacity-90 h-full" style={card}>
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="font-black text-white/90 break-words">{i.fullName}</p>
                  <p className="text-xs text-white/55">{i.internCode}{i.department ? ` · ${i.department}` : ''}</p>
                </div>
                <Badge cls={INTERN_BADGE[i.status] ?? 's-badge-muted'}>{i.statusLabel}</Badge>
              </div>
              <p className="text-xs text-white/65 mt-2">{i.designation ?? 'Intern'} · {shortDate(i.startDate)} – {i.lastDay ? shortDate(i.lastDay) : 'open'}</p>
              {i.institution && <p className="text-xs text-white/55 mt-0.5 break-words">{i.institution}</p>}
            </Link>
          </li>
        ))}
      </ul>
    </HrShell>
  )
}
