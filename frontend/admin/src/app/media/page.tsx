import { redirect } from 'next/navigation'

// The media library is ONE place now: the Library tab of the storefront hub
// (decision 41). Images, videos, fonts and copy snippets all live there.
// Kept as a redirect for old links and bookmarks.
export default function MediaRedirect() {
  redirect('/storefront?tab=library')
}
