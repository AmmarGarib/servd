// Code 128 (set B) encoder — the member barcode on a customer profile (owner,
// 2026-10-26: "link an internal barcode for that customer in marketing
// module/customer profile"). No library: the 107 bar patterns are the
// standard table; a pattern is six bar/space widths (in modules), starting
// with a bar. Set B covers printable ASCII 32–126, which holds every member
// code ('SV' + 10 digits).

const PATTERNS = [
  '212222', '222122', '222221', '121223', '121322', '131222', '122213', '122312', '132212', '221213',
  '221312', '231212', '112232', '122132', '122231', '113222', '123122', '123221', '223211', '221132',
  '221231', '213212', '223112', '312131', '311222', '321122', '321221', '312212', '322112', '322211',
  '212123', '212321', '232121', '111323', '131123', '131321', '112313', '132113', '132311', '211313',
  '231113', '231311', '112133', '112331', '132131', '113123', '113321', '133121', '313121', '211331',
  '231131', '213113', '213311', '213131', '311123', '311321', '331121', '312113', '312311', '332111',
  '314111', '221411', '431111', '111224', '111422', '121124', '121421', '141122', '141221', '112214',
  '112412', '122114', '122411', '142112', '142211', '241211', '221114', '413111', '241112', '134111',
  '111242', '121142', '121241', '114212', '124112', '124211', '411212', '421112', '421211', '212141',
  '214121', '412121', '111143', '111341', '131141', '114113', '114311', '411113', '411311', '113141',
  '114131', '311141', '411131', '211412', '211214', '211232',
]
const STOP = '2331112'
const START_B = 104

/** Bar / space widths (in modules) for `text`, quiet zones not included. Throws on a character outside ASCII 32–126. */
export function code128Widths(text: string): number[] {
  const codes: number[] = [START_B]
  for (const ch of text) {
    const c = ch.charCodeAt(0)
    if (c < 32 || c > 126) throw new Error(`Code 128 B cannot encode ${JSON.stringify(ch)}`)
    codes.push(c - 32)
  }
  let sum = START_B
  for (let i = 1; i < codes.length; i++) sum += codes[i]! * i
  codes.push(sum % 103)
  const widths: number[] = []
  for (const code of codes) for (const w of PATTERNS[code]!) widths.push(Number(w))
  for (const w of STOP) widths.push(Number(w))
  return widths
}

/** An SVG string of the barcode (black bars on white, 10-module quiet zones). */
export function code128Svg(text: string, opts: { height?: number; module?: number } = {}): string {
  const h = opts.height ?? 60
  const m = opts.module ?? 2
  const widths = code128Widths(text)
  const quiet = 10
  const total = widths.reduce((a, b) => a + b, 0) + quiet * 2
  let x = quiet
  let bars = ''
  widths.forEach((w, i) => {
    if (i % 2 === 0) bars += `<rect x="${x * m}" y="0" width="${w * m}" height="${h}"/>`
    x += w
  })
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${total * m}" height="${h}" viewBox="0 0 ${total * m} ${h}" role="img" aria-label="Barcode ${text}"><rect width="100%" height="100%" fill="#fff"/><g fill="#000">${bars}</g></svg>`
}
