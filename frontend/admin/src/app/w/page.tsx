'use client'
// Landing after sign-in: the user's own workspace home (the first workspace
// GET /permissions/me returns, own ones first). Falls back to the workspace
// list if permissions can't be read or the user has no workspace.

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { useMyWorkspaces } from '../../hooks/useWorkspaces'
import { usePermissions } from '../../hooks/useCan'

export default function WorkspaceLanding() {
  const router = useRouter()
  const { data: me, isError } = usePermissions()
  const { workspaces, isLoading } = useMyWorkspaces()

  useEffect(() => {
    if (isError) { router.replace('/modules'); return }
    if (isLoading || !me) return
    // The CEO lands on the CEO home; everyone else on their own workspace.
    if (me.modules.includes('ceo_overview')) { router.replace('/home'); return }
    const first = workspaces[0]
    router.replace(first ? `/w/${first.id}` : '/modules')
  }, [isError, isLoading, me, workspaces, router])

  return <div className="min-h-screen p-8 text-sm text-white/40" style={{ background: 'var(--bg)' }}>Opening your workspace…</div>
}
