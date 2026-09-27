// 404 — "this scene was cut." Browsers land here on any unmatched route,
// including stale brand slugs after a concept rename. It plays on the servd
// butter field with the crowd standing by, and offers the two ways back into
// the film: the opening shot and the browse scene.

import Link from 'next/link'
import { CrowdPoster } from '../components/party/loader/CrowdPoster'
import s from '../components/film/film.module.css'

export const metadata = {
  title: 'Not found',
}

export default function NotFound() {
  return (
    <section className={s.scene} aria-labelledby="nf-title">
      <p className={s.sceneKicker}>
        <span className={s.clapper} aria-hidden="true" />
        404 · missing reel
      </p>
      <h1 id="nf-title" className={s.sceneTitle}>this scene was cut.</h1>
      <p className={s.sceneBody}>
        the page may have moved, or that kitchen has left the lineup. the rest of the film is right where you left it.
      </p>
      <div className={s.ctaRow}>
        <Link href="/" className={s.cta}>back to the opening</Link>
        <Link href="/browse" className={s.ctaGhost}>pick a craving</Link>
      </div>
      <div className={s.scenePoster} aria-hidden="true">
        <CrowdPoster id="nf" />
      </div>
    </section>
  )
}
