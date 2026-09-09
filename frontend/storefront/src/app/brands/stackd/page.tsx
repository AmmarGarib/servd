// Legacy URL — keep working for any external links / SEO. Redirects to the
// new brand microsite at /brand/stackd.

import { redirect } from 'next/navigation'

export default function StackdLegacyRedirect() {
  redirect('/brand/stackd')
}
