'use client'

// Course controls for an order. Items are grouped by course; the kitchen
// fires course 2 only after course 1 is done eating. Server hits "Fire
// course N" to flip those items from pending → preparing.

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useParams } from 'next/navigation'
import Link from 'next/link'
import { api } from '../../../../lib/api'

interface CourseGroup {
  course: number
  fired: boolean
  complete: boolean
  items: Array<{ id: string; name: string; quantity: number; status: string; firedAt: string | null; completedAt: string | null }>
}

export default function CoursePage() {
  const { id } = useParams<{ id: string }>()
  const qc = useQueryClient()

  const { data, isLoading } = useQuery({
    queryKey: ['order-courses', id],
    queryFn: () => api.get<CourseGroup[]>(`/orders/${id}/courses`),
    refetchInterval: 5000,
  })

  const fire = useMutation({
    mutationFn: (course: number) => api.post(`/orders/${id}/fire-course`, { course }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['order-courses', id] }),
  })

  return (
    <div className="min-h-screen bg-s-bg">
      <header className="sticky top-0 z-10 bg-s-bg/80 backdrop-blur border-b border-s-border px-6 py-4">
        <Link href={`/orders/${id}`} className="text-xs text-s-muted hover:text-s-text">← Order</Link>
        <h1 className="text-xl font-bold text-s-text">Course controls</h1>
        <p className="text-xs text-s-muted">Fire courses one at a time so the kitchen paces with the table.</p>
      </header>

      <div className="p-6 max-w-3xl mx-auto space-y-3">
        {isLoading && <p className="text-s-muted text-sm">Loading…</p>}
        {data?.map((g) => (
          <section key={g.course} className="s-card overflow-hidden">
            <div className="px-4 py-3 border-b border-s-border bg-s-bg-soft flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className={`h-3 w-3 rounded-full ${g.complete ? 'bg-s-teal' : g.fired ? 'bg-s-amber' : 'bg-gray-300'}`} />
                <h2 className="text-sm font-bold">Course {g.course}</h2>
                <span className="text-xs text-s-muted">
                  {g.complete ? 'complete' : g.fired ? 'in kitchen' : 'pending'}
                </span>
              </div>
              {!g.fired && (
                <button onClick={() => fire.mutate(g.course)} disabled={fire.isPending} className="s-btn-primary text-xs">
                  Fire course →
                </button>
              )}
            </div>
            <div className="divide-y divide-s-border">
              {g.items.map((it) => (
                <div key={it.id} className="px-4 py-2 flex items-center justify-between text-sm">
                  <span>
                    {it.quantity}× {it.name}
                  </span>
                  <span className="text-xs text-s-muted">{it.status}</span>
                </div>
              ))}
            </div>
          </section>
        ))}
      </div>
    </div>
  )
}
