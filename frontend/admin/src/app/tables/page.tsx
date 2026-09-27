import { redirect } from 'next/navigation'

// Tables have ONE editor (D10): /floorplan — floors, positions, live status,
// add / delete, capacity, the manual status toggle, and a tray for tables
// that are not on a floor yet. This list page edited the same Table rows and
// left the spatial editor orphaned. Kept as a redirect for old links.
export default function TablesRedirect() {
  redirect('/floorplan')
}
