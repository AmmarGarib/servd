import t from './tracker.module.css'

// A pot with CSS steam curls. Replaces the old hourglass emoji on the
// "preparing" step, and doubles as the big hero mark for act three. The
// curls are SVG paths animated in CSS; reduced motion shows them still.

export function PotIcon({ size = 18, steam = true, strokeWidth = 2 }: { size?: number; steam?: boolean; strokeWidth?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={t.pot}
    >
      {steam && (
        <g className={t.potSteam}>
          <path className={t.curl} d="M11 11c-1.6-1.6 1.6-3 0-4.6s1.2-2.8 0-4" />
          <path className={t.curl} d="M16 11c-1.6-1.6 1.6-3 0-4.6s1.2-2.8 0-4" />
          <path className={t.curl} d="M21 11c-1.6-1.6 1.6-3 0-4.6s1.2-2.8 0-4" />
        </g>
      )}
      <path d="M5 15h22v7.5a5.5 5.5 0 0 1-5.5 5.5h-11A5.5 5.5 0 0 1 5 22.5z" />
      <path d="M2.5 15h27" />
      <path d="M13.5 13h5" />
    </svg>
  )
}

export default PotIcon
