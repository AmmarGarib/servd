// Legacy aggregator entry — permanent redirect to /browse so older bookmarks
// and marketing links don't dead-end. Real listing with search/filters lives
// at /browse.

import { redirect } from 'next/navigation'

export default function OrderRedirect() {
  redirect('/browse')
}
