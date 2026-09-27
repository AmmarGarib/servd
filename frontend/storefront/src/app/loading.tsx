'use client'
// Default route-level loading state: the servd title card the cut holds on
// for this destination (same field, type and composition), with the food
// crowd running its stadium wave on the floor. Because the cut reveals onto
// exactly this frame, cover → loading → reveal reads as one continuous shot.
// Pure SVG + CSS underneath, so it still paints from the first byte of HTML.
import { usePathname } from 'next/navigation'
import { PartyLoader } from '../components/party/loader/PartyLoader'
import { cutTitleFor, statusFor } from '../lib/film/cut'

export default function Loading() {
  const pathname = usePathname() ?? '/'
  return <PartyLoader chapter={cutTitleFor(pathname)} status={statusFor(pathname)} />
}
