'use client'
import { useState, useMemo, useEffect } from 'react'
import Link from 'next/link'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '../../../lib/api'
import { useCan } from '../../../hooks/useCan'

interface PermissionMeta {
  key: string
  label: string
  desc: string
  category: string
}

interface MatrixData {
  roles: string[]
  matrix: Record<string, Record<string, boolean>>
}

const ROLE_META: Record<string, { emoji: string; label: string; desc: string }> = {
  admin:     { emoji: '👑', label: 'Admin',     desc: 'Owner / GM tier — always has full access' },
  manager:   { emoji: '🧑‍💼', label: 'Manager',   desc: 'Day-to-day operator' },
  cashier:   { emoji: '💳', label: 'Cashier',   desc: 'POS staff, front-of-house' },
  kitchen:   { emoji: '🍳', label: 'Kitchen',   desc: 'Line cooks + prep' },
  expediter: { emoji: '🪧', label: 'Expediter', desc: 'Pass / quality-check' },
}

const CATEGORY_META: Record<string, { label: string; emoji: string }> = {
  live:     { label: 'Live operations',     emoji: '⚡' },
  service:  { label: 'Service / floor',     emoji: '💳' },
  kitchen:  { label: 'Kitchen',             emoji: '🍳' },
  menu:     { label: 'Menu & storefront',   emoji: '📝' },
  finance:  { label: 'Finance & reports',   emoji: '💰' },
  crm:      { label: 'Customers & CRM',     emoji: '👥' },
  platform: { label: 'Platform & settings', emoji: '🎛' },
}

const CATEGORY_ORDER = ['live', 'service', 'kitchen', 'menu', 'finance', 'crm', 'platform']

export default function RolesPermissionsPage() {
  const qc = useQueryClient()
  const canEdit = useCan('permissions:edit')

  const { data: catalogue = [] } = useQuery<PermissionMeta[]>({
    queryKey: ['permissions', 'catalogue'],
    queryFn: () => api.get('/permissions/catalogue'),
  })

  const { data: matrixData, isLoading: matrixLoading } = useQuery<MatrixData>({
    queryKey: ['permissions', 'matrix'],
    queryFn: () => api.get('/permissions/matrix'),
    enabled: canEdit,
  })

  // Local edit buffer — committed only when the user hits Save
  const [draft, setDraft] = useState<Record<string, Record<string, boolean>> | null>(null)
  const [search, setSearch] = useState('')
  const [resetting, setResetting] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  useEffect(() => {
    if (matrixData && !draft) setDraft(matrixData.matrix)
  }, [matrixData, draft])

  const dirty = useMemo(() => {
    if (!draft || !matrixData) return false
    for (const role of Object.keys(draft)) {
      for (const perm of Object.keys(draft[role] ?? {})) {
        if (draft[role]?.[perm] !== matrixData.matrix[role]?.[perm]) return true
      }
    }
    return false
  }, [draft, matrixData])

  const grouped = useMemo(() => {
    const term = search.trim().toLowerCase()
    const out: Record<string, PermissionMeta[]> = {}
    for (const cat of CATEGORY_ORDER) out[cat] = []
    for (const p of catalogue) {
      if (term && !p.key.includes(term) && !p.label.toLowerCase().includes(term) && !p.desc.toLowerCase().includes(term)) continue
      ;(out[p.category] ??= []).push(p)
    }
    return out
  }, [catalogue, search])

  const save = useMutation({
    mutationFn: async () => {
      if (!draft || !matrixData) return
      const changes: Array<{ role: string; permission: string; enabled: boolean }> = []
      for (const role of Object.keys(draft)) {
        for (const perm of Object.keys(draft[role] ?? {})) {
          if (draft[role]?.[perm] !== matrixData.matrix[role]?.[perm]) {
            changes.push({ role, permission: perm, enabled: !!draft[role]?.[perm] })
          }
        }
      }
      if (changes.length === 0) return
      await api.patch('/permissions/matrix', { changes })
    },
    onSuccess: () => {
      setSaveError(null)
      setDraft(null)
      void qc.invalidateQueries({ queryKey: ['permissions', 'matrix'] })
      void qc.invalidateQueries({ queryKey: ['permissions', 'me'] })
    },
    onError: (e: Error) => setSaveError(e.message ?? 'Failed to save changes'),
  })

  async function reset() {
    if (!confirm('Reset every role to its default permissions? Custom changes will be lost.')) return
    setResetting(true)
    try {
      await api.post('/permissions/reset', {})
      setDraft(null)
      void qc.invalidateQueries({ queryKey: ['permissions', 'matrix'] })
      void qc.invalidateQueries({ queryKey: ['permissions', 'me'] })
    } finally { setResetting(false) }
  }

  function toggle(role: string, perm: string) {
    if (!draft) return
    if (role === 'admin') return    // admin always has everything
    setDraft({
      ...draft,
      [role]: { ...draft[role], [perm]: !draft[role]?.[perm] },
    })
  }

  if (!canEdit) {
    return (
      <div className="min-h-screen p-7" style={{ background: '#090a0e' }}>
        <Link href="/configuration" className="text-xs text-white/40 hover:text-white/70">← Configuration Hub</Link>
        <div className="mt-8 max-w-md mx-auto rounded-2xl p-8 text-center"
          style={{ background: 'rgba(255,77,79,0.05)', border: '1px solid rgba(255,77,79,0.2)' }}>
          <p className="text-3xl mb-3">🔒</p>
          <p className="font-bold text-white/85">Admin only</p>
          <p className="text-sm text-white/45 mt-1">Editing the permission matrix requires the <code>permissions:edit</code> capability.</p>
        </div>
      </div>
    )
  }

  const ROLES = matrixData?.roles ?? ['admin', 'manager', 'cashier', 'kitchen', 'expediter']

  return (
    <div className="min-h-screen" style={{ background: '#090a0e' }}>
      <header className="px-7 py-6 border-b border-white/[0.05]">
        <div className="flex items-center gap-2 text-xs text-white/40 mb-2">
          <Link href="/configuration" className="hover:text-white/70">← Configuration Hub</Link>
        </div>
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div>
            <h1 className="text-2xl font-black text-white/90">👥 Roles & Permissions</h1>
            <p className="text-sm text-white/40 mt-1 max-w-2xl">
              Tick or untick a cell to grant / revoke. Admin always retains every permission as a safety net — that column is read-only.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => void reset()}
              disabled={resetting}
              className="rounded-xl border border-white/10 px-4 py-2.5 text-xs font-bold text-white/55 hover:text-white disabled:opacity-50"
            >
              {resetting ? 'Resetting…' : '↺ Reset to defaults'}
            </button>
            <button
              onClick={() => save.mutate()}
              disabled={!dirty || save.isPending}
              className="rounded-xl px-5 py-2.5 text-xs font-black text-black disabled:opacity-50"
              style={{ background: dirty ? '#00D4B1' : 'rgba(0,212,177,0.4)' }}
            >
              {save.isPending ? 'Saving…' : dirty ? 'Save changes' : 'No changes'}
            </button>
          </div>
        </div>
      </header>

      <div className="px-7 py-6 max-w-[1200px] mx-auto space-y-5">
        {/* Search */}
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search permissions — try 'refund', 'menu', 'shift'…"
          className="w-full rounded-xl px-4 py-2.5 text-sm focus:outline-none"
          style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.08)', color: 'rgba(255,255,255,0.85)' }}
        />

        {saveError && (
          <div className="rounded-xl px-3 py-2 text-xs"
            style={{ background: 'rgba(255,77,79,0.08)', color: '#FF4D4F', border: '1px solid rgba(255,77,79,0.25)' }}>
            {saveError}
          </div>
        )}

        {matrixLoading && (
          <div className="text-center py-12 text-sm text-white/40">Loading matrix…</div>
        )}

        {/* Role headers (sticky) */}
        {!matrixLoading && draft && (
          <div className="rounded-2xl overflow-hidden" style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.06)' }}>
            {/* Header row */}
            <div className="grid sticky top-0 z-10 backdrop-blur"
              style={{
                gridTemplateColumns: `minmax(280px, 1fr) repeat(${ROLES.length}, 110px)`,
                background: 'rgba(15,17,22,0.95)',
                borderBottom: '1px solid rgba(255,255,255,0.06)',
              }}>
              <div className="px-4 py-3 text-[10px] font-black uppercase tracking-[0.24em] text-white/45">Permission</div>
              {ROLES.map((role) => {
                const meta = ROLE_META[role] ?? { emoji: '?', label: role, desc: '' }
                return (
                  <div key={role} className="px-2 py-3 text-center border-l border-white/[0.04]">
                    <p className="text-lg leading-none">{meta.emoji}</p>
                    <p className="text-[10px] font-black uppercase tracking-wider text-white/65 mt-1">{meta.label}</p>
                  </div>
                )
              })}
            </div>

            {/* Category sections */}
            {CATEGORY_ORDER.map((cat) => {
              const perms = grouped[cat] ?? []
              if (perms.length === 0) return null
              const meta = CATEGORY_META[cat]
              return (
                <div key={cat}>
                  <div
                    className="grid"
                    style={{
                      gridTemplateColumns: `minmax(280px, 1fr) repeat(${ROLES.length}, 110px)`,
                      background: 'rgba(255,255,255,0.015)',
                      borderTop: '1px solid rgba(255,255,255,0.04)',
                      borderBottom: '1px solid rgba(255,255,255,0.04)',
                    }}>
                    <div className="px-4 py-2 col-span-full">
                      <p className="text-[10px] font-black uppercase tracking-[0.24em] text-white/55">
                        {meta?.emoji} {meta?.label ?? cat}
                      </p>
                    </div>
                  </div>
                  {perms.map((p) => (
                    <div
                      key={p.key}
                      className="grid items-center hover:bg-white/[0.015]"
                      style={{
                        gridTemplateColumns: `minmax(280px, 1fr) repeat(${ROLES.length}, 110px)`,
                        borderBottom: '1px solid rgba(255,255,255,0.03)',
                      }}>
                      <div className="px-4 py-2.5">
                        <p className="text-xs font-bold text-white/85">{p.label}</p>
                        <p className="text-[10px] text-white/35 mt-0.5">{p.desc}</p>
                        <p className="text-[10px] text-white/25 font-mono mt-0.5">{p.key}</p>
                      </div>
                      {ROLES.map((role) => {
                        const isAdmin = role === 'admin'
                        const enabled = isAdmin ? true : !!draft[role]?.[p.key]
                        const wasEnabled = !!matrixData?.matrix[role]?.[p.key]
                        const changed = !isAdmin && enabled !== wasEnabled
                        return (
                          <div key={role} className="flex items-center justify-center px-2 py-2.5 border-l border-white/[0.03]">
                            <button
                              onClick={() => toggle(role, p.key)}
                              disabled={isAdmin}
                              className={`h-6 w-6 rounded-md flex items-center justify-center text-xs font-black transition-all ${
                                isAdmin ? 'cursor-not-allowed' : 'hover:scale-110'
                              }`}
                              style={
                                enabled
                                  ? {
                                      background: changed ? '#F59E0B' : '#00D4B1',
                                      color: '#000',
                                      boxShadow: changed ? '0 0 8px rgba(245,158,11,0.4)' : 'none',
                                    }
                                  : {
                                      background: 'rgba(255,255,255,0.03)',
                                      border: changed ? '1px solid #F59E0B' : '1px solid rgba(255,255,255,0.1)',
                                      color: 'transparent',
                                    }
                              }
                              title={isAdmin ? 'Admin always has every permission' : (enabled ? 'Granted — click to revoke' : 'Revoked — click to grant')}
                            >
                              {enabled ? '✓' : ''}
                            </button>
                          </div>
                        )
                      })}
                    </div>
                  ))}
                </div>
              )
            })}
          </div>
        )}

        {/* Helper card */}
        <div className="rounded-xl p-4 text-xs text-white/45 leading-relaxed"
          style={{ background: 'rgba(99,102,241,0.05)', border: '1px solid rgba(99,102,241,0.15)' }}>
          💡 Cells with an amber border are unsaved changes. Click <strong>Save changes</strong> to commit, or refresh the page to discard. The frontend re-fetches role permissions on every page load (5-min cache), so users see the new permissions on their next page navigation.
        </div>
      </div>
    </div>
  )
}
