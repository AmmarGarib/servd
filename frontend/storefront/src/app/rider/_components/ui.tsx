'use client'
// The building blocks of servd.pk/rider. Big tap targets (riders use these
// one-handed, in gloves, in the sun), servd tokens only (--servd-* in
// globals.css), and inline SVG icons — never emoji.

import type { CSSProperties, ReactNode } from 'react'
import type { JobStage } from '../../../lib/riderApi'
import { STAGE_LABEL } from '../_lib/format'

export type Intent = 'primary' | 'secondary' | 'ghost' | 'danger'
export type Size = 'md' | 'lg' | 'xl'

const HEIGHT: Record<Size, number> = { md: 52, lg: 60, xl: 68 }
const FONT: Record<Size, number> = { md: 16, lg: 18, xl: 20 }

function intentStyle(intent: Intent): CSSProperties {
  switch (intent) {
    case 'primary':
      return { background: 'var(--servd-green)', color: 'var(--servd-on-green)', border: '2px solid var(--servd-green)' }
    case 'secondary':
      return { background: 'var(--servd-purple)', color: 'var(--servd-on-purple)', border: '2px solid var(--servd-purple)' }
    case 'ghost':
      return { background: 'transparent', color: 'var(--servd-purple)', border: '2px solid var(--servd-purple)' }
    case 'danger':
      return { background: 'var(--servd-danger)', color: 'var(--servd-on-purple)', border: '2px solid var(--servd-danger)' }
  }
}

const BUTTON_CLASS =
  'flex w-full items-center justify-center gap-2.5 rounded-2xl px-5 font-black tracking-tight '
  + 'transition-transform active:scale-[0.98] select-none'

function buttonStyle(intent: Intent, size: Size, dimmed: boolean): CSSProperties {
  return {
    ...intentStyle(intent),
    minHeight: HEIGHT[size],
    fontSize: FONT[size],
    fontFamily: 'var(--font-display)',
    opacity: dimmed ? 0.5 : 1,
    cursor: dimmed ? 'not-allowed' : 'pointer',
    WebkitTapHighlightColor: 'transparent',
  }
}

export function Spinner({ size = 20 }: { size?: number }) {
  return (
    <span
      aria-hidden="true"
      className="inline-block animate-spin rounded-full"
      style={{ width: size, height: size, border: '3px solid currentColor', borderRightColor: 'transparent' }}
    />
  )
}

export function Button({
  children, onClick, intent = 'primary', size = 'lg', busy = false, disabled = false, type = 'button', ariaLabel,
}: {
  children: ReactNode
  onClick?: () => void
  intent?: Intent
  size?: Size
  busy?: boolean
  disabled?: boolean
  type?: 'button' | 'submit'
  ariaLabel?: string
}) {
  const off = disabled || busy
  return (
    <button
      type={type}
      onClick={off ? undefined : onClick}
      disabled={off}
      aria-busy={busy || undefined}
      aria-label={ariaLabel}
      className={BUTTON_CLASS}
      style={buttonStyle(intent, size, disabled && !busy)}
    >
      {busy ? <Spinner /> : null}
      <span>{children}</span>
    </button>
  )
}

/** A link styled as a button — for maps (new tab) and tel: links. Renders a
 *  dimmed, inert button when there is nowhere to go. */
export function ButtonLink({
  children, href, intent = 'secondary', size = 'md', external = false, icon,
}: {
  children: ReactNode
  href: string | null
  intent?: Intent
  size?: Size
  external?: boolean
  icon?: ReactNode
}) {
  if (!href) {
    return (
      <span aria-disabled="true" className={BUTTON_CLASS} style={buttonStyle(intent, size, true)}>
        {icon}<span>{children}</span>
      </span>
    )
  }
  return (
    <a
      href={href}
      className={BUTTON_CLASS}
      style={buttonStyle(intent, size, false)}
      {...(external ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
    >
      {icon}<span>{children}</span>
    </a>
  )
}

export function Card({ children, tone = 'plain', className = '' }: {
  children: ReactNode
  tone?: 'plain' | 'green' | 'purple'
  className?: string
}) {
  const style: CSSProperties =
    tone === 'green'
      ? { background: 'var(--servd-green-soft)', color: 'var(--servd-green-ink)', border: '1px solid color-mix(in srgb, var(--servd-green-dark) 30%, transparent)' }
      : tone === 'purple'
        ? { background: 'var(--servd-purple)', color: 'var(--servd-on-purple)', border: '1px solid var(--servd-purple)' }
        : { background: 'var(--servd-surface)', color: 'var(--servd-ink)', border: '1px solid var(--servd-line)' }
  return <section className={`rounded-3xl p-4 ${className}`.trim()} style={style}>{children}</section>
}

export function Label({ children, color }: { children: ReactNode; color?: string }) {
  return (
    <p className="mb-1.5 text-[12px] font-black uppercase tracking-[0.14em]" style={{ color: color ?? 'var(--servd-mute)' }}>
      {children}
    </p>
  )
}

export type BannerTone = 'info' | 'strong' | 'danger' | 'success'

export function Banner({ tone = 'info', title, children, action }: {
  tone?: BannerTone
  title: ReactNode
  children?: ReactNode
  action?: ReactNode
}) {
  const style: CSSProperties =
    tone === 'strong'
      ? { background: 'var(--servd-purple)', color: 'var(--servd-on-purple)', border: '2px solid var(--servd-purple)' }
      : tone === 'danger'
        ? { background: 'color-mix(in srgb, var(--servd-danger) 9%, var(--servd-bg))', color: 'var(--servd-ink)', border: '2px solid var(--servd-danger)' }
        : tone === 'success'
          ? { background: 'var(--servd-green-soft)', color: 'var(--servd-green-ink)', border: '2px solid var(--servd-green-dark)' }
          : { background: 'color-mix(in srgb, var(--servd-purple) 7%, var(--servd-bg))', color: 'var(--servd-ink)', border: '2px solid color-mix(in srgb, var(--servd-purple) 30%, transparent)' }
  const titleColor = tone === 'danger' ? 'var(--servd-danger)' : undefined
  return (
    <div role={tone === 'danger' ? 'alert' : 'status'} className="rounded-2xl px-4 py-3.5" style={style}>
      <p className="text-[16px] font-black leading-snug" style={{ color: titleColor }}>{title}</p>
      {children ? <div className="mt-1 text-[15px] leading-snug" style={{ opacity: 0.92 }}>{children}</div> : null}
      {action ? <div className="mt-3">{action}</div> : null}
    </div>
  )
}

export function StageBadge({ stage, large = false }: { stage: JobStage; large?: boolean }) {
  const style: CSSProperties =
    stage === 'offered'
      ? { background: 'var(--servd-green)', color: 'var(--servd-on-green)' }
      : stage === 'accepted'
        ? { background: 'color-mix(in srgb, var(--servd-purple) 14%, var(--servd-bg))', color: 'var(--servd-purple)' }
        : stage === 'picked_up'
          ? { background: 'var(--servd-purple)', color: 'var(--servd-on-purple)' }
          : { background: 'var(--servd-black)', color: 'var(--servd-on-purple)' }
  return (
    <span
      className={`inline-flex items-center rounded-full font-black uppercase tracking-[0.1em] ${large ? 'px-3.5 py-1.5 text-[13px]' : 'px-2.5 py-1 text-[11px]'}`}
      style={style}
    >
      {STAGE_LABEL[stage] ?? stage}
    </span>
  )
}

// ─── Icons (inline SVG, currentColor) ────────────────────────────────────────

const ICON = {
  fill: 'none', stroke: 'currentColor', strokeWidth: 2.2,
  strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true,
}

export function PhoneIcon({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" {...ICON}>
      <path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1.9.4 1.8.7 2.7a2 2 0 0 1-.5 2.1L8 9.8a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.7.7a2 2 0 0 1 1.7 2z" />
    </svg>
  )
}

export function NavigateIcon({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" {...ICON}>
      <polygon points="3 11 22 2 13 21 11 13 3 11" />
    </svg>
  )
}

export function PinIcon({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" {...ICON}>
      <path d="M12 21s-7-6.2-7-11.5a7 7 0 0 1 14 0C19 14.8 12 21 12 21z" />
      <circle cx="12" cy="9.5" r="2.5" />
    </svg>
  )
}

export function ChevronIcon({ size = 20, dir = 'right' }: { size?: number; dir?: 'left' | 'right' }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" {...ICON}>
      <path d={dir === 'right' ? 'M9 6l6 6-6 6' : 'M15 6l-6 6 6 6'} />
    </svg>
  )
}

export function CheckIcon({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" {...ICON}>
      <path d="M5 12.5l4.5 4.5L19 7.5" />
    </svg>
  )
}
