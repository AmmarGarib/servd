// Standalone route /workforce/positions. The actual component lives in
// view.tsx — Next.js App Router rejects named exports from page.tsx beyond
// metadata/generateMetadata/dynamic, so PositionsView (used inline by the
// /workforce hub and /finance/capex) must live in a sibling file.
import { PositionsView } from './view'

export default function PositionsPage() {
  return <PositionsView />
}
