'use client'
import { useEffect } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useParams } from 'next/navigation'
import { useKdsStore } from '../../../store/kds'
import { useKdsSocket } from '../../../hooks/useKdsSocket'
import { ordersApi } from '../../../lib/api'
import { TicketCard } from '../../../components/kds/TicketCard'
import { KdsHeader } from '../../../components/kds/KdsHeader'
import { NewOrderFlash } from '../../../components/kds/NewOrderFlash'

export default function StationKdsPage() {
  const { station } = useParams<{ station: string }>()
  const { orders, setOrders } = useKdsStore()
  useKdsSocket({ stationId: station, role: 'kitchen' })

  const { data } = useQuery({
    queryKey: ['orders', 'active', station],
    queryFn: () => ordersApi.list({ status: 'received,confirmed,preparing' }),
    refetchInterval: 30_000,
  })

  useEffect(() => {
    if (data?.data) setOrders(data.data)
  }, [data, setOrders])

  const stationOrders = orders.filter((o) =>
    o.items.some(
      (i) => i.stationId === station && !['bumped', 'voided', 'held'].includes(i.status),
    ),
  )

  const stationName = stationOrders[0]?.items.find((i) => i.stationId === station)?.station?.name ?? station

  return (
    <div className="flex h-screen flex-col bg-kds-bg">
      <NewOrderFlash />
      <KdsHeader title={`${stationName} Station`} stationId={station} />

      <div className="flex-1 overflow-y-auto p-4">
        <div className="columns-2 gap-4 lg:columns-3 xl:columns-4">
          {stationOrders.map((order) => (
            <div key={order.id} className="mb-4 break-inside-avoid">
              <TicketCard order={order} stationId={station} />
            </div>
          ))}
        </div>

        {stationOrders.length === 0 && (
          <div className="flex h-full items-center justify-center">
            <p className="text-3xl font-bold text-kds-subtext">All clear ✓</p>
          </div>
        )}
      </div>
    </div>
  )
}
