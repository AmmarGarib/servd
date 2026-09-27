import Link from 'next/link'
import type { CtaButtonBlock } from '../../lib/blocks'
import { BUTTON_SIZE_PX } from '../../lib/blocks'
import c from '../brand/brandChrome.module.css'

// Page-builder CTA. The look (fill, ink, rim, resting/hover/pressed shadow)
// lives in brandChrome.module.css so the button can actually lift on hover
// and squash on press — inline styles can't express either. Size and layout
// stay inline because they come straight from the block config.
const VARIANT: Record<CtaButtonBlock['style'], string> = {
  primary:   c.ctaPrimary ?? '',
  secondary: c.ctaSecondary ?? '',
  dark:      c.ctaDark ?? '',
  ghost:     c.ctaGhost ?? '',
}

export function CtaButton(block: CtaButtonBlock) {
  const sz = BUTTON_SIZE_PX[block.size]
  return (
    <div className="container" style={{
      display: 'flex',
      justifyContent: block.align === 'center' ? 'center' : block.align === 'right' ? 'flex-end' : 'flex-start',
    }}>
      <Link
        href={block.href}
        className={`${c.cta} ${VARIANT[block.style] ?? VARIANT.primary}`}
        style={{
          width: block.fullWidth ? '100%' : 'clamp(280px, 70vw, 560px)',
          maxWidth: '100%',
          padding: `${sz.py} ${block.fullWidth ? '1rem' : '0'}`,
          fontSize: sz.fz,
        }}
      >
        {block.text}
        {block.trailingArrow ? <span aria-hidden="true" className={c.arrow}>→</span> : null}
      </Link>
    </div>
  )
}
