// Word (.docx) letters (owner, 2026-10-22: "It should give option to HR to add
// letter in word file … employee details should be picked through selected
// employee field on auto basis"; "We don't know HTML language").
//
// A .docx is a ZIP of XML parts. Three things are done with one, no library:
//   - readDocx      unzip it (central directory + zlib inflateRaw)
//   - fillDocx      replace {{placeholders}} in the body, headers and footers
//                   and zip it again — the letterhead, logo, fonts and layout
//                   HR made in Word stay exactly as they were
//   - docxToHtml    a print / preview copy: paragraphs, bold / italic /
//                   underline, alignment, tables, line breaks and pictures
//                   (as embedded images); the header on top, the footer below
//   - htmlToDocx    the other way, for a letter that has no Word file yet
//                   (the built-in wording, so HR can start from it in Word)
//
// Word splits typed text into many runs ("{{Employee" | " Name}}"), so a
// placeholder is found across the runs of ONE paragraph and written into the
// first run it starts in.

import zlib from 'node:zlib'
import { crc32, xmlEscape } from './xlsxWriter.js'
import { AppError } from './errors.js'

// ─── ZIP ─────────────────────────────────────────────────────────────────────

export interface ZipEntry { name: string; data: Buffer }

const bad = (msg = 'The Word file could not be read — save it again in Word as a .docx and upload that') => new AppError('BAD_WORD_FILE', msg, 400)

/** Every entry of a ZIP, in its stored order. Encrypted / zip64 → 400. */
export function readZip(buf: Buffer): ZipEntry[] {
  let eocd = -1
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break }
  }
  if (eocd < 0) throw bad()
  const count = buf.readUInt16LE(eocd + 10)
  let p = buf.readUInt32LE(eocd + 16)
  if (count > 2000 || p >= buf.length) throw bad()
  const out: ZipEntry[] = []
  let total = 0
  for (let n = 0; n < count; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) throw bad()
    const flags = buf.readUInt16LE(p + 8)
    const method = buf.readUInt16LE(p + 10)
    const csize = buf.readUInt32LE(p + 20)
    const usize = buf.readUInt32LE(p + 24)
    const nlen = buf.readUInt16LE(p + 28)
    const xlen = buf.readUInt16LE(p + 30)
    const clen = buf.readUInt16LE(p + 32)
    const local = buf.readUInt32LE(p + 42)
    const name = buf.subarray(p + 46, p + 46 + nlen).toString('utf8')
    p += 46 + nlen + xlen + clen
    if (flags & 1) throw bad('The Word file is password-protected — remove the password in Word and upload it again')
    if (csize === 0xffffffff || usize === 0xffffffff || local + 30 > buf.length || buf.readUInt32LE(local) !== 0x04034b50) throw bad()
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28)
    const raw = buf.subarray(start, start + csize)
    if (raw.length !== csize) throw bad()
    total += usize
    if (total > 60 * 1024 * 1024) throw bad('The Word file is too large once opened')
    let data: Buffer
    if (method === 0) data = Buffer.from(raw)
    else if (method === 8) {
      try { data = zlib.inflateRawSync(raw, { maxOutputLength: Math.max(usize, 1) }) } catch { throw bad() }
    } else throw bad()
    out.push({ name, data })
  }
  return out
}

/** A ZIP of the entries, deflated (pictures already compressed are stored). */
export function writeZip(files: ZipEntry[]): Buffer {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  for (const f of files) {
    const name = Buffer.from(f.name, 'utf8')
    const deflated = zlib.deflateRawSync(f.data)
    const store = deflated.length >= f.data.length
    const body = store ? f.data : deflated
    const crc = crc32(f.data)
    const head = (central: boolean) => {
      const h = Buffer.alloc(central ? 46 : 30)
      let o = 0
      h.writeUInt32LE(central ? 0x02014b50 : 0x04034b50, o); o += 4
      if (central) { h.writeUInt16LE(20, o); o += 2 }
      h.writeUInt16LE(20, o); o += 2
      h.writeUInt16LE(0x0800, o); o += 2
      h.writeUInt16LE(store ? 0 : 8, o); o += 2
      h.writeUInt16LE(0, o); o += 2
      h.writeUInt16LE((46 << 9) | (1 << 5) | 1, o); o += 2
      h.writeUInt32LE(crc, o); o += 4
      h.writeUInt32LE(body.length, o); o += 4
      h.writeUInt32LE(f.data.length, o); o += 4
      h.writeUInt16LE(name.length, o); o += 2
      if (central) h.writeUInt32LE(offset, 42)
      return h
    }
    locals.push(head(false), name, body)
    centrals.push(head(true), name)
    offset += 30 + name.length + body.length
  }
  const central = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(files.length, 8)
  end.writeUInt16LE(files.length, 10)
  end.writeUInt32LE(central.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, central, end])
}

/** The Word file's parts; 400 when it is not a Word document. */
export function readDocx(buf: Buffer): Map<string, Buffer> {
  const parts = new Map(readZip(buf).map((e) => [e.name, e.data]))
  if (!parts.has('word/document.xml')) throw bad('This is not a Word document (.docx)')
  return parts
}

// ─── XML text helpers ────────────────────────────────────────────────────────

const ENT: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }
export function xmlDecode(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const c = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)
      return Number.isFinite(c) && c > 0 && c <= 0x10ffff ? String.fromCodePoint(c) : ''
    }
    return ENT[e.toLowerCase()] ?? m
  })
}

const PLACEHOLDER = /\{\{([^{}\n]{1,80})\}\}/g

/**
 * Replace every {{name}} in one Word XML part. `value(name)` returns the
 * text to put in, or null to leave the placeholder as it is. Placeholders are
 * matched across the runs of a paragraph, never across paragraphs.
 */
export function fillWordXml(xml: string, value: (name: string) => string | null): string {
  // The <w:t> text nodes, plus a paragraph break marker after each </w:p>.
  type Node = { start: number; end: number; open: string; text: string; at: number }
  const nodes: Node[] = []
  let flat = ''
  const re = /<w:t(?:\s[^>]*)?\/>|<w:t(\s[^>]*)?>([\s\S]*?)<\/w:t>|<\/w:p>/g
  for (let m = re.exec(xml); m; m = re.exec(xml)) {
    if (m[0] === '</w:p>') { flat += '\n'; continue }
    if (m[0].endsWith('/>')) continue
    const text = xmlDecode(m[2] ?? '')
    nodes.push({ start: m.index, end: m.index + m[0].length, open: m[1] ?? '', text, at: flat.length })
    flat += text
  }
  const matches = Array.from(flat.matchAll(PLACEHOLDER))
  if (!matches.length) return xml
  const nodeAt = (pos: number) => nodes.findIndex((n) => pos >= n.at && pos < n.at + n.text.length)
  let changed = false
  // Last first, so earlier offsets stay right.
  for (const m of matches.reverse()) {
    const v = value(m[1]!.trim())
    if (v === null) continue
    const s = m.index!
    const e = s + m[0].length
    const a = nodeAt(s)
    const b = nodeAt(e - 1)
    if (a < 0 || b < 0) continue
    const na = nodes[a]!
    const nb = nodes[b]!
    const tailB = nb.text.slice(e - nb.at)
    if (a === b) {
      na.text = na.text.slice(0, s - na.at) + v + tailB
    } else {
      na.text = na.text.slice(0, s - na.at) + v
      for (let i = a + 1; i < b; i++) nodes[i]!.text = ''
      nb.text = tailB
    }
    changed = true
  }
  if (!changed) return xml
  let out = ''
  let last = 0
  for (const n of nodes) {
    out += xml.slice(last, n.start) + `<w:t xml:space="preserve">${xmlEscape(n.text)}</w:t>`
    last = n.end
  }
  return out + xml.slice(last)
}

const FILLABLE = /^word\/(document|header\d*|footer\d*|footnotes|endnotes)\.xml$/

/** The Word file with its placeholders filled in. */
export function fillDocx(buf: Buffer, value: (name: string) => string | null): Buffer {
  const entries = readZip(buf)
  if (!entries.some((e) => e.name === 'word/document.xml')) throw bad('This is not a Word document (.docx)')
  return writeZip(entries.map((e) => (FILLABLE.test(e.name) ? { name: e.name, data: Buffer.from(fillWordXml(e.data.toString('utf8'), value), 'utf8') } : e)))
}

/** Every {{placeholder}} the Word file uses (body, headers, footers). */
export function docxPlaceholders(buf: Buffer): string[] {
  const seen = new Set<string>()
  for (const [name, data] of readDocx(buf)) {
    if (!FILLABLE.test(name)) continue
    const names: string[] = []
    fillWordXml(data.toString('utf8'), (n) => { names.push(n); return null })
    for (const n of names) seen.add(n)
  }
  return [...seen]
}

// ─── Word → HTML (print / preview) ───────────────────────────────────────────

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const IMAGE_MIME: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif' }

function relsOf(parts: Map<string, Buffer>, part: string): Map<string, string> {
  const dir = part.slice(0, part.lastIndexOf('/'))
  const file = part.slice(part.lastIndexOf('/') + 1)
  const xml = parts.get(`${dir}/_rels/${file}.rels`)?.toString('utf8') ?? ''
  const out = new Map<string, string>()
  for (const m of xml.matchAll(/<Relationship\b([^>]*)\/?>/g)) {
    const id = /\bId="([^"]+)"/.exec(m[1]!)?.[1]
    const target = /\bTarget="([^"]+)"/.exec(m[1]!)?.[1]
    if (!id || !target || /TargetMode="External"/.test(m[1]!)) continue
    // Targets are relative to the part's folder ("media/image1.png").
    const path = target.startsWith('/') ? target.slice(1) : `${dir}/${target}`.replace(/[^/]+\/\.\.\//g, '')
    out.set(id, path)
  }
  return out
}

function runHtml(run: string, parts: Map<string, Buffer>, rels: Map<string, string>): string {
  const rpr = /<w:rPr>([\s\S]*?)<\/w:rPr>/.exec(run)?.[1] ?? ''
  const on = (tag: string) => new RegExp(`<w:${tag}(?:\\s[^>]*)?/>`).test(rpr) && !new RegExp(`<w:${tag}\\s+w:val="(?:0|false|none)"`).test(rpr)
  let inner = ''
  for (const m of run.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:tab\/>|<w:br(?:\s[^>]*)?\/>|<w:drawing>([\s\S]*?)<\/w:drawing>/g)) {
    if (m[0] === '<w:tab/>') inner += '&nbsp;&nbsp;&nbsp;&nbsp;'
    else if (m[0].startsWith('<w:br')) inner += '<br/>'
    else if (m[2] !== undefined) {
      const rid = /r:embed="([^"]+)"/.exec(m[2])?.[1]
      const path = rid ? rels.get(rid) : undefined
      const ext = path?.split('.').pop()?.toLowerCase() ?? ''
      const data = path ? parts.get(path) : undefined
      if (!data || !IMAGE_MIME[ext] || data.length > 1_500_000) continue
      const cx = Number(/<wp:extent cx="(\d+)"/.exec(m[2])?.[1] ?? 0)
      const width = cx ? Math.min(680, Math.round(cx / 9525)) : 0
      inner += `<img src="data:${IMAGE_MIME[ext]};base64,${data.toString('base64')}"${width ? ` style="width:${width}px;max-width:100%"` : ''}/>`
    } else inner += esc(xmlDecode(m[1] ?? ''))
  }
  if (!inner) return ''
  if (on('u') || /<w:u\s+w:val="(?!none)/.test(rpr)) inner = `<u>${inner}</u>`
  if (on('i')) inner = `<em>${inner}</em>`
  if (on('b')) inner = `<strong>${inner}</strong>`
  return inner
}

function paragraphHtml(p: string, parts: Map<string, Buffer>, rels: Map<string, string>): string {
  const ppr = /<w:pPr>([\s\S]*?)<\/w:pPr>/.exec(p)?.[1] ?? ''
  const jc = /<w:jc\s+w:val="(\w+)"/.exec(ppr)?.[1]
  const align = jc === 'center' ? 'center' : jc === 'right' || jc === 'end' ? 'right' : jc === 'both' ? 'justify' : null
  const bullet = /<w:numPr>/.test(ppr) ? '•&nbsp;&nbsp;' : ''
  let html = ''
  // Runs, including those inside hyperlinks / smart tags.
  for (const r of p.matchAll(/<w:r(?:\s[^>]*)?>([\s\S]*?)<\/w:r>/g)) html += runHtml(r[1]!, parts, rels)
  const style = align ? ` style="text-align:${align}"` : ''
  return `<p${style}>${bullet}${html || '&nbsp;'}</p>`
}

function blocksHtml(raw: string, parts: Map<string, Buffer>, rels: Map<string, string>): string {
  // A field Word split across runs is put back into its first run, so it
  // prints as one piece ("{{Employee" + " Name}}").
  const xml = fillWordXml(raw, (name) => `{{${name}}}`)
  let out = ''
  // Top-level tables and paragraphs in order (a table's own paragraphs are
  // handled inside it).
  const re = /<w:tbl>([\s\S]*?)<\/w:tbl>|<w:p(?:\s[^>]*)?>([\s\S]*?)<\/w:p>|<w:p(?:\s[^>]*)?\/>/g
  for (const m of xml.matchAll(re)) {
    if (m[1] !== undefined) {
      let rows = ''
      for (const tr of m[1].matchAll(/<w:tr(?:\s[^>]*)?>([\s\S]*?)<\/w:tr>/g)) {
        let cells = ''
        for (const tc of tr[1]!.matchAll(/<w:tc(?:\s[^>]*)?>([\s\S]*?)<\/w:tc>/g)) {
          const span = /<w:gridSpan\s+w:val="(\d+)"/.exec(tc[1]!)?.[1]
          cells += `<td${span ? ` colspan="${span}"` : ''}>${blocksHtml(tc[1]!, parts, rels)}</td>`
        }
        rows += `<tr>${cells}</tr>`
      }
      out += `<table>${rows}</table>`
    } else if (m[2] !== undefined) out += paragraphHtml(m[2], parts, rels)
    else out += '<p>&nbsp;</p>'
  }
  return out
}

/** A print copy of the Word letter: its default header, body and footer. */
export function docxToHtml(buf: Buffer): string {
  const parts = readDocx(buf)
  const doc = parts.get('word/document.xml')!.toString('utf8')
  const rels = relsOf(parts, 'word/document.xml')
  const body = /<w:body>([\s\S]*)<\/w:body>/.exec(doc)?.[1] ?? ''
  const sect = /<w:sectPr\b[\s\S]*?<\/w:sectPr>/.exec(body)?.[0] ?? ''
  const part = (kind: 'header' | 'footer') => {
    const id = new RegExp(`<w:${kind}Reference\\b[^>]*w:type="default"[^>]*r:id="([^"]+)"|<w:${kind}Reference\\b[^>]*r:id="([^"]+)"[^>]*w:type="default"`).exec(sect)
    const path = id ? rels.get(id[1] ?? id[2]!) : undefined
    const xml = path ? parts.get(path)?.toString('utf8') : undefined
    return path && xml ? blocksHtml(xml, parts, relsOf(parts, path)) : ''
  }
  const withoutSect = body.replace(/<w:sectPr\b[\s\S]*?<\/w:sectPr>/g, '')
  const head = part('header')
  const foot = part('footer')
  return `${head ? `<div>${head}</div>` : ''}${blocksHtml(withoutSect, parts, rels)}${foot ? `<div>${foot}</div>` : ''}`
}

// ─── HTML → Word (a letter that has no Word file yet) ────────────────────────

/** A plain Word file from letter HTML: paragraphs, headings, bold / italic /
 *  underline, line breaks, list items and table rows (cells tab-separated). */
export function htmlToDocx(html: string): Buffer {
  const paras: string[] = []
  let runs = ''
  let b = 0, i = 0, u = 0
  let center = false
  const flush = () => {
    paras.push(`<w:p>${center ? '<w:pPr><w:jc w:val="center"/></w:pPr>' : ''}${runs}</w:p>`)
    runs = ''
    center = false
  }
  const text = (t: string) => {
    if (!t) return
    const rpr = `${b ? '<w:b/>' : ''}${i ? '<w:i/>' : ''}${u ? '<w:u w:val="single"/>' : ''}`
    runs += `<w:r>${rpr ? `<w:rPr>${rpr}</w:rPr>` : ''}<w:t xml:space="preserve">${xmlEscape(t)}</w:t></w:r>`
  }
  for (const m of html.matchAll(/<(\/?)([a-z0-9]+)([^>]*)>|([^<]+)/gi)) {
    if (m[4] !== undefined) { text(xmlDecode(m[4].replace(/&nbsp;/g, ' '))); continue }
    const close = m[1] === '/'
    const tag = m[2]!.toLowerCase()
    const d = close ? -1 : 1
    if (tag === 'strong' || tag === 'b') b = Math.max(0, b + d)
    else if (tag === 'em' || tag === 'i') i = Math.max(0, i + d)
    else if (tag === 'u') u = Math.max(0, u + d)
    else if (tag === 'br') runs += '<w:r><w:br/></w:r>'
    else if (/^h[1-4]$/.test(tag)) { if (close) { b = Math.max(0, b - 1); flush() } else { if (runs) flush(); b++ } }
    else if (tag === 'li') { if (!close) { if (runs) flush(); text('•  ') } else flush() }
    else if (tag === 'td' || tag === 'th') { if (close) runs += '<w:r><w:tab/></w:r>' }
    else if (tag === 'tr' || tag === 'p' || tag === 'div') {
      if (close) flush()
      else { if (runs) flush(); center = /text-align:\s*center|align="center"/i.test(m[3] ?? '') }
    }
  }
  if (runs) flush()
  const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"'
  const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${W}><w:body>${paras.join('')}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr></w:body></w:document>`
  const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles ${W}><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Calibri"/><w:sz w:val="22"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="160" w:line="276" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults></w:styles>`
  return writeZip([
    { name: '[Content_Types].xml', data: Buffer.from('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>') },
    { name: '_rels/.rels', data: Buffer.from('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>') },
    { name: 'word/_rels/document.xml.rels', data: Buffer.from('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>') },
    { name: 'word/document.xml', data: Buffer.from(document, 'utf8') },
    { name: 'word/styles.xml', data: Buffer.from(styles, 'utf8') },
  ])
}
