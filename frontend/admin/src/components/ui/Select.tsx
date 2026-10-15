'use client'
// The admin's one dropdown (owner, 2026-10-15: "add a search option in bars
// with multiple options, along with the dropdown"). A drop-in for <select>:
// same children (<option> / <optgroup>), same props, and onChange still gets
// an event whose target.value is the picked value — so a page swaps
// `<select` for `<Select` and nothing else changes.
//
// Short lists (fewer than SEARCH_FROM options) stay a native <select>. Longer
// ones open as a list with a search box: type to filter, arrows + Enter to
// pick, Escape to close. The list is portalled to <body> (so modals with
// overflow or transforms never clip it) and carries the theme class of the
// area it was opened from (sidebar, dark kitchen screens).

import {
  Children, Fragment, isValidElement, useCallback, useEffect, useId, useLayoutEffect,
  useMemo, useRef, useState,
  type ChangeEvent, type CSSProperties, type ReactNode, type SelectHTMLAttributes,
} from 'react'
import { createPortal } from 'react-dom'

/** Lists with at least this many options get the search box. */
export const SEARCH_FROM = 4

const THEME_CLASSES = ['erp-kitchen-dark', 'erp-on-secondary', 'erp-on-surface']

interface Opt { value: string; label: string; disabled: boolean; hidden: boolean; group: string | null }

function textOf(node: ReactNode): string {
  if (node == null || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (isValidElement<{ children?: ReactNode }>(node)) return textOf(node.props.children)
  return ''
}

function collect(children: ReactNode, group: string | null, out: Opt[]) {
  Children.forEach(children, (child) => {
    if (!isValidElement<Record<string, unknown>>(child)) return
    const p = child.props
    if (child.type === 'option') {
      const label = textOf(p.children as ReactNode)
      out.push({
        value: p.value === undefined ? label : String(p.value),
        label,
        disabled: !!p.disabled,
        hidden: !!p.hidden,
        group,
      })
    } else if (child.type === 'optgroup') {
      collect(p.children as ReactNode, String(p.label ?? ''), out)
    } else if (child.type === Fragment) {
      collect(p.children as ReactNode, group, out)
    }
  })
}

const fold = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()

type SelectProps = SelectHTMLAttributes<HTMLSelectElement> & { children?: ReactNode }

export function Select(props: SelectProps) {
  const options = useMemo(() => {
    const out: Opt[] = []
    collect(props.children, null, out)
    return out
  }, [props.children])
  const visible = options.filter((o) => !o.hidden)
  if (props.multiple || visible.length < SEARCH_FROM) return <select {...props} />
  return <SearchSelect {...props} options={options} />
}

export default Select

function SearchSelect({
  options, value, defaultValue, onChange, onBlur, onFocus, name, required, disabled, className, style,
  id, title, autoFocus, 'aria-label': ariaLabel, 'aria-labelledby': ariaLabelledBy,
}: SelectProps & { options: Opt[] }) {
  const controlled = value !== undefined
  const first = options.find((o) => !o.disabled)?.value ?? ''
  const [inner, setInner] = useState(() => String(defaultValue ?? first))
  const current = controlled ? String(value ?? '') : inner
  // A value that matches nothing shows the first option, as a native <select> does.
  const picked = options.find((o) => o.value === current) ?? options[0] ?? null

  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const [pos, setPos] = useState<{ left: number; width: number; top?: number; bottom?: number; maxHeight: number } | null>(null)
  const [themeClass, setThemeClass] = useState('')
  const triggerRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const listId = useId()

  const shown = useMemo(() => {
    const q = fold(query.trim())
    return options.filter((o) => !o.hidden && (!q || fold(o.label).includes(q) || (o.group && fold(o.group).includes(q))))
  }, [options, query])

  const place = useCallback(() => {
    const el = triggerRef.current
    if (!el) return
    const r = el.getBoundingClientRect()
    const width = Math.min(Math.max(r.width, 240), window.innerWidth - 16)
    const left = Math.max(8, Math.min(r.left, window.innerWidth - width - 8))
    const below = window.innerHeight - r.bottom - 8
    const above = r.top - 8
    if (below >= 240 || below >= above) setPos({ left, width, top: r.bottom + 4, maxHeight: Math.min(360, below - 4) })
    else setPos({ left, width, bottom: window.innerHeight - r.top + 4, maxHeight: Math.min(360, above - 4) })
  }, [])

  const openList = (seed = '') => {
    if (disabled) return
    const themed = triggerRef.current?.closest(THEME_CLASSES.map((c) => `.${c}`).join(','))
    setThemeClass(themed ? THEME_CLASSES.filter((c) => themed.classList.contains(c)).join(' ') : '')
    setQuery(seed)
    const i = options.filter((o) => !o.hidden).findIndex((o) => o.value === current)
    setActive(seed ? 0 : Math.max(0, i))
    place()
    setOpen(true)
  }

  const close = (refocus = true) => {
    setOpen(false)
    setQuery('')
    if (refocus) triggerRef.current?.focus()
  }

  const choose = (o: Opt) => {
    if (o.disabled) return
    if (!controlled) setInner(o.value)
    if (o.value !== current && onChange) {
      const target = { value: o.value, name: name ?? '', id: id ?? '' }
      onChange({
        target, currentTarget: target, type: 'change',
        preventDefault() {}, stopPropagation() {}, persist() {},
      } as unknown as ChangeEvent<HTMLSelectElement>)
    }
    close()
  }

  useLayoutEffect(() => { if (open) searchRef.current?.focus() }, [open])

  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node
      if (panelRef.current?.contains(t) || triggerRef.current?.contains(t)) return
      close(false)
    }
    const onMove = (e: Event) => {
      if (panelRef.current && e.target instanceof Node && panelRef.current.contains(e.target)) return
      place()
    }
    document.addEventListener('pointerdown', onDown, true)
    window.addEventListener('scroll', onMove, true)
    window.addEventListener('resize', onMove)
    return () => {
      document.removeEventListener('pointerdown', onDown, true)
      window.removeEventListener('scroll', onMove, true)
      window.removeEventListener('resize', onMove)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, place])

  // Keep the highlighted row in view.
  useEffect(() => {
    if (!open) return
    listRef.current?.querySelector<HTMLElement>(`[data-idx="${active}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [active, open])

  const step = (from: number, dir: 1 | -1) => {
    for (let i = from + dir; i >= 0 && i < shown.length; i += dir) if (shown[i]?.disabled === false) return i
    return from
  }

  const onSearchKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => step(a, 1)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => step(a, -1)) }
    else if (e.key === 'Home') { e.preventDefault(); setActive(step(-1, 1)) }
    else if (e.key === 'End') { e.preventDefault(); setActive(step(shown.length, -1)) }
    else if (e.key === 'Enter') { e.preventDefault(); const o = shown[active]; if (o) choose(o) }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close() }
    else if (e.key === 'Tab') close(false)
  }

  const onTriggerKey = (e: React.KeyboardEvent) => {
    if (open) return
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter' || e.key === ' ' || e.key === 'F4') {
      e.preventDefault(); openList()
    } else if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
      e.preventDefault(); openList(e.key)
    }
  }

  let lastGroup: string | null = null
  const panel = open && pos && createPortal(
    <div ref={panelRef} className={`${themeClass} fixed z-[1000] flex flex-col rounded-lg overflow-hidden`}
      style={{
        left: pos.left, width: pos.width, top: pos.top, bottom: pos.bottom, maxHeight: Math.max(160, pos.maxHeight),
        background: 'var(--surface)', color: 'var(--text)', border: '1px solid var(--border)',
        boxShadow: '0 12px 32px rgb(var(--ink-rgb) / 0.18)',
      }}>
      <div className="p-2 border-b" style={{ borderColor: 'var(--border)' }}>
        <input ref={searchRef} value={query} placeholder="Search…" aria-label="Search options"
          role="combobox" aria-expanded aria-controls={listId} aria-autocomplete="list"
          aria-activedescendant={shown[active] ? `${listId}-${active}` : undefined}
          onChange={(e) => { setQuery(e.target.value); setActive(0) }}
          onKeyDown={onSearchKey}
          className="s-input !py-1.5" />
      </div>
      <div ref={listRef} id={listId} role="listbox" aria-label={ariaLabel ?? title ?? 'Options'} className="overflow-y-auto py-1 min-h-0 flex-1">
        {shown.length === 0 && <p className="px-3 py-2 text-sm" style={{ color: 'var(--muted)' }}>No matches</p>}
        {shown.map((o, i) => {
          const header = o.group !== lastGroup && o.group ? o.group : null
          lastGroup = o.group
          const sel = o.value === current
          return (
            <Fragment key={`${o.group ?? ''}\u0000${o.value}\u0000${i}`}>
              {header && <p className="px-3 pt-2 pb-1 text-[10px] uppercase tracking-wider font-bold" style={{ color: 'var(--muted)' }}>{header}</p>}
              <div id={`${listId}-${i}`} data-idx={i} role="option" aria-selected={sel} aria-disabled={o.disabled || undefined}
                onPointerMove={() => { if (!o.disabled && active !== i) setActive(i) }}
                onPointerDown={(e) => e.preventDefault()}
                onClick={() => choose(o)}
                className={`flex items-center gap-2 px-3 py-2 text-sm ${o.disabled ? 'opacity-40 cursor-not-allowed' : 'cursor-pointer'} ${o.group ? 'pl-5' : ''}`}
                style={{ background: i === active && !o.disabled ? 'var(--elevated)' : undefined }}>
                <span className="flex-1 min-w-0 truncate" style={sel ? { fontWeight: 600, color: 'var(--erp-primary-ink)' } : undefined}>{o.label || ' '}</span>
                {sel && (
                  <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden className="shrink-0" style={{ color: 'var(--erp-success)' }}>
                    <path d="M2.5 6.2l2.3 2.3 4.7-5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                )}
              </div>
            </Fragment>
          )
        })}
      </div>
    </div>,
    document.body,
  )

  const triggerStyle: CSSProperties = { backgroundImage: 'none', ...style, display: 'flex', alignItems: 'center', gap: 8, textAlign: 'left' }
  return (
    <>
      <button ref={triggerRef} type="button" id={id} title={title} disabled={disabled} autoFocus={autoFocus}
        aria-haspopup="listbox" aria-expanded={open} aria-label={ariaLabel} aria-labelledby={ariaLabelledBy}
        onClick={() => (open ? close() : openList())}
        onKeyDown={onTriggerKey}
        onFocus={onFocus as unknown as React.FocusEventHandler<HTMLButtonElement>}
        onBlur={onBlur as unknown as React.FocusEventHandler<HTMLButtonElement>}
        className={`${className ?? ''} ${disabled ? 'opacity-60 cursor-not-allowed' : 'cursor-pointer'}`}
        style={triggerStyle}>
        <span className="flex-1 min-w-0 truncate">{picked?.label || ' '}</span>
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden className="shrink-0 opacity-60">
          <path d="M2 3.5l3 3 3-3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {(name || required) && (
        <input tabIndex={-1} aria-hidden name={name} required={required} value={current} onChange={() => {}}
          onFocus={() => triggerRef.current?.focus()}
          style={{ position: 'absolute', opacity: 0, pointerEvents: 'none', width: 1, height: 1 }} />
      )}
      {panel}
    </>
  )
}
