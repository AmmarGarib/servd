import Link from 'next/link'
import type { CtaButtonBlock } from '../../lib/blocks'
import { BUTTON_SIZE_PX } from '../../lib/blocks'

const STYLE: Record<CtaButtonBlock['style'], { bg: string; fg: string; shadow: string; border: string }> = {
  primary:   { bg: 'var(--servd-green)', fg: 'var(--servd-on-green)', shadow: '0 14px 36px rgba(61,31,59,0.4)', border: 'none' },
  secondary: { bg: 'var(--servd-purple)', fg: 'var(--servd-on-purple)', shadow: 'none',                       border: '1px solid var(--servd-purple)' },
  dark:      { bg: 'var(--servd-black)', fg: 'var(--servd-on-purple)',               shadow: '0 12px 30px rgba(0,0,0,0.25)',    border: 'none' },
  ghost:     { bg: 'transparent',        fg: 'var(--servd-ink)',   shadow: 'none',                            border: '1px solid transparent' },
}

export function CtaButton(block: CtaButtonBlock) {
  const s = STYLE[block.style]
  const sz = BUTTON_SIZE_PX[block.size]
  return (
    <div className="container" style={{
      display: 'flex',
      justifyContent: block.align === 'center' ? 'center' : block.align === 'right' ? 'flex-end' : 'flex-start',
    }}>
      <Link
        href={block.href}
        style={{
          display: 'flex', alignItems: 'center', justifyContent: 'center', textAlign: 'center',
          width: block.fullWidth ? '100%' : 'clamp(280px, 70vw, 560px)',
          padding: `${sz.py} ${block.fullWidth ? '1rem' : '0'}`,
          fontSize: sz.fz,
          background: s.bg, color: s.fg, border: s.border, boxShadow: s.shadow,
          fontWeight: 900, letterSpacing: '-0.01em',
          borderRadius: '999px', textDecoration: 'none',
          transition: 'transform 140ms ease, box-shadow 140ms ease',
        }}
      >
        {block.text}{block.trailingArrow ? ' →' : ''}
      </Link>
    </div>
  )
}
