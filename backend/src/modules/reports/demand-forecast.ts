import { prisma } from '../../lib/prisma.js'

export interface DayForecast {
  date: string   // ISO date YYYY-MM-DD
  dow: number    // 0=Sun, 6=Sat
  predictedQty: number
  weatherAdjustment?: number  // 1.0 = no change; 1.15 = +15% boost
  weatherSummary?: string     // e.g., "rainy", "hot"
}

export interface ItemForecast {
  menuItemId: string
  name: string
  forecasts: DayForecast[]
  totalPredicted: number
  confidence: 'high' | 'medium' | 'low'  // based on data availability
}

// ─── Weather overlay (Open-Meteo, free, no API key) ──────────────────────────
//
// Lahore default coords. Multiplier rules (Pakistani food market intuition):
//   - Cold + rain    → +20% on warm dishes (biryani, soup, daal, hot tea)
//   - Hot (>32°C)    → +25% on cold drinks, ice cream, lassi
//                      -10% on heavy hot food
//   - Pleasant       → 1.0 (no change)
//
// Without per-item categorisation we apply a single multiplier per day to all
// items as a directional signal — operators see "rainy day, expect +15%" and
// can size prep accordingly.

interface WeatherDay {
  date: string
  tempMaxC: number
  precipMm: number
  summary: string
  multiplier: number
}

async function fetchWeather(daysAhead: number): Promise<WeatherDay[]> {
  const lat = process.env['WEATHER_LAT'] ?? '31.5204'  // Lahore default
  const lon = process.env['WEATHER_LON'] ?? '74.3587'
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&daily=temperature_2m_max,precipitation_sum&forecast_days=${Math.min(daysAhead + 1, 16)}&timezone=Asia%2FKarachi`
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(4000) })
    if (!res.ok) return []
    const data = await res.json() as {
      daily?: { time: string[]; temperature_2m_max: number[]; precipitation_sum: number[] }
    }
    const daily = data.daily
    if (!daily) return []
    return daily.time.map((d, i) => {
      const t = daily.temperature_2m_max[i] ?? 0
      const p = daily.precipitation_sum[i] ?? 0
      let summary = 'pleasant'
      let mult = 1.0
      if (p >= 5) { summary = 'rainy'; mult = 1.20 }
      else if (t >= 38) { summary = 'very hot'; mult = 1.10 }
      else if (t >= 32) { summary = 'hot'; mult = 1.05 }
      else if (t <= 12) { summary = 'cold'; mult = 1.15 }
      return { date: d, tempMaxC: t, precipMm: p, summary, multiplier: mult }
    })
  } catch {
    return []  // weather is best-effort; never blocks the forecast
  }
}

export async function getDemandForecast(opts: {
  conceptId: string
  days?: number
}): Promise<ItemForecast[]> {
  const { conceptId, days = 7 } = opts

  // Use 28 days of history (4 full weeks for day-of-week averages)
  const historyDays = 28
  const historyFrom = new Date(Date.now() - historyDays * 86_400_000)

  // Get completed order items grouped by date
  const items = await prisma.orderItem.findMany({
    where: {
      status: { not: 'voided' },
      menuItemId: { not: null },
      order: {
        conceptId,
        status: 'completed',
        placedAt: { gte: historyFrom },
      },
    },
    select: {
      menuItemId: true,
      name: true,
      quantity: true,
      order: { select: { placedAt: true } },
    },
  })

  if (items.length === 0) return []

  // Aggregate: per item, per day-of-week → total sold
  type DowBucket = { total: number; weeks: number }
  const byItem = new Map<string, { name: string; byDow: Map<number, DowBucket> }>()

  for (const item of items) {
    if (!item.menuItemId) continue
    const dow = item.order.placedAt.getDay()

    if (!byItem.has(item.menuItemId)) {
      byItem.set(item.menuItemId, { name: item.name ?? '', byDow: new Map() })
    }
    const entry = byItem.get(item.menuItemId)!
    if (!entry.byDow.has(dow)) entry.byDow.set(dow, { total: 0, weeks: 0 })
    const bucket = entry.byDow.get(dow)!
    bucket.total += item.quantity
  }

  // Count distinct weeks with sales per dow bucket (for confidence)
  // Simpler: weeks observed = historyDays / 7 = 4
  const weeksOfHistory = historyDays / 7

  const forecasts: ItemForecast[] = []
  const today = new Date()
  today.setHours(0, 0, 0, 0)

  // Pull weather for the forecast window (best-effort, may be empty)
  const weather = await fetchWeather(days)
  const weatherByDate = new Map(weather.map((w) => [w.date, w]))

  for (const [menuItemId, data] of byItem) {
    const dayForecasts: DayForecast[] = []
    let totalPredicted = 0
    let totalDaysWithData = 0

    for (let i = 0; i < days; i++) {
      const forecastDate = new Date(today.getTime() + (i + 1) * 86_400_000)
      const dow = forecastDate.getDay()
      const isoDate = forecastDate.toISOString().slice(0, 10)

      const bucket = data.byDow.get(dow)
      const baseQty = bucket ? bucket.total / weeksOfHistory : 0

      const wx = weatherByDate.get(isoDate)
      const adjusted = wx ? baseQty * wx.multiplier : baseQty
      const predictedQty = Math.round(adjusted)

      if (bucket) totalDaysWithData++
      totalPredicted += predictedQty
      dayForecasts.push({
        date: isoDate,
        dow,
        predictedQty,
        weatherAdjustment: wx?.multiplier,
        weatherSummary: wx?.summary,
      })
    }

    // Confidence: based on how many future DOWs have historical data
    const coveragePct = totalDaysWithData / days
    const confidence: 'high' | 'medium' | 'low' =
      coveragePct >= 0.8 ? 'high' : coveragePct >= 0.5 ? 'medium' : 'low'

    forecasts.push({
      menuItemId,
      name: data.name,
      forecasts: dayForecasts,
      totalPredicted,
      confidence,
    })
  }

  // Sort by total predicted descending
  return forecasts.sort((a, b) => b.totalPredicted - a.totalPredicted)
}
