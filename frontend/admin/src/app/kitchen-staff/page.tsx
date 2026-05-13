'use client'
import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { api } from '../../lib/api'
import { fmtPkr } from '../../lib/money'
import { TenantChip, useMyTenants } from '../../components/ui/TenantPicker'

// ─── Types ────────────────────────────────────────────────────────────────────

type StaffStatus = 'active' | 'on_leave' | 'terminated'
type SkillLevel = 'unskilled' | 'semi_skilled' | 'skilled' | 'highly_skilled'
type EmploymentType = 'permanent' | 'probationary' | 'temporary' | 'contract'

interface KitchenStaff {
  id: string
  fullName: string
  role: string
  skillLevel: SkillLevel
  employmentType: EmploymentType
  monthlySalaryCents: number
  eobiRegistered: boolean
  sessiRegistered: boolean
  status: StaffStatus
  dateJoined: string
  dateLeft: string | null
  // Hydrated by the backend so portfolio view can render the brand chip
  // next to each name without an extra fetch.
  tenantId?: string | null
  tenant?: { id: string; name: string } | null
  _count?: { complianceViolations: number }
  complianceViolations?: Array<{ resolved: boolean }>
}

interface BrigadeTemplate {
  id: string
  name: string
  description: string
  staff: Array<{ role: string; count: number }>
}

const BRIGADE_TEMPLATES = [
  {
    id: 'small_cafe',
    name: 'Small Cafe',
    description: 'Lean 4-person team for a small cafe operation',
    staff: [
      { role: 'Head Chef', count: 1 },
      { role: 'Commis', count: 2 },
      { role: 'Dishwasher', count: 1 },
    ],
  },
  {
    id: 'mid_restaurant',
    name: 'Mid Restaurant',
    description: 'Standard 8-person brigade for a mid-size restaurant',
    staff: [
      { role: 'Head Chef', count: 1 },
      { role: 'Sous Chef', count: 1 },
      { role: 'CDP', count: 2 },
      { role: 'Commis', count: 2 },
      { role: 'Kitchen Helper', count: 1 },
      { role: 'Dishwasher', count: 1 },
    ],
  },
  {
    id: 'cloud_kitchen',
    name: 'Cloud Kitchen',
    description: '6-person high-throughput cloud kitchen setup',
    staff: [
      { role: 'Head Chef', count: 1 },
      { role: 'Demi Chef', count: 2 },
      { role: 'Kitchen Helper', count: 2 },
      { role: 'Dishwasher', count: 1 },
    ],
  },
]

const STATUS_FILTERS: { key: string; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'active', label: 'Active' },
  { key: 'on_leave', label: 'On Leave' },
  { key: 'terminated', label: 'Terminated' },
]

const ROLE_COLORS: Record<string, string> = {
  'Head Chef': 'bg-teal-500/15 text-teal-400 border-teal-500/20',
  'Sous Chef': 'bg-indigo-500/15 text-indigo-400 border-indigo-500/20',
  'CDP': 'bg-violet-500/15 text-violet-400 border-violet-500/20',
  'Demi Chef': 'bg-blue-500/15 text-blue-400 border-blue-500/20',
  'Commis': 'bg-sky-500/15 text-sky-400 border-sky-500/20',
  'Kitchen Helper': 'bg-amber-500/15 text-amber-400 border-amber-500/20',
  'Dishwasher': 'bg-orange-500/15 text-orange-400 border-orange-500/20',
  'Baker': 'bg-pink-500/15 text-pink-400 border-pink-500/20',
  'Tandoor Grill Cook': 'bg-red-500/15 text-red-400 border-red-500/20',
}

function statusBadge(status: StaffStatus) {
  if (status === 'active') return <span className="s-badge-teal">Active</span>
  if (status === 'on_leave') return <span className="s-badge-amber">On Leave</span>
  return <span className="s-badge-red">Terminated</span>
}

function skillLabel(s: SkillLevel) {
  return { unskilled: 'Unskilled', semi_skilled: 'Semi-skilled', skilled: 'Skilled', highly_skilled: 'Highly Skilled' }[s]
}

function empTypeLabel(e: EmploymentType) {
  return { permanent: 'Permanent', probationary: 'Probationary', temporary: 'Temporary', contract: 'Contract' }[e]
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function KitchenStaffPage() {
  const router = useRouter()
  const qc = useQueryClient()
  const [filterStatus, setFilterStatus] = useState('all')
  const [showBrigadeModal, setShowBrigadeModal] = useState(false)
  const [loadingTemplate, setLoadingTemplate] = useState<string | null>(null)
  const { data: tenants = [] } = useMyTenants()

  const { data: staffList, isLoading } = useQuery({
    queryKey: ['kitchen-staff', filterStatus],
    queryFn: () => {
      const qs = filterStatus !== 'all' ? `?status=${filterStatus}` : ''
      return api.get<KitchenStaff[]>(`/kitchen-staff/staff${qs}`)
    },
  })

  const terminateMutation = useMutation({
    mutationFn: (id: string) => {
      const today = new Date().toISOString().slice(0, 10)
      return api.patch(`/kitchen-staff/staff/${id}`, { status: 'terminated', dateLeft: today })
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['kitchen-staff'] }),
  })

  async function loadTemplate(templateId: string) {
    setLoadingTemplate(templateId)
    try {
      await api.post('/kitchen-staff/staff/from-template', { templateId })
      await qc.invalidateQueries({ queryKey: ['kitchen-staff'] })
      setShowBrigadeModal(false)
    } catch (err) {
      console.error(err)
    } finally {
      setLoadingTemplate(null)
    }
  }

  const hasWageViolation = staffList?.some((s) =>
    s.complianceViolations?.some((v) => !v.resolved)
  )

  return (
    <div className="min-h-screen bg-s-bg">
      {/* Header */}
      <header className="sticky top-0 z-10 bg-s-bg/80 backdrop-blur border-b border-s-border px-6 py-4">
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div>
            <Link href="/configuration" className="text-xs text-s-muted hover:text-s-text">← Configuration</Link>
            <h1 className="text-xl font-bold text-s-text mt-0.5">Kitchen Staff</h1>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setShowBrigadeModal(true)}
              className="s-btn-secondary text-sm"
            >
              Brigade Setup
            </button>
            <button
              onClick={() => router.push('/kitchen-staff/new')}
              className="s-btn-primary text-sm"
            >
              + Add Staff
            </button>
          </div>
        </div>
      </header>

      <div className="p-6 space-y-5 max-w-7xl">
        {/* Wage violation banner */}
        {hasWageViolation && (
          <div className="flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-medium"
            style={{ background: 'rgba(255,77,79,0.08)', border: '1px solid rgba(255,77,79,0.25)', color: '#FF4D4F' }}>
            ⚠ One or more staff members have a Wage Violation — review compliance flags below
          </div>
        )}

        {/* Filter tabs */}
        <div className="flex items-center gap-1 p-1 rounded-xl w-fit"
          style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.06)' }}>
          {STATUS_FILTERS.map((f) => (
            <button
              key={f.key}
              onClick={() => setFilterStatus(f.key)}
              className="px-4 py-1.5 rounded-lg text-xs font-semibold transition-all"
              style={filterStatus === f.key ? {
                background: 'rgba(0,212,177,0.12)',
                border: '1px solid rgba(0,212,177,0.25)',
                color: '#00D4B1',
              } : {
                background: 'transparent',
                border: '1px solid transparent',
                color: 'rgba(255,255,255,0.35)',
              }}
            >
              {f.label}
            </button>
          ))}
        </div>

        {/* Table */}
        {isLoading ? (
          <div className="flex items-center justify-center h-48">
            <div className="animate-spin h-6 w-6 rounded-full border-2"
              style={{ borderColor: 'rgba(0,212,177,0.3)', borderTopColor: '#00D4B1' }} />
          </div>
        ) : (
          <div className="rounded-2xl overflow-hidden" style={{ border: '1px solid rgba(255,255,255,0.06)' }}>
            <div className="overflow-x-auto">
              <table className="w-full text-sm" style={{ minWidth: '900px' }}>
                <thead>
                  <tr style={{ background: 'rgba(255,255,255,0.03)', borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
                    {['Name', 'Role', 'Skill', 'Type', 'Salary', 'EOBI', 'SESSI', 'Status', 'Flags', 'Actions'].map((col) => (
                      <th key={col} className="text-left px-4 py-3 text-[11px] font-bold uppercase tracking-wider"
                        style={{ color: 'rgba(255,255,255,0.3)' }}>
                        {col}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {(!staffList || staffList.length === 0) && (
                    <tr>
                      <td colSpan={10} className="text-center py-12 text-sm" style={{ color: 'rgba(255,255,255,0.3)' }}>
                        No staff found. <button onClick={() => router.push('/kitchen-staff/new')} className="text-teal-400 hover:underline">Add your first staff member</button>
                      </td>
                    </tr>
                  )}
                  {staffList?.map((s) => {
                    const openFlags = s.complianceViolations?.filter((v) => !v.resolved).length
                      ?? (s._count?.complianceViolations ?? 0)
                    return (
                      <tr
                        key={s.id}
                        className="cursor-pointer transition-colors"
                        style={{ borderBottom: '1px solid rgba(255,255,255,0.04)' }}
                        onMouseEnter={(e) => (e.currentTarget.style.background = 'rgba(255,255,255,0.02)')}
                        onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
                        onClick={() => router.push(`/kitchen-staff/${s.id}`)}
                      >
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-2 flex-wrap">
                            <div className="font-semibold" style={{ color: 'rgba(255,255,255,0.85)' }}>{s.fullName}</div>
                            {/* Brand chip in portfolio view so the operator can
                                see which company each kitchen-staff row belongs
                                to. Hidden in single-tenant view. */}
                            <TenantChip tenant={s.tenant} tenantId={s.tenantId} tenants={tenants} />
                          </div>
                          <div className="text-[11px]" style={{ color: 'rgba(255,255,255,0.3)' }}>
                            Joined {new Date(s.dateJoined).toLocaleDateString('en-PK', { month: 'short', year: 'numeric' })}
                          </div>
                        </td>
                        <td className="px-4 py-3">
                          <span className={`inline-block text-[11px] font-semibold px-2 py-0.5 rounded-md border ${ROLE_COLORS[s.role] ?? 'bg-white/5 text-white/50 border-white/10'}`}>
                            {s.role}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-xs" style={{ color: 'rgba(255,255,255,0.55)' }}>
                          {skillLabel(s.skillLevel)}
                        </td>
                        <td className="px-4 py-3 text-xs" style={{ color: 'rgba(255,255,255,0.55)' }}>
                          {empTypeLabel(s.employmentType)}
                        </td>
                        <td className="px-4 py-3 text-xs font-mono" style={{ color: 'rgba(255,255,255,0.75)' }}>
                          {fmtPkr(s.monthlySalaryCents)}
                        </td>
                        <td className="px-4 py-3 text-center">
                          {s.eobiRegistered
                            ? <span className="text-teal-400">✓</span>
                            : <span style={{ color: 'rgba(255,255,255,0.2)' }}>–</span>}
                        </td>
                        <td className="px-4 py-3 text-center">
                          {s.sessiRegistered
                            ? <span className="text-teal-400">✓</span>
                            : <span style={{ color: 'rgba(255,255,255,0.2)' }}>–</span>}
                        </td>
                        <td className="px-4 py-3">{statusBadge(s.status)}</td>
                        <td className="px-4 py-3">
                          {openFlags > 0 ? (
                            <span className="s-badge-red">{openFlags}</span>
                          ) : (
                            <span style={{ color: 'rgba(255,255,255,0.2)' }} className="text-xs">–</span>
                          )}
                        </td>
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
                            <button
                              onClick={() => router.push(`/kitchen-staff/${s.id}`)}
                              className="text-xs px-2.5 py-1 rounded-lg transition-colors"
                              style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)', color: 'rgba(255,255,255,0.5)' }}
                            >
                              Edit
                            </button>
                            {s.status !== 'terminated' && (
                              <button
                                onClick={() => {
                                  if (confirm(`Terminate ${s.fullName}?`)) terminateMutation.mutate(s.id)
                                }}
                                disabled={terminateMutation.isPending}
                                className="text-xs px-2.5 py-1 rounded-lg transition-colors disabled:opacity-50"
                                style={{ background: 'rgba(255,77,79,0.08)', border: '1px solid rgba(255,77,79,0.2)', color: '#FF4D4F' }}
                              >
                                Terminate
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>

      {/* Brigade Setup Modal */}
      {showBrigadeModal && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4"
          style={{ background: 'rgba(0,0,0,0.7)' }}
          onClick={(e) => { if (e.target === e.currentTarget) setShowBrigadeModal(false) }}
        >
          <div className="w-full max-w-2xl rounded-2xl p-6 space-y-5"
            style={{ background: '#0d0f15', border: '1px solid rgba(255,255,255,0.1)' }}>
            <div className="flex items-center justify-between">
              <h2 className="text-base font-bold" style={{ color: 'rgba(255,255,255,0.9)' }}>Brigade Setup Templates</h2>
              <button onClick={() => setShowBrigadeModal(false)}
                className="text-xs px-2 py-1 rounded-lg"
                style={{ color: 'rgba(255,255,255,0.4)', background: 'rgba(255,255,255,0.04)' }}>✕</button>
            </div>
            <p className="text-xs" style={{ color: 'rgba(255,255,255,0.4)' }}>
              Load a preset brigade template to quickly create a standard set of kitchen staff roles.
            </p>
            <div className="grid grid-cols-1 gap-4">
              {BRIGADE_TEMPLATES.map((tpl) => (
                <div key={tpl.id} className="rounded-xl p-4 space-y-3"
                  style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.07)' }}>
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <h3 className="text-sm font-bold" style={{ color: 'rgba(255,255,255,0.85)' }}>{tpl.name}</h3>
                      <p className="text-xs mt-0.5" style={{ color: 'rgba(255,255,255,0.4)' }}>{tpl.description}</p>
                    </div>
                    <button
                      onClick={() => loadTemplate(tpl.id)}
                      disabled={loadingTemplate === tpl.id}
                      className="shrink-0 text-xs px-3 py-1.5 rounded-lg font-semibold disabled:opacity-50 transition-opacity"
                      style={{ background: 'rgba(0,212,177,0.1)', border: '1px solid rgba(0,212,177,0.25)', color: '#00D4B1' }}
                    >
                      {loadingTemplate === tpl.id ? 'Loading…' : 'Load Template'}
                    </button>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {tpl.staff.map((r) => (
                      <span key={r.role} className="text-[11px] px-2 py-0.5 rounded-md"
                        style={{ background: 'rgba(255,255,255,0.05)', color: 'rgba(255,255,255,0.55)' }}>
                        {r.role} ×{r.count}
                      </span>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
