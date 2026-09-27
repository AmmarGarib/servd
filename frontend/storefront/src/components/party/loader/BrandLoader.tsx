// BrandLoader — route loading for the brand microsites and ordering pages.
// The servd butter party stays off brand pages; each brand loads in its own
// ground and its own voice (loadingLines from lib/world/voice), pure SVG + CSS
// so it paints before any JS:
//   simmer — flat tiber, lowercase, no character, no gradient, no white. The
//            one orange signal is a single dot pulsing slowly beside the line;
//            the tagline sits below the wordmark.
//   stackd — the plum field; the coffee cup on a cream sticker, sipping.
//   flipd  — mustard and diner checker; burger and fries on the counter.
// Unknown slugs (a wrong door like /checkout) get the servd hub loader.
//
// The status lines for every day-part are rendered and the server-stamped
// html[data-daypart] picks one (see DayLines), so copy is right on first paint.

import { formatBrandName } from '../../../lib/concept'
import { CrowdCameo } from '../../world/cast/CrowdCameo'
import { DayLines, PartyLoader } from './PartyLoader'
import { LoaderSignal } from './LoaderSignal'
import s from './brand.module.css'

function Simmer() {
  return (
    <>
      <p className={s.simmerMark}>simmer</p>
      <p className={s.simmerTag}>simmer down.</p>
      <div className={s.simmerRow}>
        <span className={s.simmerDot} />
        <DayLines brand="simmer" className={s.lines} />
      </div>
    </>
  )
}

function Stackd() {
  return (
    <>
      <div className={s.sticker}>
        <CrowdCameo kind="coffee" size={128} pose="sip" className={s.stackdCup} />
      </div>
      <p className={s.stackdMark}>stackd</p>
      <DayLines brand="stackd" className={s.lines} />
    </>
  )
}

function Flipd() {
  return (
    <>
      <div className={s.counter}>
        <CrowdCameo kind="burger" size={116} pose="wave" delay={0} className={s.flipdCast} />
        <CrowdCameo kind="fries" size={116} pose="cheer" delay={260} className={s.flipdCast} />
      </div>
      <p className={s.flipdMark}>{formatBrandName('Flipd')}</p>
      <DayLines brand="flipd" className={s.lines} />
    </>
  )
}

const VARIANTS: Record<string, { cls: string; art: () => JSX.Element; name: string; ground: string }> = {
  simmer: { cls: s.simmer!, art: Simmer, name: formatBrandName('simmer'), ground: '#06392F' },
  stackd: { cls: s.stackd!, art: Stackd, name: formatBrandName('stackd'), ground: 'var(--stackd-plum, #7C2946)' },
  flipd: { cls: s.flipd!, art: Flipd, name: formatBrandName('Flipd'), ground: 'var(--flipd-mustard, #FED561)' },
}

export function BrandLoader({ slug }: { slug?: string | null }) {
  const v = slug ? VARIANTS[slug] : undefined
  if (!v) return <PartyLoader />
  const Art = v.art
  return (
    <div className={`${s.wrap} ${v.cls}`} role="status" aria-live="polite">
      <LoaderSignal ground={v.ground} />
      <span className="sr-only">Loading {v.name}…</span>
      <div className={s.col} aria-hidden="true"><Art /></div>
    </div>
  )
}

export default BrandLoader
