// The party sizes the booking widget offers (ReserveScreen's select). The one
// list: the server intro on /reserve/<brand> reads its largest value, so the
// words never promise a party the widget can't book.
export const PARTY_SIZES: readonly number[] = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 14, 16, 20]
export const MAX_PARTY = Math.max(...PARTY_SIZES)
