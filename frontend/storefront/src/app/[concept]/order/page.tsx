// /<concept>/order — there is no cart-as-page; the cart lives as a drawer
// inside /<concept>. This route exists so a bare /<concept>/order URL
// (without an [id]) doesn't 404 — sends the user back to the menu where
// the cart drawer is one tap away.

import { redirect } from 'next/navigation'

export default async function ConceptOrderRedirect({
  params,
}: {
  params: Promise<{ concept: string }> | { concept: string }
}) {
  const { concept } = await Promise.resolve(params as Promise<{ concept: string }>)
  redirect(`/${concept}`)
}
