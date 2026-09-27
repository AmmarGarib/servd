import { redirect } from 'next/navigation'

// The per-action "Roles & Permissions" matrix is gone (owner decision 34,
// 2026-09-27): it enforced nothing — no API route ever checked it — so
// unticking an action for a role changed no behaviour anywhere. Access is
// controlled by Module Access (enforced by the API) plus each route's role
// gate. This route stays as a redirect so bookmarks and the Configuration hub
// card still land somewhere useful.
export default function RolesPage() {
  redirect('/configuration/role-modules')
}
