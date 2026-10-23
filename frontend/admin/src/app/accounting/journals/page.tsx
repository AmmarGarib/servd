'use client'
// The approvals inbox links journal edit / cancel requests to /accounting/journals?change=<id>;
// the Journals screen lives at /accounting/journal, so send the reader there (Requests tab).
import { Suspense, useEffect } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'

function Redirect() {
  const router = useRouter()
  const params = useSearchParams()
  const change = params.get('change')
  useEffect(() => {
    router.replace(change ? `/accounting/journal?tab=requests&id=${encodeURIComponent(change)}` : '/accounting/journal?tab=journals')
  }, [router, change])
  return <div className="p-12 text-center text-sm text-s-muted">Opening Journals…</div>
}

export default function JournalsRedirect() {
  return <Suspense fallback={null}><Redirect /></Suspense>
}
