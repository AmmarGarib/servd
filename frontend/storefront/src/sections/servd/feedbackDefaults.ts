// servd.feedback — today's copy (data only: no functions, no React).
//
// The defaults of the `servd.feedback` section (catalog.ts uses this object as
// the spec's `defaults`). It sits in its own file because the widget itself
// (Feedback.tsx, a client component on every page) falls back to it — a
// required label left empty, a CSAT list cut short — and importing the whole
// catalogue for that would ship every section's spec to every visitor.
//
// No emoji (owner, 2026-10-10: "Make sections right now with words and I'll
// have marketing design icons for us to use"): every `icon` is an optional
// image, '' = words only.

export const FEEDBACK_DEFAULTS = {
  triggerLabel: 'Feedback',
  triggerAriaLabel: '',
  menuTitle: 'Tell us anything.',
  menuSub: 'Quick honest feedback — we read every word.',
  modes: [
    { mode: 'nps', label: 'Would you recommend us?', sub: '30 sec · NPS', icon: '' },
    { mode: 'csat', label: 'How was your experience?', sub: '10 sec · CSAT', icon: '' },
    { mode: 'open', label: 'Got an idea?', sub: 'freeform', icon: '' },
  ],
  npsQuestion: 'How likely are you to recommend servd to a friend?',
  npsLow: 'Not at all',
  npsHigh: 'Very likely',
  npsPlaceholder: 'Tell us why (optional)',
  npsPlaceholderLow: 'What would have made it a 9 or 10?',
  csatQuestion: 'How was your most recent experience?',
  // Worst to best: the score sent is the position (1–5).
  csatRatings: [
    { label: 'Bad', icon: '' },
    { label: 'Meh', icon: '' },
    { label: 'OK', icon: '' },
    { label: 'Good', icon: '' },
    { label: 'Loved it', icon: '' },
  ],
  csatPlaceholder: 'Anything we should know? (optional)',
  openTitle: 'What’s on your mind?',
  openSub: 'An idea, a complaint, a wish — anything. Anonymous if you want.',
  openPlaceholder: 'Type away…',
  backLabel: 'Back',
  sendLabel: 'Send',
  sendingLabel: 'Sending…',
  doneIcon: '',
  doneTitle: 'Thanks for telling us.',
  doneBody: 'Every word lands somewhere real. We’ll do better.',
  doneLabel: 'Done',
  cooldownDays: 14,
}
