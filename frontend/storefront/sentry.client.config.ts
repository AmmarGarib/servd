import * as Sentry from '@sentry/nextjs'

const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN

Sentry.init({
  dsn,
  environment: process.env.NODE_ENV,
  tracesSampleRate: 0.2,
  // Read by the Replay integration once it is added below.
  replaysOnErrorSampleRate: 1.0,
  replaysSessionSampleRate: 0.05,
  enabled: !!dsn,
})

// Session Replay is NOT bundled: importing replayIntegration put rrweb (~38 KB
// gzipped, 94% unused on a normal visit) into the JS every page downloads.
// Errors are still reported from the first line; Replay is fetched from
// Sentry's CDN after the page has finished loading, and only when Sentry is
// actually configured. If that fetch fails the site carries on without it.
if (dsn && typeof window !== 'undefined') {
  const addReplay = () => {
    Sentry.lazyLoadIntegration('replayIntegration')
      .then((replayIntegration) => { Sentry.addIntegration(replayIntegration()) })
      .catch(() => { /* Replay is best-effort */ })
  }
  if (document.readyState === 'complete') addReplay()
  else window.addEventListener('load', addReplay, { once: true })
}
