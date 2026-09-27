import { redirect } from 'next/navigation'

// Service hours have ONE editor (D1): /configuration/hours, over GET/PUT
// /setup/hours/:conceptId. This page edited the same ServiceHours rows through
// a second API with a different payload shape; it stays as a redirect so the
// old sidebar link and bookmarks still land somewhere useful.
export default function ServiceHoursRedirect() {
  redirect('/configuration/hours')
}
