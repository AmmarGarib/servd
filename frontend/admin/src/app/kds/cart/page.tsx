'use client'
// Cart KDS — simplified large-text layout for outdoor use
import { useEffect } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useKdsStore } from '../../../store/kds'
import { useKdsSocket } from '../../../hooks/useKdsSocket'
import { ordersApi } from '../../../lib/api'
import { useKdsActions } from '../../../hooks/useKdsSocket'

export default function CartKdsPage() {
  const { orders, setOrders } = useKdsStore()
  useKdsSocket({ role: 'kitchen' })
  const actions = useKdsActions()

  const { data } = useQuery({
    queryKey: ['orders', 'cart'],
    queryFn: () => ordersApi.list({ source: 'cart', status: 'received,confirmed,preparing' }),
    refetchInterval: 15_000,
  })

  useEffect(() => {
    if (data?.data) setOrders(data.data)
  }, [data, setOrders])

  const cartOrders = orders.filter(
    (o) => (o.source === 'cart' || o.source === 'servd') &&
      !['completed', 'cancelled'].includes(o.status),
  )

  return (
    <div className="flex h-screen flex-col bg-kds-bg">
      {/* Large header for outdoor visibility */}
      <header className="flex h-16 items-center justify-between border-b border-kds-border bg-kds-card px-6">
        <h1 className="text-2xl font-black tracking-widest text-kds-text">GARNISH STATION</h1>
        <span className="text-2xl font-bold text-kds-red">{cartOrders.length}</span>
      </header>

      <div className="flex-1 overflow-y-auto p-4">
        {cartOrders.length === 0 ? (
          <div className="flex h-full items-center justify-center">
            <p className="text-4xl font-black text-kds-green">ALL CLEAR ✓</p>
          </div>
        ) : (
          <div className="space-y-4">
            {cartOrders.map((order) => (
              <div key={order.id} className="rounded-xl border-2 border-kds-border bg-kds-card p-5">
                <div className="mb-4 flex items-center justify-between">
                  <span className="text-2xl font-black text-kds-text">
                    {order.customerName ?? 'Walk-up'}
                  </span>
                  <span className="rounded-full bg-kds-amber px-3 py-1 text-lg font-bold text-black">
                    #{order.id.slice(-4).toUpperCase()}
                  </span>
                </div>

                <div className="space-y-3">
                  {order.items
                    .filter((i) => !['bumped', 'voided'].includes(i.status))
                    .map((item) => (
                      <div key={item.id} className="flex items-center justify-between gap-4">
                        <div>
                          <p className="text-xl font-bold text-kds-text">
                            {item.quantity}× {item.name}
                          </p>
                          {item.modifiers.map((m) => (
                            <p key={m.id} className="text-base text-kds-amber">+ {m.name}</p>
                          ))}
                        </div>
                        <button
                          onClick={() => actions.bump(item.id)}
                          className="h-14 w-14 rounded-xl bg-kds-green text-2xl font-black text-white active:scale-90"
                          aria-label="Done"
                        >
                          ✓
                        </button>
                      </div>
                    ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
