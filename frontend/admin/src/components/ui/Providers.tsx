'use client'
import { QueryCache, QueryClient, QueryClientProvider, MutationCache } from '@tanstack/react-query'
import { useState } from 'react'
import { Toaster, toast } from 'sonner'
import { ApiError } from '../../lib/api'

// The API host, for the "couldn't reach it" toast.
function apiHost(): string {
  const url = process.env['NEXT_PUBLIC_API_URL'] ?? 'http://localhost:3001'
  try { return new URL(url).host } catch { return url }
}

function describe(error: unknown): string {
  if (error instanceof ApiError) return error.message || `Request failed (${error.status})`
  // A bare network failure. lib/api.ts lets the browser's TypeError through
  // for the API; requests to other hosts (the storefront's section catalogue,
  // file storage) wrap their failures in their own errors, or opt out of the
  // toast with meta.inlineErrors and show the cause where it happened — so
  // this text is only ever about the API.
  if (error instanceof TypeError && error.message.toLowerCase().includes('fetch')) {
    return `Couldn't reach the servd API (${apiHost()}). Check your connection; if it keeps happening, the API may be down.`
  }
  if (error instanceof Error) return error.message
  return 'Something went wrong'
}

// Opt-outs from the global error toast, set per query / mutation via `meta`:
//
//   useQuery({ ..., meta: { background: true } })
//     A read the user did not ask for — the shell's brand picker and other
//     sidebar widgets. A 403 there only means "this role doesn't see that",
//     which the widget handles by hiding itself; it is not an error the user
//     can act on. (UI-13: the sidebar brand picker 403'd for every role
//     without the brand list and put a red "Role X is not allowed" toast on
//     every page.) Other failures of a background read still toast.
//
//   useMutation({ ..., meta: { inlineErrors: true } })
//   useQuery({ ..., meta: { inlineErrors: true } })
//     The screen shows the error itself (the till's ring-up and payment; the
//     Storefront editor's "the storefront didn't answer" panel), so the global
//     toast would only repeat it — or, for a request to another host, blame
//     the API for it.
declare module '@tanstack/react-query' {
  interface Register {
    queryMeta: { background?: boolean; inlineErrors?: boolean } & Record<string, unknown>
    mutationMeta: { inlineErrors?: boolean } & Record<string, unknown>
  }
}

export function Providers({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: { retry: 1, staleTime: 10_000, refetchOnWindowFocus: false },
        },
        mutationCache: new MutationCache({
          onError: (err, _vars, _ctx, mutation) => {
            if (mutation.meta?.inlineErrors) return
            toast.error(describe(err))
          },
        }),
        queryCache: new QueryCache({
          onError: (err, query) => {
            if (err instanceof ApiError && err.status === 401) return
            if (err instanceof ApiError && err.status === 403 && query.meta?.background) return
            if (query.meta?.inlineErrors) return
            toast.error(describe(err))
          },
        }),
      }),
  )

  return (
    <QueryClientProvider client={queryClient}>
      {children}
      <Toaster position="top-right" theme="dark" richColors closeButton />
    </QueryClientProvider>
  )
}
