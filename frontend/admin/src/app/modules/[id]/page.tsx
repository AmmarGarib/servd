import { redirect } from 'next/navigation'

// The 18-module catalogue is replaced by the five workspaces (decision 47).
// Old /modules/<id> links land on the workspace list; a workspace's own page
// is /w/<id>.
export default function OldModulePage() {
  redirect('/modules')
}
