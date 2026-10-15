'use client'
import type { TrashItem } from '../../lib/trash'

export function when(iso?: string | null): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })
}

export function StateBadge({ item }: { item: TrashItem }) {
  if (item.state === 'restored') return <span className="s-badge-green">Restored</span>
  if (item.state === 'purged') return <span className="s-badge-muted">Deleted forever</span>
  if (item.state === 'archived') return <span className="s-badge-muted">Archived</span>
  return null
}

export function TrashRow({ item, typeLabel, showCompany, isCeo, busy, onOpen, onRestore, onCopy, onPurge, onArchive }: {
  item: TrashItem; typeLabel: string; showCompany: boolean; isCeo: boolean; busy: boolean
  onOpen: () => void; onRestore: () => void; onCopy: () => void; onPurge: () => void; onArchive: (undo: boolean) => void
}) {
  const open = item.state === 'in_trash'
  const verb = item.kind === 'transaction' ? (item.statusLabel ?? 'Voided') : 'Deleted'
  return (
    <li className="rounded-2xl p-4 flex flex-col gap-3 sm:flex-row sm:items-center" style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}>
      <button type="button" onClick={onOpen} className="min-w-0 flex-1 text-left">
        <div className="flex flex-wrap items-center gap-2">
          <span className="s-badge-purple">{typeLabel}</span>
          <StateBadge item={item} />
          <span className="font-bold text-white/90 break-words">{item.title}</span>
        </div>
        {item.subtitle && <p className="text-xs text-white/50 mt-1 break-words">{item.subtitle}</p>}
        <p className="text-xs text-white/45 mt-1 break-words">
          {verb}{item.byName ? ` by ${item.byName}` : item.kind === 'master' ? ' before Trash' : ''}{item.at ? ` · ${when(item.at)}` : ''}
          {item.brandName ? ` · ${item.brandName}` : ''}{showCompany && item.companyName ? ` · ${item.companyName}` : ''}
        </p>
        {item.reason && <p className="text-xs text-white/55 mt-1 break-words">Reason: {item.reason}</p>}
        {!!item.copies?.count && (
          <p className="text-xs text-success mt-1">Copied {item.copies.count}x{item.copies.lastByName ? ` · last by ${item.copies.lastByName}` : ''}</p>
        )}
      </button>
      <div className="flex flex-wrap gap-2 sm:justify-end shrink-0">
        {open && item.canRestore && (
          <button className="s-btn-primary" disabled={busy} onClick={onRestore}>Restore</button>
        )}
        {open && item.kind === 'transaction' && (item.canCopy ? (
          <button className="s-btn-primary" disabled={busy} onClick={onCopy}>Recover as copy</button>
        ) : item.notCopyableReason ? (
          <span className="text-xs text-white/45 max-w-[16rem] self-center">{item.notCopyableReason}</span>
        ) : null)}
        {isCeo && open && (item.erasable
          ? <button className="s-btn-secondary" disabled={busy} onClick={onPurge}>Delete forever</button>
          : <button className="s-btn-secondary" disabled={busy} onClick={() => onArchive(false)}
              title="It touched the books, tax or stock, so it is archived instead of erased.">Archive</button>)}
        {isCeo && item.state === 'archived' && (
          <button className="s-btn-secondary" disabled={busy} onClick={() => onArchive(true)}>Unarchive</button>
        )}
        <button className="s-btn-ghost" onClick={onOpen}>Details</button>
      </div>
    </li>
  )
}
