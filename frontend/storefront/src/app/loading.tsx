// Default route-level loading state: the servd "food crowd" party loader.
// The crowd runs a stadium wave on the butter stage, server-rendered SVG +
// CSS so it paints from the first byte of HTML, before any JS arrives. The
// root template (app/template.tsx) wears the same butter while it is up, so
// the page is set down onto it rather than cutting through white.
import { PartyLoader } from '../components/party/loader/PartyLoader'

export default function Loading() {
  return <PartyLoader />
}
