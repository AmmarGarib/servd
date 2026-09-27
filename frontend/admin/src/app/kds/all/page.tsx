import { redirect } from 'next/navigation'

// The expediter screen is /expo (D12): the expo queue with step counters,
// fire, hand-off and reject. This view listed orders with no actions. Kept
// as a redirect because it was pinned on kitchen screens.
export default function KdsAllRedirect() {
  redirect('/expo')
}
