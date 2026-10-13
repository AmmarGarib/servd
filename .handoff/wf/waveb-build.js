export const meta = {
  name: 'waveb-build',
  description: 'Wave B builders: one agent per brief id (args.ids), each follows its brief in the scratchpad',
  phases: [{ title: 'Build', detail: 'one builder per brief' }],
}

const SP = '/tmp/claude-0/-home-user-servd/33ef43a5-b49c-56f9-95d2-440e3a7d20b8/scratchpad/waveB'
const ids = Array.isArray(args?.ids) ? args.ids : []
if (!ids.length) return { error: 'pass args.ids' }

const extra = typeof args?.note === 'string' && args.note ? `\n\nOrchestrator note for this wave:\n${args.note}` : ''

phase('Build')
const reports = await parallel(ids.map((id) => () => agent(
  `Your brief is ${SP}/briefs/${id}.md — read it in full and follow it. ` +
  `Other builders of the same wave are editing other files at the same time: touch only the files your brief says you own, ` +
  `never run git commands that change the tree (no stash / checkout / reset / commit), never run the whole test suite. ` +
  `Your final message is your report in the brief's "Report format".` + extra,
  { label: id, phase: 'Build', model: 'opus' },
)))
return ids.map((id, i) => ({ id, report: reports[i] }))
