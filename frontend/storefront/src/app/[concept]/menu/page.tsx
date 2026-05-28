// /<concept>/menu — the menu lives at /<concept>. This route exists to keep
// inbound deep links from the marketing pages (/brand/<slug>/menu, social,
// QR codes) from 404'ing.
//
// Permanent redirect to /<concept>; the order/menu UI is the same screen.

import { redirect } from 'next/navigation'

export default async function ConceptMenuRedirect({
  params,
}: {
  params: Promise<{ concept: string }> | { concept: string }
}) {
  const { concept } = await Promise.resolve(params as Promise<{ concept: string }>)
  redirect(`/${concept}`)
}
