// 404. Browsers land here on any unmatched route, including stale brand
// slugs after a concept rename.
//
// The servd boundary material: butter ground, a cream rubber sticker card and
// three of the crowd shrugging at the missing page. On a simmer route the same
// markup is restyled by the template's `data-surface="simmer"` (forest ground,
// lowercase, no characters), so the brand bible holds here too.

import Link from 'next/link'
import { CrowdPoster } from '../components/characters/CrowdPoster'
import s from './template.module.css'

export const metadata = {
  title: 'Not found',
}

const STAR = 'M0 -12L3 -3L12 0L3 3L0 12L-3 3L-12 0L-3 -3Z'

export default function NotFound() {
  return (
    <div className={s.boundary}>
      <svg className={`${s.doodle} ${s.doodleStar}`} viewBox="-13 -13 26 26" aria-hidden="true" focusable="false"><path d={STAR} /></svg>
      <svg className={`${s.doodle} ${s.doodleSquig}`} viewBox="0 0 80 24" aria-hidden="true" focusable="false"><path d="M2 12C12 2 22 22 32 12S52 2 62 12S76 20 78 12" /></svg>

      <div className={s.card}>
        <div className={s.poster} aria-hidden="true">
          <CrowdPoster cast={['fries', 'burger', 'coffee']} mode="shrug" />
        </div>
        <p className={s.code}>404</p>
        <h1 className={s.title}>This page wandered off.</h1>
        <p className={s.body}>The link might be old, or the page moved. The kitchens are still open.</p>
        <div className={s.actions}>
          <Link href="/" className={`${s.rubber} ${s.primary}`}>Back home</Link>
          <Link href="/browse" className={s.rubber}>Browse kitchens</Link>
        </div>
      </div>
    </div>
  )
}
