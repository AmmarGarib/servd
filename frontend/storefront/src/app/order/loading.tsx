// Loading state for the brand hub — the servd title card for /order with the
// crowd running its wave (pure SVG + CSS, renders before JS).
import { PartyLoader } from '../../components/party/loader/PartyLoader'
import { cutTitleFor } from '../../lib/film/cut'

export default function OrderHubLoading() {
  return <PartyLoader chapter={cutTitleFor('/order')} />
}
