'use client'
import { useState, useEffect } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useRouter, useParams } from 'next/navigation'
import Link from 'next/link'
import { formatDistanceToNowStrict } from 'date-fns'
import { api } from '../../../lib/api'
import { fmtPkr } from '../../../lib/money'

// ─── Min-wage constants ────────────────────────────────────────────────────────
const MIN_WAGE: Record<string, number> = {
  unskilled: 40_000,
  semi_skilled: 41_280,
  skilled: 48_910,
  highly_skilled: 50_868,
}

const ROLES = [
  'Head Chef', 'Sous Chef', 'CDP', 'Demi Chef', 'Commis',
  'Kitchen Helper', 'Dishwasher', 'Baker', 'Tandoor Grill Cook',
]
const SKILL_LEVELS = [
  { value: 'unskilled', label: 'Unskilled' },
  { value: 'semi_skilled', label: 'Semi-skilled' },
  { value: 'skilled', label: 'Skilled' },
  { value: 'highly_skilled', label: 'Highly Skilled' },
]
const EMPLOYMENT_TYPES = [
  { value: 'permanent', label: 'Permanent' },
  { value: 'probationary', label: 'Probationary' },
  { value: 'temporary', label: 'Temporary' },
  { value: 'contract', label: 'Contract' },
]

// ─── Types ─────────────────────────────────────────────────────────────────────

interface KitchenStaff {
  id: string
  fullName: string
  cnic: string | null
  phone: string | null
  emergencyContact: string | null
  role: string
  skillLevel: string
  employmentType: string
  dateJoined: string
  dateLeft: string | null
  monthlySalaryCents: number
  mealsProvided: boolean
  accommodationProvided: boolean
  accommodationValueCents: number
  eobiRegistered: boolean
  sessiRegistered: boolean
  bankAccount: string | null
  status: string
  complianceViolations: ComplianceViolation[]
}

interface ComplianceViolation {
  id: string
  type: string
  description: string
  detectedAt: string
  resolved: boolean
  resolvedAt: string | null
}

function LabeledField({ label, children, hint }: { label: string; children: React.ReactNode; hint?: string }) {
  return (
    <div className="space-y-1">
      <label className="text-xs font-semibold block" style={{ color: 'rgba(255,255,255,0.45)' }}>
        {label}
      </label>
      {children}
      {hint && <p className="text-[11px]" style={{ color: 'rgba(255,255,255,0.28)' }}>{hint}</p>}
    </div>
  )
}

// ─── Page ──────────────────────────────────────────────────────────────────────

export default function StaffDetailPage() {
  const router = useRouter()
  const params = useParams<{ id: string }>()
  const staffId = params.id
  const qc = useQueryClient()

  const [form, setForm] = useState({
    fullName: '',
    cnic: '',
    phone: '',
    emergencyContact: '',
    role: '',
    skillLevel: 'unskilled',
    employmentType: 'permanent',
    dateJoined: '',
    monthlySalary: '',
    mealsProvided: false,
    accommodationProvided: false,
    accommodationValueCents: '',
    eobiRegistered: false,
    sessiRegistered: false,
    bankAccount: '',
  })
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  const { data: staff, isLoading } = useQuery({
    queryKey: ['kitchen-staff-detail', staffId],
    queryFn: () => api.get<KitchenStaff>(`/kitchen-staff/staff/${staffId}`),
  })

  // Populate form once data loads
  useEffect(() => {
    if (!staff) return
    setForm({
      fullName: staff.fullName,
      cnic: staff.cnic ?? '',
      phone: staff.phone ?? '',
      emergencyContact: staff.emergencyContact ?? '',
      role: staff.role,
      skillLevel: staff.skillLevel,
      employmentType: staff.employmentType,
      dateJoined: staff.dateJoined?.slice(0, 10) ?? '',
      monthlySalary: String(Math.round(staff.monthlySalaryCents / 100)),
      mealsProvided: staff.mealsProvided,
      accommodationProvided: staff.accommodationProvided,
      accommodationValueCents: String(Math.round(staff.accommodationValueCents / 100)),
      eobiRegistered: staff.eobiRegistered,
      sessiRegistered: staff.sessiRegistered,
      bankAccount: staff.bankAccount ?? '',
    })
  }, [staff])

  function set<K extends keyof typeof form>(key: K, value: (typeof form)[K]) {
    setForm((f) => ({ ...f, [key]: value }))
  }

  const salaryRupees = parseInt(form.monthlySalary || '0', 10)
  const minWage = MIN_WAGE[form.skillLevel] ?? 40_000
  const isBelowMinWage = salaryRupees > 0 && salaryRupees < minWage

  const updateMutation = useMutation({
    mutationFn: () => {
      const body = {
        fullName: form.fullName.trim(),
        cnic: form.cnic.trim() || null,
        phone: form.phone.trim() || null,
        emergencyContact: form.emergencyContact.trim() || null,
        role: form.role,
        skillLevel: form.skillLevel,
        employmentType: form.employmentType,
        dateJoined: form.dateJoined,
        monthlySalaryCents: salaryRupees * 100,
        mealsProvided: form.mealsProvided,
        accommodationProvided: form.accommodationProvided,
        accommodationValueCents: form.accommodationProvided
          ? (parseInt(form.accommodationValueCents || '0', 10) * 100)
          : 0,
        eobiRegistered: form.eobiRegistered,
        sessiRegistered: form.sessiRegistered,
        bankAccount: form.bankAccount.trim() || null,
      }
      return api.put(`/kitchen-staff/staff/${staffId}`, body)
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['kitchen-staff-detail', staffId] })
      void qc.invalidateQueries({ queryKey: ['kitchen-staff'] })
      setSaved(true)
      setTimeout(() => setSaved(false), 3000)
    },
    onError: (err: Error) => setError(err.message),
  })

  const resolveMutation = useMutation({
    mutationFn: (violationId: string) => api.patch(`/kitchen-staff/compliance/${violationId}/resolve`, {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['kitchen-staff-detail', staffId] }),
  })

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    if (!form.fullName.trim()) { setError('Full name is required'); return }
    if (!form.role) { setError('Role is required'); return }
    updateMutation.mutate()
  }

  const inputClass = 's-input w-full text-sm px-3 py-2 rounded-xl'
  const selectClass = 's-input w-full text-sm px-3 py-2 rounded-xl'

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin h-6 w-6 rounded-full border-2"
          style={{ borderColor: 'rgba(0,212,177,0.3)', borderTopColor: '#00D4B1' }} />
      </div>
    )
  }

  if (!staff) {
    return (
      <div className="p-6 text-center text-s-muted">
        Staff member not found. <Link href="/kitchen-staff" className="text-teal-400 hover:underline">Go back</Link>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-s-bg">
      <header className="sticky top-0 z-10 bg-s-bg/80 backdrop-blur border-b border-s-border px-6 py-4">
        <Link href="/kitchen-staff" className="text-xs text-s-muted hover:text-s-text">← Kitchen Staff</Link>
        <h1 className="text-xl font-bold text-s-text mt-0.5">{staff.fullName}</h1>
      </header>

      <form onSubmit={handleSubmit} className="p-6 max-w-2xl space-y-6">
        {/* Personal Info */}
        <div className="s-card p-5 space-y-4">
          <h2 className="text-sm font-bold text-s-text">Personal Information</h2>
          <div className="grid grid-cols-2 gap-4">
            <LabeledField label="Full Name *">
              <input type="text" value={form.fullName} onChange={(e) => set('fullName', e.target.value)} className={inputClass} />
            </LabeledField>
            <LabeledField label="CNIC" hint="Format: XXXXX-XXXXXXX-X">
              <input type="text" value={form.cnic} onChange={(e) => set('cnic', e.target.value)} className={inputClass} placeholder="42101-1234567-1" />
            </LabeledField>
            <LabeledField label="Phone">
              <input type="tel" value={form.phone} onChange={(e) => set('phone', e.target.value)} className={inputClass} />
            </LabeledField>
            <LabeledField label="Emergency Contact">
              <input type="text" value={form.emergencyContact} onChange={(e) => set('emergencyContact', e.target.value)} className={inputClass} />
            </LabeledField>
          </div>
        </div>

        {/* Role & Employment */}
        <div className="s-card p-5 space-y-4">
          <h2 className="text-sm font-bold text-s-text">Role &amp; Employment</h2>
          <div className="grid grid-cols-2 gap-4">
            <LabeledField label="Role *">
              <select value={form.role} onChange={(e) => set('role', e.target.value)} className={selectClass}>
                <option value="">Select role…</option>
                {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
              </select>
            </LabeledField>
            <LabeledField label="Skill Level">
              <select value={form.skillLevel} onChange={(e) => set('skillLevel', e.target.value)} className={selectClass}>
                {SKILL_LEVELS.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
              </select>
            </LabeledField>
            <LabeledField label="Employment Type">
              <select value={form.employmentType} onChange={(e) => set('employmentType', e.target.value)} className={selectClass}>
                {EMPLOYMENT_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
              </select>
            </LabeledField>
            <LabeledField label="Date Joined">
              <input type="date" value={form.dateJoined} onChange={(e) => set('dateJoined', e.target.value)} className={inputClass} />
            </LabeledField>
          </div>
        </div>

        {/* Compensation */}
        <div className="s-card p-5 space-y-4">
          <h2 className="text-sm font-bold text-s-text">Compensation</h2>
          <LabeledField
            label="Monthly Salary (PKR)"
            hint={`Min wage for ${SKILL_LEVELS.find(s => s.value === form.skillLevel)?.label}: ${fmtPkr(minWage * 100)}`}
          >
            <input
              type="number"
              value={form.monthlySalary}
              onChange={(e) => set('monthlySalary', e.target.value)}
              className={inputClass}
              min={0}
            />
            {isBelowMinWage && (
              <p className="text-xs font-semibold mt-1" style={{ color: '#F59E0B' }}>
                ⚠ Below minimum wage ({fmtPkr(minWage * 100)} for {SKILL_LEVELS.find(s => s.value === form.skillLevel)?.label})
              </p>
            )}
          </LabeledField>
          <div className="flex items-center gap-6">
            <div className="flex items-center gap-2">
              <input type="checkbox" id="meals" checked={form.mealsProvided} onChange={(e) => set('mealsProvided', e.target.checked)} className="rounded" />
              <label htmlFor="meals" className="text-xs text-s-muted cursor-pointer">Meals provided</label>
            </div>
            <div className="flex items-center gap-2">
              <input type="checkbox" id="accommodation" checked={form.accommodationProvided} onChange={(e) => set('accommodationProvided', e.target.checked)} className="rounded" />
              <label htmlFor="accommodation" className="text-xs text-s-muted cursor-pointer">Accommodation</label>
            </div>
          </div>
          {form.accommodationProvided && (
            <LabeledField label="Accommodation Value (PKR / month)">
              <input type="number" value={form.accommodationValueCents} onChange={(e) => set('accommodationValueCents', e.target.value)} className={inputClass} min={0} />
            </LabeledField>
          )}
        </div>

        {/* Compliance & Banking */}
        <div className="s-card p-5 space-y-4">
          <h2 className="text-sm font-bold text-s-text">Compliance &amp; Banking</h2>
          <div className="flex items-center gap-6">
            <div className="flex items-center gap-2">
              <input type="checkbox" id="eobi" checked={form.eobiRegistered} onChange={(e) => set('eobiRegistered', e.target.checked)} className="rounded" />
              <label htmlFor="eobi" className="text-xs text-s-muted cursor-pointer">EOBI Registered</label>
            </div>
            <div className="flex items-center gap-2">
              <input type="checkbox" id="sessi" checked={form.sessiRegistered} onChange={(e) => set('sessiRegistered', e.target.checked)} className="rounded" />
              <label htmlFor="sessi" className="text-xs text-s-muted cursor-pointer">SESSI Registered</label>
            </div>
          </div>
          <LabeledField label="Bank Account (optional)">
            <input type="text" value={form.bankAccount} onChange={(e) => set('bankAccount', e.target.value)} className={inputClass} placeholder="IBAN or account number" />
          </LabeledField>
        </div>

        {/* Error / success */}
        {error && (
          <div className="px-4 py-2.5 rounded-xl text-sm font-medium"
            style={{ background: 'rgba(255,77,79,0.08)', border: '1px solid rgba(255,77,79,0.25)', color: '#FF4D4F' }}>
            {error}
          </div>
        )}
        {saved && (
          <div className="px-4 py-2.5 rounded-xl text-sm font-medium"
            style={{ background: 'rgba(0,212,177,0.08)', border: '1px solid rgba(0,212,177,0.25)', color: '#00D4B1' }}>
            ✓ Changes saved
          </div>
        )}

        <div className="flex items-center gap-3">
          <Link href="/kitchen-staff" className="s-btn-secondary text-sm">Cancel</Link>
          <button type="submit" disabled={updateMutation.isPending} className="s-btn-primary text-sm disabled:opacity-50">
            {updateMutation.isPending ? 'Saving…' : 'Save Changes'}
          </button>
        </div>

        {/* Compliance Violations */}
        {staff.complianceViolations && staff.complianceViolations.length > 0 && (
          <div className="s-card overflow-hidden">
            <div className="px-4 py-3 border-b border-s-border">
              <h2 className="text-sm font-bold text-s-text">Compliance Violations</h2>
            </div>
            <table className="w-full text-sm">
              <thead>
                <tr style={{ background: 'rgba(255,255,255,0.02)' }}>
                  {['Type', 'Description', 'Detected', 'Status', ''].map((col) => (
                    <th key={col} className="text-left px-4 py-2 text-[11px] font-bold uppercase tracking-wide"
                      style={{ color: 'rgba(255,255,255,0.3)' }}>
                      {col}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {staff.complianceViolations.map((v) => (
                  <tr key={v.id} style={{ borderTop: '1px solid rgba(255,255,255,0.04)' }}>
                    <td className="px-4 py-2.5">
                      <span className="text-[11px] font-semibold px-2 py-0.5 rounded-md"
                        style={{ background: 'rgba(255,77,79,0.1)', color: '#FF4D4F', border: '1px solid rgba(255,77,79,0.2)' }}>
                        {v.type.replace(/_/g, ' ')}
                      </span>
                    </td>
                    <td className="px-4 py-2.5 text-xs max-w-xs truncate" style={{ color: 'rgba(255,255,255,0.6)' }}>
                      {v.description}
                    </td>
                    <td className="px-4 py-2.5 text-xs" style={{ color: 'rgba(255,255,255,0.4)' }}>
                      {formatDistanceToNowStrict(new Date(v.detectedAt), { addSuffix: true })}
                    </td>
                    <td className="px-4 py-2.5">
                      {v.resolved
                        ? <span className="s-badge-teal">Resolved</span>
                        : <span className="s-badge-red">Open</span>}
                    </td>
                    <td className="px-4 py-2.5">
                      {!v.resolved && (
                        <button
                          onClick={() => resolveMutation.mutate(v.id)}
                          disabled={resolveMutation.isPending}
                          className="text-xs px-2.5 py-1 rounded-lg transition-colors disabled:opacity-50"
                          style={{ background: 'rgba(0,212,177,0.08)', border: '1px solid rgba(0,212,177,0.2)', color: '#00D4B1' }}
                        >
                          Resolve
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </form>
    </div>
  )
}
