// Use-by dates on perishable stock (owner B6, 2026-10-26: "Use-by date on deliveries of perishable items, plus an
// expiring-soon list and bell notice").
//
//   • A use-by is a KARACHI DAY, stored on StockLot.useBy (DATE) as a UTC-midnight Date of that day.
//   • Perishable = the item's `perishable` (a MIRROR of its servd ingredient master's definition — lib/ingredientMaster.ts
//     MASTER_FIELDS; an unlinked item keeps its own). A delivery line of a perishable item must carry a use-by (422
//     USE_BY_REQUIRED at the dock), unless the item has a shelf life: then it defaults to received day + shelfLifeDays.
//   • Record + report only: FIFO order and costing never read it.

import { AppError } from './errors.js'

const DAY_MS = 86_400_000

/** The Karachi calendar day of an instant, 'YYYY-MM-DD'. */
export function karachiDay(at: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Karachi', year: 'numeric', month: '2-digit', day: '2-digit' }).format(at)
}

/** 'YYYY-MM-DD' → the UTC-midnight Date Prisma stores in a DATE column. 422 USE_BY_INVALID for anything else. */
export function dayToDate(day: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new AppError('USE_BY_INVALID', 'A use-by date is a day (YYYY-MM-DD)', 422)
  const d = new Date(`${day}T00:00:00.000Z`)
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== day) throw new AppError('USE_BY_INVALID', `${day} is not a date`, 422)
  return d
}

/** A stored DATE back to 'YYYY-MM-DD'. */
export function dateToDay(d: Date): string {
  return d.toISOString().slice(0, 10)
}

/** 'YYYY-MM-DD' + n days. */
export function addDays(day: string, n: number): string {
  return dateToDay(new Date(dayToDate(day).getTime() + n * DAY_MS))
}

/**
 * THE use-by of a delivery line: the typed day; else, for an item with a shelf life, received day + shelf life; else
 * null (a non-perishable item), or 422 USE_BY_REQUIRED when `required` and the item is perishable with no shelf life.
 */
export function useByForReceipt(item: { id?: string; name: string; perishable: boolean; shelfLifeDays: number | null }, typed: string | null | undefined, receivedAt: Date, required: boolean): Date | null {
  if (typed) return dayToDate(typed)
  if (item.shelfLifeDays != null && item.shelfLifeDays > 0 && item.perishable) return dayToDate(addDays(karachiDay(receivedAt), item.shelfLifeDays))
  if (item.perishable && required) {
    throw new AppError('USE_BY_REQUIRED', `${item.name} is perishable — enter its use-by date`, 422, { inventoryItemId: item.id ?? null })
  }
  return null
}
