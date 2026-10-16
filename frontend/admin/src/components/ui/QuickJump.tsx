'use client'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { usePermissions } from '../../hooks/useCan'
import { useMyWorkspaces } from '../../hooks/useWorkspaces'
import { MODULE_PAGES, PERSONAL_PAGES, canOpenPath } from '../../lib/moduleCatalog'
import type { ModuleId } from '../../lib/appRoles'
import { useDialog } from './Modal'
import { NavIcon } from './NavIcon'

/**
 * Quick-jump (UX-7, owner 2026-10-16): Ctrl/Cmd+K, or the search button, opens a
 * box that searches PAGES only — never orders, customers or suppliers. The list
 * is the pages this login can open: the modules of its workspaces
 * (useMyWorkspaces, view-as aware — the same source as the sidebar) through
 * lib/moduleCatalog.ts, then filtered once more with canOpenPath.
 */
interface Entry { href: string; label: string; where: string; icon?: string; hint?: string }

function usePages(): Entry[] {
  const { data: me } = usePermissions()
  const { workspaces } = useMyWorkspaces()
  return useMemo(() => {
    const out = new Map<string, Entry>()
    const allowed = me ? (p: string) => canOpenPath(p, me.role, me.modules ?? []) : () => false
    for (const w of workspaces) {
      out.set(w.id === 'ceo' ? '/ceo' : `/w/${w.id}`, { href: w.id === 'ceo' ? '/ceo' : `/w/${w.id}`, label: `${w.title} home`, where: w.title, icon: 'home' })
      for (const sec of w.sections) {
        for (const m of sec.modules) {
          for (const p of MODULE_PAGES[m as ModuleId] ?? []) {
            const path = p.href.split('?')[0]!
            if (out.has(p.href) || !allowed(path)) continue
            out.set(p.href, { href: p.href, label: p.label, where: `${w.title} · ${sec.title}`, icon: p.icon, hint: p.hint })
          }
        }
      }
    }
    for (const p of PERSONAL_PAGES) {
      if (!out.has(p.href)) out.set(p.href, { href: p.href, label: p.label, where: 'Me', hint: p.hint })
    }
    return Array.from(out.values())
  }, [workspaces, me])
}

function score(e: Entry, q: string): number {
  const label = e.label.toLowerCase()
  if (label === q) return 100
  if (label.startsWith(q)) return 80
  if (label.split(/\s+/).some((w) => w.startsWith(q))) return 60
  if (label.includes(q)) return 40
  if (e.where.toLowerCase().includes(q) || (e.hint ?? '').toLowerCase().includes(q)) return 15
  return 0
}

export function QuickJump({ open, onClose }: { open: boolean; onClose: () => void }) {
  if (!open) return null
  return <QuickJumpPanel onClose={onClose} />
}

function QuickJumpPanel({ onClose }: { onClose: () => void }) {
  const router = useRouter()
  const pages = usePages()
  const [q, setQ] = useState('')
  const [idx, setIdx] = useState(0)
  const panelRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLUListElement>(null)
  useDialog(panelRef, { onClose, initialFocusRef: inputRef })

  const results = useMemo(() => {
    const t = q.trim().toLowerCase()
    if (!t) return pages.slice(0, 40)
    return pages.map((e) => ({ e, s: score(e, t) })).filter((x) => x.s > 0).sort((a, b) => b.s - a.s).map((x) => x.e).slice(0, 40)
  }, [pages, q])

  useEffect(() => { setIdx(0) }, [q])
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-i="${idx}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [idx])

  function go(e: Entry | undefined) {
    if (!e) return
    onClose()
    router.push(e.href)
  }

  return (
    <div className="fixed inset-0 z-[80] flex items-start justify-center px-4 pt-[12vh]" style={{ background: 'rgb(var(--ink-rgb) / 0.45)' }}
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div ref={panelRef} role="dialog" aria-modal="true" aria-label="Jump to a page"
        className="w-full max-w-lg overflow-hidden rounded-2xl shadow-2xl"
        style={{ background: 'var(--surface)', border: '1px solid var(--border)', color: 'var(--text)' }}>
        <div className="flex items-center gap-2 px-4" style={{ borderBottom: '1px solid var(--border)' }}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" aria-hidden="true" style={{ color: 'var(--muted)' }}>
            <circle cx="11" cy="11" r="7" /><path d="M20 20l-3.5-3.5" />
          </svg>
          <input ref={inputRef} value={q} onChange={(e) => setQ(e.target.value)}
            role="combobox" aria-expanded="true" aria-controls="quickjump-list" aria-autocomplete="list"
            aria-activedescendant={results[idx] ? `quickjump-${idx}` : undefined}
            aria-label="Search pages" placeholder="Jump to a page…" autoComplete="off" spellCheck={false}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') { e.preventDefault(); setIdx((i) => Math.min(results.length - 1, i + 1)) }
              else if (e.key === 'ArrowUp') { e.preventDefault(); setIdx((i) => Math.max(0, i - 1)) }
              else if (e.key === 'Enter') { e.preventDefault(); go(results[idx]) }
            }}
            className="h-12 flex-1 bg-transparent text-sm outline-none" style={{ color: 'var(--text)' }} />
          <kbd className="hidden rounded px-1.5 py-0.5 text-xs sm:block" style={{ background: 'var(--elevated)', color: 'var(--muted)' }}>Esc</kbd>
        </div>
        <ul ref={listRef} id="quickjump-list" role="listbox" aria-label="Pages" className="max-h-[50vh] overflow-y-auto py-1">
          {results.length === 0 && <li className="px-4 py-6 text-center text-sm" style={{ color: 'var(--muted)' }}>No page matches &ldquo;{q}&rdquo;.</li>}
          {results.map((e, i) => (
            <li key={e.href} id={`quickjump-${i}`} data-i={i} role="option" aria-selected={i === idx}
              onMouseMove={() => setIdx(i)} onClick={() => go(e)}
              className="flex cursor-pointer items-center gap-3 px-4 py-2.5"
              style={i === idx ? { background: 'rgb(var(--erp-primary-rgb) / 0.08)' } : undefined}>
              <span className="flex w-5 justify-center" style={{ color: 'var(--muted)' }}><NavIcon name={e.icon} size={16} /></span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-semibold">{e.label}</span>
                <span className="block truncate text-xs" style={{ color: 'var(--muted)' }}>{e.where}</span>
              </span>
              {i === idx && <span className="text-xs" style={{ color: 'var(--muted)' }}>Enter</span>}
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}
