// Loading state for the /order brand hub: the servd party loader on the
// butter stage. Server-rendered SVG + CSS, so it paints before JS; the root
// template sets it down and hands its butter ground over to the page.
import { PartyLoader } from '../../components/party/loader/PartyLoader'

export default function OrderHubLoading() {
  return <PartyLoader />
}
