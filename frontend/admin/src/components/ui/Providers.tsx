'use client'
import { QueryCache, QueryClient, QueryClientProvider, MutationCache } from '@tanstack/react-query'
import { useState } from 'react'
import { Toaster, toast } from 'sonner'
import { ApiError } from '../../lib/api'

function describe(error: unknown): string {
  if (error instanceof ApiError) return error.message || `Request failed (${error.status})`
  if (error instanceof TypeError && error.message.toLowerCase().includes('fetch')) {
    return 'Backend unreachable — is the API running?'
  }
  if (error instanceof Error) return error.message
  return 'Something went wrong'
}

export function Providers({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: { retry: 1, staleTime: 10_000, refetchOnWindowFocus: false },
        },
        mutationCache: new MutationCache({
          onError: (err) => toast.error(describe(err)),
        }),
        queryCache: new QueryCache({
          onError: (err) => {
            if (err instanceof ApiError && err.status === 401) return
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
