'use client'
// HR → Interns → Enroll intern.

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { HrShell } from '../../../../components/hr/HrShell'
import { InternForm } from '../../../../components/hr/interns/InternForm'

export default function NewInternPage() {
  const router = useRouter()
  return (
    <HrShell title="Enroll intern" subtitle="Interns are a separate register from employees — their own attendance, stipend and certificate."
      actions={<Link href="/hr/interns?tab=register" className="rounded-lg px-4 py-2 text-sm text-white/60 border border-white/10 hover:text-white">Back to register</Link>}>
      <div className="max-w-4xl">
        <InternForm mode="create" onSaved={(i) => router.push(`/hr/interns/${i.id}`)} onCancel={() => router.push('/hr/interns?tab=register')} />
      </div>
    </HrShell>
  )
}
