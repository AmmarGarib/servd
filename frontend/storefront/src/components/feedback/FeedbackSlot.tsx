'use client'
import type { ReactNode } from 'react'
import { usePathname } from 'next/navigation'
import { isRiderPath } from '../StorefrontNav'
import { isEditorFramePath } from '../../lib/editorFrame'

// The gate for the feedback button. The button itself is content — the
// `servd:feedback` page (section `servd.feedback`, sections/servd/Feedback.tsx),
// rendered on the server by app/layout.tsx and passed in as children. Where
// it hides (sign-in, forms, ordering screens, the cooldown) the section
// decides itself; this only keeps the live one off /preview, where the
// preview page renders the draft — otherwise a preview of the feedback button
// showed two. It shows on brand domains as it always has.

export function FeedbackSlot({ children }: { children: ReactNode }) {
  const pathname = usePathname() ?? '/'
  if (pathname === '/preview' || pathname.startsWith('/preview/')) return null
  // The rider app (servd.pk/rider) is a work tool, not the storefront: no
  // servd chrome there, and the button would sit over its pinned step button.
  if (isRiderPath(pathname)) return null
  // The editor frame shows only the page being edited (the draft feedback
  // button when that is what is edited).
  if (isEditorFramePath(pathname)) return null
  return <>{children}</>
}
