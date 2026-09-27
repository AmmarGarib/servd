import { redirect } from 'next/navigation'

// Closures have ONE editor (D2): Reservations → Closures & blockouts, over
// /reservations/blockouts. This page wrote the same ConceptBlockout rows via
// /setup/holidays, and its 'Special hours' kind was not in the BlockoutKind
// enum, so those rows never saved. (Closest kinds now: Closure, Reduced
// capacity, Private event, Custom.) Kept as a redirect for old links.
export default function HolidaysRedirect() {
  redirect('/reservations/blockouts')
}
