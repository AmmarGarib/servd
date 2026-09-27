// The rare cameo: a die-cut party-hat sticker slapped over one character's
// head (1 session in 8). Decorative; the eyebrow line carries the words.

export function PartyHat({ className }: { className?: string }) {
  return (
    <svg aria-hidden viewBox="0 0 64 72" className={className} focusable="false">
      {/* die-cut sticker border */}
      <path d="M32 3 L58 60 Q32 70 6 60 Z" fill="#FFF4D6" stroke="#FFF4D6" strokeWidth="9" strokeLinejoin="round" />
      {/* the cone */}
      <path d="M32 6 L55 58 Q32 67 9 58 Z" fill="#4E2A4F" stroke="#2A1A2B" strokeWidth="2.5" strokeLinejoin="round" />
      {/* stripes */}
      <path d="M22 30 Q33 35 43 29" fill="none" stroke="#FFD447" strokeWidth="5" strokeLinecap="round" />
      <path d="M15 46 Q32 53 49 45" fill="none" stroke="#FF5A3C" strokeWidth="5" strokeLinecap="round" />
      {/* pom-pom */}
      <circle cx="32" cy="6" r="6.5" fill="#FFD447" stroke="#2A1A2B" strokeWidth="2.5" />
    </svg>
  )
}
