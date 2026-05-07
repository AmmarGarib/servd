// Legacy URL — keep working for any external links / SEO. Redirects to the
// new brand microsite at /brand/stax.

import { redirect } from 'next/navigation'

export default function StaxLegacyRedirect() {
  redirect('/brand/stax')
}
