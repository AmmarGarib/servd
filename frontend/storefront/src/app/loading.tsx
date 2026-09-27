// Default route-level loading state — the servd "food crowd" party loader:
// the crowd runs a stadium wave under the hour's sky (and dozes at night).
// Pure SVG + CSS, so it paints from the first byte of HTML, before any JS.
import { PartyLoader } from '../components/party/loader/PartyLoader'

export default function Loading() {
  return <PartyLoader />
}
