'use client'
// HR → Interns (owner, 2026-11-06): a separate register from employees — dashboard, register, attendance, stipend
// payroll and reports. The active tab lives in the URL (?tab=), so Back and shared links restore it.

import { Suspense } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { HrShell, useHrAccess } from '../../../components/hr/HrShell'
import { btn } from '../../../lib/hr'
import { InternDashboard } from '../../../components/hr/interns/Dashboard'
import { InternRegister } from '../../../components/hr/interns/Register'
import { AttendanceTab } from '../../../components/hr/interns/AttendanceTab'
import { StipendRuns } from '../../../components/hr/interns/StipendRuns'
import { InternReports } from '../../../components/hr/interns/Reports'
import { Tabs } from '../../../components/hr/interns/ui'

const TABS = [['dashboard', 'Dashboard'], ['register', 'Register'], ['attendance', 'Attendance'], ['payroll', 'Stipend payroll'], ['reports', 'Reports']] as const
type Tab = (typeof TABS)[number][0]

export default function InternsPage() {
  // useSearchParams needs a Suspense boundary in a statically built page.
  return <Suspense fallback={null}><Interns /></Suspense>
}

function Interns() {
  const router = useRouter()
  const sp = useSearchParams()
  const { isHrAdmin } = useHrAccess()
  const asked = sp.get('tab')
  // Finance (no HR role) reads the stipend payroll only; the API refuses the rest.
  const tabs = isHrAdmin ? TABS : TABS.filter(([k]) => k === 'payroll')
  const tab: Tab = (tabs.find(([k]) => k === asked)?.[0]) ?? tabs[0]![0]
  const go = (t: Tab) => router.replace(`/hr/interns?tab=${t}`, { scroll: false })
  const enroll = () => router.push('/hr/interns/new')
  return (
    <HrShell title="Interns" subtitle="Interns are a separate register from employees: their own attendance, stipends and certificates."
      actions={isHrAdmin ? <button type="button" className={btn} onClick={enroll}>+ Enroll intern</button> : undefined}>
      <Tabs tabs={tabs} value={tab} onChange={go} label="Intern management" />
      {tab === 'dashboard' && <InternDashboard onEnroll={enroll} />}
      {tab === 'register' && <InternRegister key={sp.get('status') ?? ''} initialStatus={sp.get('status') ?? ''} onEnroll={enroll} />}
      {tab === 'attendance' && <AttendanceTab />}
      {tab === 'payroll' && <StipendRuns />}
      {tab === 'reports' && <InternReports />}
    </HrShell>
  )
}
