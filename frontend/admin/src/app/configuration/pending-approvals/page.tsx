import { redirect } from 'next/navigation'

// Pending signups are reviewed on /workforce (status filter "pending"), which
// already lists them and calls the same approve / reject endpoints. This
// second screen claimed to show a phone-derived PIN that no longer exists and
// approved hires with no company. It stays as a redirect for old links.
export default function PendingApprovalsPage() {
  redirect('/workforce?status=pending')
}
