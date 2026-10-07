import { redirect } from 'next/navigation'

// servd.pk → servd.pk/home, the one consumer landing page (owner, 2026-10-07).
// Brand hosts never reach this: the middleware rewrites `/` on stackd.pk,
// simmer.pk and flipd.pk to their microsite first.
export default function Root() {
  redirect('/home')
}
