// /browse while the kitchens load: the butter hero band with rounded
// placeholder bars where the headline, search and chips will land, and a few
// skeleton stickers at the real card size and tilt, so the page arrives into
// a shape it already has instead of a blank. Server component; the only
// motion is a CSS sheen, which reduced motion switches off.
import s from '../../components/party/browse/browse.module.css'

const CARDS = [0, 1, 2, 3]

export default function BrowseLoading() {
  return (
    <div className={s.page} role="status" aria-live="polite">
      <span className={s.srOnly}>Loading every kitchen</span>

      <section className={s.header} aria-hidden>
        <div className={s.headerInner}>
          <span className={`${s.skel} ${s.loadEyebrow}`} />
          <span className={`${s.skel} ${s.loadTitleBar}`} style={{ width: 'min(88%, 34rem)' }} />
          <span className={`${s.skel} ${s.loadTitleBar}`} style={{ width: 'min(62%, 24rem)' }} />
          <span className={`${s.skel} ${s.loadLead}`} style={{ width: 'min(92%, 36rem)', marginTop: '1.1rem' }} />
          <span className={`${s.skel} ${s.loadLead}`} style={{ width: 'min(70%, 26rem)' }} />
          <span className={`${s.skel} ${s.loadSearch}`} />
          <div className={s.loadChips}>
            {[0, 1, 2, 3].map((i) => (
              <span key={i} className={`${s.skel} ${s.loadChip}`} style={{ width: i === 0 ? '3.4rem' : undefined }} />
            ))}
          </div>
        </div>
      </section>

      <section className={s.gridSection} aria-hidden>
        <div className={s.inner}>
          <div className={s.grid}>
            {CARDS.map((i) => (
              <div key={i} className={s.cardWrap}>
                <div className={s.skelCard}>
                  <span className={`${s.skel} ${s.skelPhoto}`} />
                  <div className={s.skelBody}>
                    <span className={s.skel} style={{ width: '46%', height: 18 }} />
                    <span className={s.skel} style={{ width: '92%', height: 11 }} />
                    <span className={s.skel} style={{ width: '74%', height: 11 }} />
                    <div className={s.skelFoot}>
                      <span className={s.skel} style={{ width: 86, height: 32 }} />
                      <span className={s.skel} style={{ width: 70, height: 10 }} />
                    </div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>
    </div>
  )
}
