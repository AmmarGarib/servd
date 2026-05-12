// servd is not currently sold as SaaS — the founder runs multiple kitchen
// operations under one deployment. The public `welcome` marketing page is
// therefore retired in favour of redirecting straight to the staff login.
//
// If you ever want to reopen public signups, restore the previous content
// from git history (commit before the FIXES.md sweep).
import { redirect } from 'next/navigation'

export default function WelcomePage() {
  redirect('/login')
}
