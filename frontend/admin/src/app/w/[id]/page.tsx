'use client'
// A workspace's home (decision 47): who owns it, its sections as cards linking
// to their pages, and a "My team" summary. Sections and access come from
// GET /permissions/me (already filtered to this user's modules); the pages
// behind each module from lib/moduleCatalog.ts.

import Link from 'next/link'
import { useParams } from 'next/navigation'
import { usePermissions } from '../../../hooks/useCan'
import { useMyWorkspaces, useWorkspaceDefs } from '../../../hooks/useWorkspaces'
import { useTeam, isInToday } from '../../../hooks/useTeam'
import { roleLabel } from '../../../lib/appRoles'
import { pagesForModules } from '../../../lib/moduleCatalog'

const card = { background: 'rgb(var(--fg-rgb) / 0.03)', border: '1px solid rgb(var(--fg-rgb) / 0.07)' }

export default function WorkspaceHomePage() {
  const params = useParams<{ id: string }>()
  const id = params?.id ?? ''
  const { data: me } = usePermissions()
  const { workspaces, isLoading } = useMyWorkspaces()
  const { data: defs } = useWorkspaceDefs()
  const ws = workspaces.find((w) => w.id === id)
  const def = defs?.find((d) => d.id === id)

  if (isLoading) return <Shell><p className="text-sm text-white/40">Loading…</p></Shell>

  if (!ws) {
    return (
      <Shell>
        <h1 className="text-2xl font-black text-white/90">{def?.title ?? 'Workspace'}</h1>
        <p className="text-sm text-white/45 mt-2 max-w-xl">
          {def
            ? `Your role${me?.role ? ` (${roleLabel(me.role)})` : ''} has no part of ${def.title}. Ask the CEO if you need it opened up.`
            : 'No such workspace.'}
        </p>
        <Link href="/modules" className="inline-block mt-4 text-xs font-bold text-primary-ink hover:underline">All workspaces →</Link>
      </Shell>
    )
  }

  const isCeo = me?.role === 'admin'
  const canInvite = (me?.childRoles ?? []).length > 0
  // The workspace's dashboard comes first, ahead of the sections.
  const lead = pagesForModules(ws.sections.flatMap((s) => s.modules)).filter((p) => p.lead)

  return (
    <Shell>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-[11px] font-bold uppercase tracking-wider text-white/35">Workspace</p>
          <h1 className="text-3xl font-black text-white/90">{ws.title}</h1>
          <p className="text-sm text-white/45 mt-1">
            Owner: <span className="text-white/75 font-semibold">{def ? def.ownerRoles.map(roleLabel).join(' / ') : '—'}</span>
            {ws.owner && <span className="ml-2 text-[10px] font-black uppercase tracking-wider px-1.5 py-0.5 rounded"
              style={{ background: 'rgb(var(--erp-primary-rgb) / 0.1)', color: 'var(--erp-primary-ink)' }}>You own this</span>}
          </p>
        </div>
        {ws.owner && (isCeo || canInvite) && (
          <Link href={isCeo ? '/workforce' : '/team#add-login'}
            className="rounded-lg px-3 py-2 text-xs font-black hover:opacity-90"
            style={{ background: 'var(--erp-primary)', color: 'var(--erp-on-primary)' }}>
            + Add a login
          </Link>
        )}
      </div>

      {lead.map((p) => (
        <Link key={p.href} href={p.href} className="mt-5 flex items-center rounded-2xl px-4 py-3 hover:bg-white/[0.04]" style={card}>
          <span className="text-sm font-black text-white/85">{p.label}</span>
          <span className="ml-auto text-xs text-white/35">Open →</span>
        </Link>
      ))}

      <TeamSummary />

      <div className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {ws.sections.map((s) => {
          const all = pagesForModules(s.modules)
          const pages = all.filter((p) => !p.lead)
          if (pages.length === 0 && all.length > 0) return null // only the dashboard, shown above
          return (
            <div key={s.key} className="rounded-2xl p-4" style={card}>
              <p className="text-sm font-black text-white/85">{s.title}</p>
              <div className="mt-2 space-y-1">
                {pages.length === 0 && <p className="text-[11px] text-white/35">No admin page for this section.</p>}
                {pages.map((p) => (
                  <Link key={p.href} href={p.href} className="block rounded-lg px-2 py-1.5 -mx-2 hover:bg-white/[0.04]">
                    <span className="text-[13px] font-semibold text-white/80">{p.label}</span>
                    {p.hint && <span className="block text-[11px] text-white/35">{p.hint}</span>}
                  </Link>
                ))}
              </div>
            </div>
          )
        })}
      </div>
    </Shell>
  )
}

function TeamSummary() {
  const { data, isLoading, error } = useTeam()
  if (isLoading || error) return null
  const team = data?.team ?? []
  const inToday = team.filter(isInToday).length
  const pending = data?.pendingApprovals ?? 0
  return (
    <Link href="/team" className="mt-5 flex flex-wrap items-center gap-x-6 gap-y-2 rounded-2xl px-4 py-3 hover:bg-white/[0.04]" style={card}>
      <span className="text-sm font-black text-white/85">My team</span>
      {!data?.me ? (
        <span className="text-xs text-white/40">Your login isn&rsquo;t linked to an employee record, so no team is shown.</span>
      ) : (
        <>
          <span className="text-xs text-white/55"><b className="text-white/85">{team.length}</b> {team.length === 1 ? 'person' : 'people'}</span>
          <span className="text-xs text-white/55"><b className="text-[#3f7d20]">{inToday}</b> in today</span>
          <span className="text-xs text-white/55"><b className={pending > 0 ? 'text-amber-700' : 'text-white/85'}>{pending}</b> waiting on you</span>
        </>
      )}
      <span className="ml-auto text-xs text-white/35">Open →</span>
    </Link>
  )
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen" style={{ background: 'var(--bg)' }}>
      <div className="max-w-6xl mx-auto px-6 py-8">{children}</div>
    </div>
  )
}
