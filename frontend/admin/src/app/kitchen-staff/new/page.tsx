'use client'
import { useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { api } from '../../../lib/api'
import { fmtPkr } from '../../../lib/money'

// ─── Min-wage constants (PKR rupees, not cents) ───────────────────────────────
const MIN_WAGE: Record<string, number> = {
  unskilled: 40_000,
  semi_skilled: 41_280,
  skilled: 48_910,
  highly_skilled: 50_868,
}

const ROLES = [
  'Head Chef',
  'Sous Chef',
  'CDP',
  'Demi Chef',
  'Commis',
  'Kitchen Helper',
  'Dishwasher',
  'Baker',
  'Tandoor Grill Cook',
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

interface StaffForm {
  fullName: string
  cnic: string
  phone: string
  emergencyContact: string
  role: string
  skillLevel: string
  employmentType: string
  dateJoined: string
  monthlySalary: string
  mealsProvided: boolean
  accommodationProvided: boolean
  accommodationValueCents: string
  eobiRegistered: boolean
  sessiRegistered: boolean
  bankAccount: string
}

const DEFAULT_FORM: StaffForm = {
  fullName: '',
  cnic: '',
  phone: '',
  emergencyContact: '',
  role: '',
  skillLevel: 'unskilled',
  employmentType: 'permanent',
  dateJoined: new Date().toISOString().slice(0, 10),
  monthlySalary: '',
  mealsProvided: false,
  accommodationProvided: false,
  accommodationValueCents: '',
  eobiRegistered: false,
  sessiRegistered: false,
  bankAccount: '',
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

export default function AddStaffPage() {
  const router = useRouter()
  const [form, setForm] = useState<StaffForm>(DEFAULT_FORM)
  const [error, setError] = useState<string | null>(null)

  function set<K extends keyof StaffForm>(key: K, value: StaffForm[K]) {
    setForm((f) => ({ ...f, [key]: value }))
  }

  const salaryRupees = parseInt(form.monthlySalary || '0', 10)
  const minWage = MIN_WAGE[form.skillLevel] ?? 40_000
  const isBelowMinWage = salaryRupees > 0 && salaryRupees < minWage

  const createMutation = useMutation({
    mutationFn: () => {
      const body = {
        fullName: form.fullName.trim(),
        cnic: form.cnic.trim() || undefined,
        phone: form.phone.trim() || undefined,
        emergencyContact: form.emergencyContact.trim() || undefined,
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
        bankAccount: form.bankAccount.trim() || undefined,
      }
      return api.post('/kitchen-staff/staff', body)
    },
    onSuccess: () => router.push('/kitchen-staff'),
    onError: (err: Error) => setError(err.message),
  })

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    if (!form.fullName.trim()) { setError('Full name is required'); return }
    if (!form.role) { setError('Role is required'); return }
    if (!form.dateJoined) { setError('Date joined is required'); return }
    createMutation.mutate()
  }

  const inputClass = 's-input w-full text-sm px-3 py-2 rounded-xl'
  const selectClass = 's-input w-full text-sm px-3 py-2 rounded-xl'

  return (
    <div className="min-h-screen bg-s-bg">
      <header className="sticky top-0 z-10 bg-s-bg/80 backdrop-blur border-b border-s-border px-6 py-4">
        <Link href="/kitchen-staff" className="text-xs text-s-muted hover:text-s-text">← Kitchen Staff</Link>
        <h1 className="text-xl font-bold text-s-text mt-0.5">Add Staff Member</h1>
      </header>

      <form onSubmit={handleSubmit} className="p-6 max-w-2xl space-y-6">
        {/* Personal Info */}
        <div className="s-card p-5 space-y-4">
          <h2 className="text-sm font-bold text-s-text">Personal Information</h2>
          <div className="grid grid-cols-2 gap-4">
            <LabeledField label="Full Name *">
              <input
                type="text"
                value={form.fullName}
                onChange={(e) => set('fullName', e.target.value)}
                className={inputClass}
                placeholder="Muhammad Ali Khan"
              />
            </LabeledField>
            <LabeledField label="CNIC" hint="Format: XXXXX-XXXXXXX-X">
              <input
                type="text"
                value={form.cnic}
                onChange={(e) => set('cnic', e.target.value)}
                className={inputClass}
                placeholder="42101-1234567-1"
              />
            </LabeledField>
            <LabeledField label="Phone">
              <input
                type="tel"
                value={form.phone}
                onChange={(e) => set('phone', e.target.value)}
                className={inputClass}
                placeholder="0300-1234567"
              />
            </LabeledField>
            <LabeledField label="Emergency Contact">
              <input
                type="text"
                value={form.emergencyContact}
                onChange={(e) => set('emergencyContact', e.target.value)}
                className={inputClass}
                placeholder="Name: 0300-7654321"
              />
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
            <LabeledField label="Date Joined *">
              <input
                type="date"
                value={form.dateJoined}
                onChange={(e) => set('dateJoined', e.target.value)}
                className={inputClass}
              />
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
              placeholder="e.g. 45000"
              min={0}
            />
            {isBelowMinWage && (
              <p className="text-xs font-semibold mt-1" style={{ color: '#F59E0B' }}>
                ⚠ Below minimum wage ({fmtPkr(minWage * 100)} for {SKILL_LEVELS.find(s => s.value === form.skillLevel)?.label})
              </p>
            )}
          </LabeledField>

          <div className="grid grid-cols-3 gap-4">
            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                id="meals"
                checked={form.mealsProvided}
                onChange={(e) => set('mealsProvided', e.target.checked)}
                className="rounded"
              />
              <label htmlFor="meals" className="text-xs text-s-muted cursor-pointer">Meals provided</label>
            </div>
            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                id="accommodation"
                checked={form.accommodationProvided}
                onChange={(e) => set('accommodationProvided', e.target.checked)}
                className="rounded"
              />
              <label htmlFor="accommodation" className="text-xs text-s-muted cursor-pointer">Accommodation</label>
            </div>
          </div>

          {form.accommodationProvided && (
            <LabeledField label="Accommodation Value (PKR / month)">
              <input
                type="number"
                value={form.accommodationValueCents}
                onChange={(e) => set('accommodationValueCents', e.target.value)}
                className={inputClass}
                placeholder="e.g. 8000"
                min={0}
              />
            </LabeledField>
          )}
        </div>

        {/* Compliance & Banking */}
        <div className="s-card p-5 space-y-4">
          <h2 className="text-sm font-bold text-s-text">Compliance &amp; Banking</h2>
          <div className="flex items-center gap-6">
            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                id="eobi"
                checked={form.eobiRegistered}
                onChange={(e) => set('eobiRegistered', e.target.checked)}
                className="rounded"
              />
              <label htmlFor="eobi" className="text-xs text-s-muted cursor-pointer">EOBI Registered</label>
            </div>
            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                id="sessi"
                checked={form.sessiRegistered}
                onChange={(e) => set('sessiRegistered', e.target.checked)}
                className="rounded"
              />
              <label htmlFor="sessi" className="text-xs text-s-muted cursor-pointer">SESSI Registered</label>
            </div>
          </div>
          <LabeledField label="Bank Account (optional)">
            <input
              type="text"
              value={form.bankAccount}
              onChange={(e) => set('bankAccount', e.target.value)}
              className={inputClass}
              placeholder="IBAN or account number"
            />
          </LabeledField>
        </div>

        {/* Error */}
        {error && (
          <div className="px-4 py-2.5 rounded-xl text-sm font-medium"
            style={{ background: 'rgba(255,77,79,0.08)', border: '1px solid rgba(255,77,79,0.25)', color: '#FF4D4F' }}>
            {error}
          </div>
        )}

        {/* Actions */}
        <div className="flex items-center gap-3">
          <Link href="/kitchen-staff" className="s-btn-secondary text-sm">Cancel</Link>
          <button
            type="submit"
            disabled={createMutation.isPending}
            className="s-btn-primary text-sm disabled:opacity-50"
          >
            {createMutation.isPending ? 'Saving…' : 'Add Staff Member'}
          </button>
        </div>
      </form>
    </div>
  )
}
