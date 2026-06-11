import { ImageResponse } from 'next/og'

// Default share card for the whole site (Next uses this for og:image across the
// route tree). Branded servd-purple — fixes blank previews when links are
// shared on WhatsApp/social. No static asset needed; rendered at build/request.

export const alt = 'servd — order direct from your favourite kitchens'
export const size = { width: 1200, height: 630 }
export const contentType = 'image/png'

export default function OpengraphImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          background: 'linear-gradient(135deg, #0E0618 0%, #3A0E69 100%)',
          fontFamily: 'sans-serif',
        }}
      >
        <div style={{ display: 'flex', fontSize: 200, fontWeight: 800, letterSpacing: '-8px', color: '#EDE6D3' }}>
          <span>servd</span>
          <span style={{ color: '#E94E1B' }}>.</span>
        </div>
        <div style={{ display: 'flex', fontSize: 46, color: 'rgba(237,230,211,0.85)', marginTop: 12 }}>
          real kitchens · no middlemen
        </div>
      </div>
    ),
    { ...size },
  )
}
