// A real, scannable QR code as inline SVG for printed receipts (spec §11).
//
// Synchronous on purpose (QRCode.create + our own path renderer), so the
// receipt HTML builder can call it inline. Black modules on white with a
// 4-module quiet zone; the SVG carries no script and no external reference,
// and the encoded text never reaches the markup (only the module grid does).

import QRCode from 'qrcode'

export interface QrSvgOptions {
  /** Rendered width/height in px (default 132 — fits 58 mm and 80 mm paper). */
  sizePx?: number
  /** Error correction (default 'M', as the fiscal authorities print). */
  ecLevel?: 'L' | 'M' | 'Q' | 'H'
  /** Accessible label (escaped). */
  label?: string
}

function escapeXml(s: string): string {
  return s.replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' })[c]!)
}

/**
 * `<svg …>` for `text`. Returns '' for empty text or text too long to encode
 * (the receipt then simply has no QR — never a broken one).
 */
export function renderQrSvg(text: string | null | undefined, opts: QrSvgOptions = {}): string {
  const value = (text ?? '').trim()
  if (!value) return ''
  let qr: ReturnType<typeof QRCode.create>
  try {
    qr = QRCode.create(value, { errorCorrectionLevel: opts.ecLevel ?? 'M' })
  } catch {
    return ''
  }
  const n = qr.modules.size
  const data = qr.modules.data
  const quiet = 4
  const dim = n + quiet * 2
  let d = ''
  for (let row = 0; row < n; row++) {
    let col = 0
    while (col < n) {
      if (!data[row * n + col]) { col++; continue }
      const start = col
      while (col < n && data[row * n + col]) col++
      d += `M${start + quiet} ${row + quiet}h${col - start}v1h-${col - start}z`
    }
  }
  const size = Math.max(64, Math.min(600, Math.round(opts.sizePx ?? 132)))
  const label = escapeXml(opts.label ?? 'Fiscal invoice verification QR code')
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${dim} ${dim}" shape-rendering="crispEdges" role="img" aria-label="${label}">`
    + `<rect width="${dim}" height="${dim}" fill="#ffffff"/><path fill="#000000" d="${d}"/></svg>`
}
