// servd.pk/ IS the servd home page (owner, 2026-10-14: search engines rank a
// site's root address for its name; the old /home now forwards here with a
// 308 in the middleware). Brand hosts never reach this: the middleware
// rewrites `/` on stackd.pk, simmer.pk and flipd.pk to their microsite first.
export { default, generateMetadata } from './home/page'

export const dynamic = 'force-dynamic'
