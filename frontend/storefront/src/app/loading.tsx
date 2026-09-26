// Default route-level loading state — the servd "food crowd" party loader:
// the crowd runs a stadium wave on the butter stage. Pure SVG + CSS, so it
// paints from the first byte of HTML, before any JS arrives.
import { PartyLoader } from '../components/party/loader/PartyLoader'

export default function Loading() {
  return <PartyLoader />
}
