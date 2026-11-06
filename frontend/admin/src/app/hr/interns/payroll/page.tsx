'use client'
// Intern stipend payroll — the list of runs on its own page (finance opens it from the Accounting module).

import Link from 'next/link'
import { HrShell } from '../../../../components/hr/HrShell'
import { StipendRuns } from '../../../../components/hr/interns/StipendRuns'

export default function InternPayrollPage() {
  return (
    <HrShell title="Intern stipend payroll" subtitle="Monthly stipends for paid interns — separate from employee payroll."
      actions={<Link href="/hr/interns" className="rounded-lg px-4 py-2 text-sm text-white/60 border border-white/10 hover:text-white">All interns</Link>}>
      <StipendRuns />
    </HrShell>
  )
}
