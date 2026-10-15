'use client'
import { Modal } from '../ui/Modal'
import { useTrashDetail, type TrashItem } from '../../lib/trash'
import { StateBadge, when } from './TrashRow'

export function TrashDetail({ item, typeLabel, isCeo, busy, onClose, onRestore, onCopy, onPurge, onArchive, onOpenParent }: {
  item: TrashItem; typeLabel: string; isCeo: boolean; busy: boolean; onClose: () => void
  onRestore: () => void; onCopy: () => void; onPurge: () => void; onArchive: (undo: boolean) => void
  onOpenParent: (p: { type: string; id: string }) => void
}) {
  const { data, isLoading, error } = useTrashDetail(item.type, item.id)
  const open = item.state === 'in_trash'
  const h = 'text-[11px] font-black uppercase tracking-wider text-white/45 mb-1'
  return (
    <Modal wide title={<span className="break-words">{item.title}</span>} onClose={onClose}
      footer={
        <div className="flex flex-wrap justify-end gap-2">
          {open && item.canRestore && <button className="s-btn-primary" disabled={busy} onClick={onRestore}>Restore</button>}
          {open && item.kind === 'transaction' && item.canCopy && <button className="s-btn-primary" disabled={busy} onClick={onCopy}>Recover as copy</button>}
          {isCeo && open && (item.erasable
            ? <button className="s-btn-secondary" disabled={busy} onClick={onPurge}>Delete forever</button>
            : <button className="s-btn-secondary" disabled={busy} onClick={() => onArchive(false)}>Archive</button>)}
          <button className="s-btn-ghost" onClick={onClose}>Close</button>
        </div>
      }>
      <div className="flex flex-wrap items-center gap-2">
        <span className="s-badge-purple">{typeLabel}</span><StateBadge item={item} />
      </div>
      <p className="text-xs text-white/50">
        {item.at ? when(item.at) : ''}{item.byName ? ` · by ${item.byName}` : ''}{item.reason ? ` · ${item.reason}` : ''}
      </p>
      {isLoading && <p className="text-sm text-white/40">Loading…</p>}
      {error && <p className="text-sm" style={{ color: 'var(--erp-danger)' }}>Could not load details: {(error as Error).message}</p>}
      {data?.parent?.inTrash && (
        <div className="rounded-xl p-3 text-sm" style={{ background: 'color-mix(in srgb, var(--erp-warning) 12%, transparent)', border: '1px solid var(--border)' }}>
          <p className="text-white/80">Its {data.parent.title ? `parent "${data.parent.title}"` : 'parent'} is in the Trash too.</p>
          <button className="s-btn-secondary mt-2" onClick={() => onOpenParent(data.parent!)}>Restore {data.parent.title || 'the parent'} first</button>
        </div>
      )}
      {!!data?.preview?.length && (
        <div><p className={h}>What it held</p>
          <dl className="grid grid-cols-[minmax(0,40%)_1fr] gap-x-3 gap-y-1 text-sm">
            {data.preview.map((f) => (<div key={f.label} className="contents"><dt className="text-white/50 break-words">{f.label}</dt><dd className="text-white/85 break-words">{f.value || '—'}</dd></div>))}
          </dl>
        </div>
      )}
      {!!data?.references?.length && (
        <div><p className={h}>Still pointing at it</p>
          <ul className="text-sm space-y-1">{data.references.map((r) => (<li key={r.label} className="flex justify-between text-white/80"><span>{r.label}</span><span className="font-bold">{r.count}</span></li>))}</ul>
        </div>
      )}
      {!!data?.copyHistory?.length && (
        <div><p className={h}>Copies</p>
          <ul className="text-sm space-y-1 text-white/80">{data.copyHistory.map((c, i) => (<li key={i}>{when(c.at)}{c.byName ? ` · ${c.byName}` : ''}</li>))}</ul>
        </div>
      )}
      {!!data?.history?.length && (
        <div><p className={h}>History</p>
          <ul className="text-sm space-y-1 text-white/80">{data.history.map((x, i) => (<li key={i}>{when(x.at)} · {x.action}{x.byName ? ` · ${x.byName}` : ''}{x.note ? ` · ${x.note}` : ''}</li>))}</ul>
        </div>
      )}
    </Modal>
  )
}
