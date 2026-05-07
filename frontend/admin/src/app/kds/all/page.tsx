'use client'
import { useEffect } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useKdsStore } from '../../../store/kds'
import { useKdsSocket } from '../../../hooks/useKdsSocket'
import { ordersApi } from '../../../lib/api'
import { TicketCard } from '../../../components/kds/TicketCard'
import { KdsHeader } from '../../../components/kds/KdsHeader'
import { NewOrderFlash } from '../../../components/kds/NewOrderFlash'

export default function AllOrdersPage() {
  const { orders, setOrders } = useKdsStore()
  useKdsSocket({ role: 'expediter' })

  // Initial load
  const { data } = useQuery({
    queryKey: ['orders', 'active'],
    queryFn: () =>
      ordersApi.list({
        status: 'received,confirmed,preparing,ready',
      }),
    refetchInterval: 30_000, // fallback poll every 30s
  })

  useEffect(() => {
    if (data?.data) setOrders(data.data)
  }, [data, setOrders])

  const activeOrders = orders.filter(
    (o) => !['completed', 'cancelled', 'refunded'].includes(o.status),
  )

  return (
    <div className="flex h-screen flex-col bg-kds-bg">
      <NewOrderFlash />
      <KdsHeader title="All Orders — Expediter View" />

      <div
        className="flex-1 overflow-x-auto"
        style={{ scrollbarWidth: 'none' }}
      >
        <div className="flex h-full gap-4 p-4">
          {/* Source columns */}
          {['pos', 'servd', 'ubereats', 'doordash', 'deliveroo', 'cart', 'manual'].map((source) => {
            const sourceOrders = activeOrders.filter((o) => o.source === source)
            if (sourceOrders.length === 0) return null
            return (
              <div key={source} className="flex w-72 shrink-0 flex-col gap-3">
                <div className="text-xs font-bold uppercase tracking-widest text-kds-subtext">
                  {source} ({sourceOrders.length})
                </div>
                {sourceOrders.map((order) => (
                  <TicketCard key={order.id} order={order} />
                ))}
              </div>
            )
          })}

          {activeOrders.length === 0 && (
            <div className="flex flex-1 items-center justify-center">
              <p className="text-2xl text-kds-subtext">No active orders</p>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
