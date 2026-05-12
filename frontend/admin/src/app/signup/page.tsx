// Admin signup is closed — new operators are provisioned by the CEO inside
// /configuration/users. The route exists only to redirect anyone who lands
// here from a bookmark / old link.
import { redirect } from 'next/navigation'

export default function AdminSignupPage() {
  redirect('/login')
}
