'use client'
import type { CSSProperties, ReactNode } from 'react'
import type { Block } from '../../lib/blocks'
import { PADDING_PX, cssFontFamily } from '../../lib/blocks'
import { TextBody } from '../blocks/TextBody'
import { ImageBlockUi } from '../blocks/ImageBlockUi'
import { CtaButton } from '../blocks/CtaButton'
import { Banner } from '../blocks/Banner'
import { Spacer } from '../blocks/Spacer'
import { Divider } from '../blocks/Divider'
import { VideoBlockUi } from '../blocks/VideoBlockUi'
import { SignupFormBlock } from '../blocks/SignupFormBlock'
import { Animate } from '../blocks/Animate'

// Client-safe block renderer for pop-ups. Pop-ups mount in the browser, so the
// data-fetching server blocks (kitchens, featured_menu, reviews) and the
// page-only `signature` are not available here; they render nothing.

function renderBlock(block: Block, compact: boolean): ReactNode {
  switch (block.type) {
    case 'text':        return <TextBody {...block} />
    case 'image':       return <ImageBlockUi {...block} />
    case 'cta_button':  return <CtaButton {...block} />
    case 'banner':      return <Banner {...block} />
    case 'video':       return <VideoBlockUi {...block} />
    case 'signup_form': return <SignupFormBlock block={block} />
    case 'spacer':      return <Spacer {...block} />
    case 'divider':     return <Divider />
    case 'columns': {
      const cols = (Array.isArray(block.columns) ? block.columns : []).slice(0, 4)
      return (
        <div className="sv-cols" data-stack={block.stackOnMobile === false ? 'false' : 'true'}
          style={{ ['--sv-cols' as string]: String(cols.length), ['--sv-gap' as string]: '1rem' } as CSSProperties}>
          {cols.map((col, i) => (
            <div key={i} style={{ minWidth: 0 }}>
              <PopupBlocks blocks={(Array.isArray(col) ? col : []).filter((b) => b.type !== 'columns')} compact={compact} />
            </div>
          ))}
        </div>
      )
    }
    default:            return null
  }
}

export function PopupBlocks({ blocks, compact = false }: { blocks: Block[]; compact?: boolean }) {
  return (
    <>
      {blocks.filter((b) => b && !b.hidden).map((b, i) => {
        const padY = b.paddingY ?? (b.type === 'spacer' ? b.size : compact || b.type === 'divider' ? 'none' : 'sm')
        const font = cssFontFamily(b.fontFamily)
        const style: CSSProperties = {
          background: b.background ?? undefined,
          color: b.textColor ?? undefined,
          paddingTop: PADDING_PX[padY],
          paddingBottom: PADDING_PX[padY],
          ...(font && { fontFamily: font, ['--sv-heading-font' as string]: font }),
        }
        const section = (
          <div key={b.id ?? i} style={style} {...(font && { 'data-sv-font': '' })}>
            {renderBlock(b, compact)}
          </div>
        )
        if (!b.animation || b.animation === 'none') return section
        return (
          <Animate key={b.id ?? i} animation={b.animation}
            {...(b.animationDelayMs !== undefined && { delayMs: b.animationDelayMs })}
            {...(b.animationDurationMs !== undefined && { durationMs: b.animationDurationMs })}>
            {section}
          </Animate>
        )
      })}
    </>
  )
}
