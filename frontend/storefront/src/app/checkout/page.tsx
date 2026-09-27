'use client'
import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useCart } from '../../store/cart'
import { EmptyBagScene } from '../../components/checkout/EmptyBagScene'

// /checkout — the hub-level checkout door. Checkout itself lives per kitchen
// at /<concept>/checkout (single-concept cart), so this route only routes:
//   - a cart with items and a kitchen → hand over to that kitchen's checkout
//   - anything else → the empty-bag scene (never the [concept] fallthrough
//     with slug "checkout", which rendered a plain white "not live" page)
//
// The cart store rehydrates from localStorage on the client, so the server
// render and first client paint both show the scene; the redirect decision
// waits for mount to avoid a hydration mismatch.

export default function CheckoutIndexPage() {
  const router = useRouter()
  const items = useCart((s) => s.items)
  const conceptSlug = useCart((s) => s.conceptSlug)
  const [mounted, setMounted] = useState(false)

  useEffect(() => { setMounted(true) }, [])

  const handoff = mounted && items.length > 0 && !!conceptSlug

  useEffect(() => {
    if (handoff && conceptSlug) router.replace('/' + conceptSlug + '/checkout')
  }, [handoff, conceptSlug, router])

  // While handing off, keep the brand's scene on screen (it is the same
  // palette the kitchen's checkout opens on) rather than flashing blank.
  return <EmptyBagScene slug={mounted ? conceptSlug : null} />
}
