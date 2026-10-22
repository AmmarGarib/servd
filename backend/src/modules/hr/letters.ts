// HR letters (spec §26).
//
// A letter is HTML with {{placeholders}}. The defaults below are deliberately
// plain — they exist so every letter works on day one, and the HR team replaces
// them with their own formats in admin. Placeholders are filled from the
// employee, the company, the record the letter is about, and today's date.
//
// Every value is HTML-escaped. A name like "Ali <script>" prints as text, and
// the template itself is sanitised (below).

export interface LetterDefault { key: string; title: string; body: string }

const SIGN = `<p>Regards,</p><p><strong>Human Resources</strong><br/>{{company.name}}</p>`
const GRATUITY_ROW = `<tr><td>Gratuity</td><td>{{record.gratuity}}</td></tr>`
// The days the salary pays for (owner, 2026-10-21), from the settlement's pay basis.
const DAYS_ROW = `<tr><td>Days paid</td><td>{{record.daysPaid}}</td></tr>`
const HEAD = `<p>{{today}}</p><p><strong>{{employee.fullName}}</strong><br/>{{employee.designation}}, {{employee.department}}<br/>Employee ID: {{employee.employeeCode}}</p>`

export const DEFAULT_LETTERS: LetterDefault[] = [
  { key: 'offer_letter', title: 'Offer letter', body: `<p>{{today}}</p><p>Dear {{record.candidateName}},</p><p>We are pleased to offer you the position of <strong>{{record.designation}}</strong> at {{company.name}}, with a gross monthly salary of <strong>{{record.salaryOffered}}</strong>, starting on {{record.joiningDate}}.</p><p>You will be on probation for {{record.probationMonths}} months. This offer is valid until {{record.offerExpiry}}.</p>${SIGN}` },
  { key: 'appointment_letter', title: 'Appointment / employment letter', body: `${HEAD}<p>Dear {{employee.fullName}},</p><p>We are pleased to confirm your appointment as <strong>{{employee.designation}}</strong> in {{employee.department}}, {{employee.branch}}, effective {{employee.joiningDate}}, at a gross monthly salary of {{employee.grossSalary}}.</p>${SIGN}` },
  { key: 'confirmation_letter', title: 'Confirmation letter', body: `${HEAD}<p>Dear {{employee.fullName}},</p><p>Following your probation review, we are pleased to confirm your employment with effect from {{employee.confirmationDate}}.</p>${SIGN}` },
  { key: 'probation_extension_letter', title: 'Probation extension letter', body: `${HEAD}<p>Dear {{employee.fullName}},</p><p>Your probation period has been extended until {{record.extendTo}}.</p>${SIGN}` },
  { key: 'salary_revision_letter', title: 'Salary revision letter', body: `${HEAD}<p>Dear {{employee.fullName}},</p><p>Your gross monthly salary is revised to <strong>{{record.revisedGross}}</strong> with effect from {{record.effectiveDate}}.</p>${SIGN}` },
  { key: 'promotion_letter', title: 'Promotion letter', body: `${HEAD}<p>Dear {{employee.fullName}},</p><p>Congratulations — you are promoted to <strong>{{record.newDesignation}}</strong> with effect from {{record.effectiveDate}}.</p>${SIGN}` },
  { key: 'transfer_letter', title: 'Transfer letter', body: `${HEAD}<p>Dear {{employee.fullName}},</p><p>You are transferred to {{record.newLocation}} with effect from {{record.effectiveDate}}.</p>${SIGN}` },
  { key: 'warning_letter', title: 'Warning letter', body: `${HEAD}<p>Dear {{employee.fullName}},</p><p>This letter is a formal warning regarding: {{record.description}}</p>${SIGN}` },
  { key: 'show_cause_notice', title: 'Show cause notice', body: `${HEAD}<p>Dear {{employee.fullName}},</p><p>You are required to explain in writing, within three days, the following: {{record.description}}</p>${SIGN}` },
  { key: 'termination_letter', title: 'Termination letter', body: `${HEAD}<p>Dear {{employee.fullName}},</p><p>Your employment with {{company.name}} ends on {{record.lastWorkingDay}}. Reason: {{record.reason}}</p>${SIGN}` },
  { key: 'resignation_acceptance', title: 'Resignation acceptance', body: `${HEAD}<p>Dear {{employee.fullName}},</p><p>We accept your resignation. Your last working day will be {{record.lastWorkingDay}}.</p>${SIGN}` },
  { key: 'experience_letter', title: 'Experience letter', body: `<p>{{today}}</p><p><strong>To whom it may concern</strong></p><p>This is to certify that {{employee.fullName}} (CNIC {{employee.cnic}}) worked with {{company.name}} as {{employee.designation}} from {{employee.joiningDate}} to {{employee.lastWorkingDay}}.</p>${SIGN}` },
  { key: 'relieving_letter', title: 'Relieving letter', body: `${HEAD}<p>Dear {{employee.fullName}},</p><p>You are relieved of your duties with effect from {{employee.lastWorkingDay}}, all clearances having been completed.</p>${SIGN}` },
  { key: 'final_settlement_statement', title: 'Full & final statement', body: `${HEAD}<p>Full and final settlement:</p><table>${DAYS_ROW}<tr><td>Salary payable</td><td>{{record.salaryPayable}}</td></tr><tr><td>OT payable</td><td>{{record.otPayable}}</td></tr><tr><td>Leave encashment</td><td>{{record.leaveEncashment}}</td></tr>${GRATUITY_ROW}<tr><td>Deductions</td><td>{{record.deductions}}</td></tr><tr><td>Loan recovery</td><td>{{record.loanRecovery}}</td></tr><tr><td>Income tax</td><td>{{record.incomeTax}}</td></tr><tr><td>EOBI (employee share)</td><td>{{record.eobiEmployee}}</td></tr><tr><td>Other adjustments</td><td>{{record.otherAdjustments}}</td></tr><tr><td><strong>Net</strong></td><td><strong>{{record.netAmount}}</strong></td></tr></table>${SIGN}` },
]

/**
 * A company's own letter with the money rows its statement must show and an
 * older saved version lacks — today the F&F statement's Gratuity row (H6):
 * the net it prints includes gratuity, so a statement without the row would
 * not add up. Put in after the leave-encashment row, else before the net row;
 * a template with neither (HR's own layout) is left as it is. Likewise the
 * "Days paid" row (2026-10-21) above the salary row. The stored template is
 * not changed.
 */
export function withLetterSystemRows(key: string, body: string): string {
  if (key !== 'final_settlement_statement') return body
  const row = (field: string) => new RegExp(`<tr\\b[^>]*>(?:(?!</tr>)[\\s\\S])*\\{\\{\\s*record\\.${field}\\s*\\}\\}(?:(?!</tr>)[\\s\\S])*</tr>`, 'i')
  let out = body
  if (!/\{\{\s*record\.gratuity\s*\}\}/.test(out)) {
    const after = row('leaveEncashment').exec(out)
    const before = after ? null : row('netAmount').exec(out)
    if (after) out = out.slice(0, after.index + after[0].length) + GRATUITY_ROW + out.slice(after.index + after[0].length)
    else if (before) out = out.slice(0, before.index) + GRATUITY_ROW + out.slice(before.index)
  }
  // "Days paid" (owner, 2026-10-21) goes above the salary row.
  if (!/\{\{\s*record\.daysPaid\s*\}\}/.test(out)) {
    const salary = row('salaryPayable').exec(out)
    if (salary) out = out.slice(0, salary.index) + DAYS_ROW + out.slice(salary.index)
  }
  return out
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

// ─── Sanitising ──────────────────────────────────────────────────────────────
//
// A template is HTML written by an HR user and printed by the owner, so it is
// cut down to formatting before it is stored and again before it is printed:
// the tags and attributes below and nothing else. No script, no event
// handler, no javascript: URL, no frame, form or SVG. Whatever else is in the
// template is dropped — its text kept, except for the tags whose content is
// code or other documents, which go with their content. The admin also prints
// inside a sandbox that runs no script; this is the other half.

const ALLOWED_TAGS = new Set(['p', 'br', 'strong', 'b', 'em', 'i', 'u', 'h1', 'h2', 'h3', 'h4', 'ul', 'ol', 'li', 'table', 'thead', 'tbody', 'tr', 'td', 'th', 'span', 'div', 'hr', 'img'])
const VOID_TAGS = new Set(['br', 'hr', 'img'])
const DROP_WITH_CONTENT = new Set(['script', 'style', 'iframe', 'frame', 'frameset', 'object', 'embed', 'applet', 'noscript', 'noembed', 'noframes', 'template', 'textarea', 'title', 'xmp', 'plaintext', 'svg', 'math', 'select'])

const NAMED: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0', colon: ':', tab: '\t', newline: '\n', lpar: '(', rpar: ')', sol: '/', bsol: '\\', semi: ';', comma: ',', period: '.' }

/** What the browser reads an attribute value as: entities decoded, with or
 *  without their semicolon. */
function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);?/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : ''
    }
    return NAMED[e.toLowerCase()] ?? m
  })
}

/** An inline style, or null when it could reach anything outside formatting.
 *  CSS escapes and leftover entities are refused rather than decoded. */
function safeStyle(raw: string): string | null {
  const v = decodeEntities(raw)
  if (/[\\&<>]/.test(v)) return null
  const flat = v.replace(/\/\*[\s\S]*?\*\//g, '').replace(/[\s\u0000-\u001f]+/g, '').toLowerCase()
  if (/expression\(|javascript:|vbscript:|-moz-binding|behavior:|@import/.test(flat)) return null
  for (const m of flat.matchAll(/url\(['"]?([^)'"]*)/g)) if (!/^(https:|data:image\/)/.test(m[1]!)) return null
  return v
}

/** An image source: https or an embedded image, nothing else. */
function safeSrc(raw: string): string | null {
  const v = decodeEntities(raw).replace(/[\s\u0000-\u001f]+/g, '')
  return /^(https:|data:image\/)/i.test(v) ? v : null
}

function cleanAttrs(tag: string, attrs: Array<[string, string]>): string {
  let out = ''
  const seen = new Set<string>()
  for (const [name, value] of attrs) {
    if (seen.has(name)) continue // the browser keeps the first
    seen.add(name)
    let keep: string | null = null
    if (name === 'style') keep = safeStyle(value)
    else if (name === 'colspan' || name === 'rowspan') keep = /^\s*\d{1,3}\s*$/.test(value) ? value.trim() : null
    else if (name === 'align') keep = /^(left|right|center|justify)$/i.test(value.trim()) ? value.trim().toLowerCase() : null
    else if (name === 'src' && tag === 'img') keep = safeSrc(value)
    if (keep !== null) out += ` ${name}="${escapeHtml(keep)}"`
  }
  return out
}

const isSpace = (c: string | undefined) => c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f'
const isLetter = (c: string | undefined) => !!c && /[a-zA-Z]/.test(c)

/** Read the tag starting at s[i] === '<' the way a browser tokenises it: a
 *  quote only opens a value after "=", and a tag cut off by the end of the
 *  text is no tag at all. `end` is the index after its ">" (or s.length). */
function readTag(s: string, i: number): { end: number; closing: boolean; name: string; attrs: Array<[string, string]>; selfClose: boolean } | null {
  let j = i + 1
  const closing = s[j] === '/'
  if (closing) j++
  if (!isLetter(s[j])) return null
  const nameStart = j
  while (j < s.length && !isSpace(s[j]) && s[j] !== '/' && s[j] !== '>') j++
  const name = s.slice(nameStart, j).toLowerCase()
  const attrs: Array<[string, string]> = []
  let selfClose = false
  while (j < s.length) {
    const c = s[j]
    if (c === '>') return { end: j + 1, closing, name, attrs, selfClose }
    if (isSpace(c)) { j++; continue }
    if (c === '/') { selfClose = true; j++; continue }
    selfClose = false
    const a = j
    j++ // the first character may be anything, "=" included
    while (j < s.length && !isSpace(s[j]) && s[j] !== '/' && s[j] !== '>' && s[j] !== '=') j++
    const attr = s.slice(a, j).toLowerCase()
    let k = j
    while (isSpace(s[k])) k++
    let value = ''
    if (s[k] === '=') {
      k++
      while (isSpace(s[k])) k++
      const q = s[k]
      if (q === '"' || q === "'") {
        const close = s.indexOf(q, k + 1)
        if (close < 0) return { end: s.length, closing, name: '', attrs: [], selfClose: false }
        value = s.slice(k + 1, close)
        k = close + 1
      } else {
        const v0 = k
        while (k < s.length && !isSpace(s[k]) && s[k] !== '>') k++
        value = s.slice(v0, k)
      }
      j = k
    }
    attrs.push([attr, value])
  }
  // Cut off by the end of the text: the browser drops it, and so do we.
  return { end: s.length, closing, name: '', attrs: [], selfClose: false }
}

/** Cut template HTML down to the formatting allowlist above. Text is kept with
 *  its "<" and ">" escaped; every tag is rebuilt from what was allowed of it. */
export function sanitizeLetterHtml(input: string): string {
  const s = input.replace(/\u0000/g, '')
  const text = (t: string) => t.replace(/</g, '&lt;').replace(/>/g, '&gt;')
  let out = ''
  let i = 0
  while (i < s.length) {
    const lt = s.indexOf('<', i)
    if (lt < 0) { out += text(s.slice(i)); break }
    out += text(s.slice(i, lt))
    i = lt
    if (s.startsWith('<!--', i)) {
      const end = s.indexOf('-->', i + 4)
      i = end < 0 ? s.length : end + 3
      continue
    }
    const next = s[i + 1]
    if (next === '!' || next === '?' || (next === '/' && !isLetter(s[i + 2]))) {
      // doctype, CDATA, a processing instruction or a bogus end tag: skipped to its ">"
      const end = s.indexOf('>', i)
      i = end < 0 ? s.length : end + 1
      continue
    }
    const tag = readTag(s, i)
    if (!tag) { out += '&lt;'; i += 1; continue }
    i = tag.end
    if (!tag.name) continue
    if (!tag.closing && DROP_WITH_CONTENT.has(tag.name)) {
      const close = new RegExp(`</${tag.name}[\\s/>]`, 'ig')
      close.lastIndex = i
      const m = close.exec(s)
      if (!m) { i = s.length; continue }
      const gt = s.indexOf('>', m.index)
      i = gt < 0 ? s.length : gt + 1
      continue
    }
    if (!ALLOWED_TAGS.has(tag.name)) continue
    if (tag.closing) { if (!VOID_TAGS.has(tag.name)) out += `</${tag.name}>`; continue }
    out += `<${tag.name}${cleanAttrs(tag.name, tag.attrs)}${tag.selfClose && VOID_TAGS.has(tag.name) ? '/' : ''}>`
  }
  return out
}

// ─── Fields HR types in plain words (owner, 2026-10-22: "We don't know HTML") ─
//
// In a Word file or the letter box HR types {{Employee Name}}; the older
// {{employee.fullName}} form still works. Names are matched ignoring case,
// spaces and punctuation. A request's own fields are matched by their label
// on the request form ({{Revised gross}}), passed in as `aliases`.

export const LETTER_FIELDS: Array<{ path: string; label: string }> = [
  { path: 'today', label: 'Date' },
  { path: 'company.name', label: 'Company Name' },
  { path: 'employee.fullName', label: 'Employee Name' },
  { path: 'employee.employeeCode', label: 'Employee Code' },
  { path: 'employee.cnic', label: 'CNIC' },
  { path: 'employee.designation', label: 'Designation' },
  { path: 'employee.department', label: 'Department' },
  { path: 'employee.branch', label: 'Branch' },
  { path: 'employee.manager', label: 'Manager' },
  { path: 'employee.employmentType', label: 'Employment Type' },
  { path: 'employee.joiningDate', label: 'Joining Date' },
  { path: 'employee.confirmationDate', label: 'Confirmation Date' },
  { path: 'employee.lastWorkingDay', label: 'Last Working Day' },
  { path: 'employee.grossSalary', label: 'Gross Salary' },
  { path: 'employee.basicSalary', label: 'Basic Salary' },
]
const EXTRA_NAMES: Record<string, string> = { today: 'today', todaysdate: 'today', name: 'employee.fullName', employeeid: 'employee.employeeCode', company: 'company.name', salary: 'employee.grossSalary' }

export const fieldKey = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '')

/** The context path a placeholder name points at, or null. */
export function placeholderPath(name: string, aliases: Record<string, string> = {}): string | null {
  const n = name.trim()
  if (/^[a-zA-Z0-9_]+(\.[a-zA-Z0-9_]+)+$/.test(n) || n === 'today') return n
  const k = fieldKey(n)
  return LETTER_FIELDS.find((f) => fieldKey(f.label) === k)?.path ?? EXTRA_NAMES[k] ?? aliases[k] ?? null
}

/** Body with {{employee.fullName}} shown as {{Employee Name}} (record paths via `labels`). */
export function toFriendly(body: string, labels: Record<string, string> = {}): string {
  return body.replace(/\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g, (m, p: string) => {
    const label = LETTER_FIELDS.find((f) => f.path === p)?.label ?? labels[p]
    return label ? `{{${label}}}` : m
  })
}

function valueAt(path: string, ctx: Record<string, unknown>): unknown {
  return path.split('.').reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined), ctx)
}

/** One placeholder's text for the letter, or null when it has none. */
export function placeholderValue(name: string, ctx: Record<string, unknown>, aliases: Record<string, string> = {}): string | null {
  const path = placeholderPath(name, aliases)
  const v = path ? valueAt(path, ctx) : undefined
  return v === undefined || v === null || v === '' || typeof v === 'object' ? null : String(v)
}

/** Fill {{placeholders}}. Unknown or empty ones are left visible as [name]
 *  so a mistyped placeholder is noticed on the page, not silently blank. The
 *  result is sanitised: a template stored before sanitising, or a value placed
 *  in an attribute, prints as formatting only. */
export function renderLetter(body: string, ctx: Record<string, unknown>, aliases: Record<string, string> = {}): { html: string; missing: string[] } {
  const missing: string[] = []
  const html = body.replace(/\{\{([^{}<>\n]{1,80})\}\}/g, (_m, raw: string) => {
    const name = raw.trim()
    const v = placeholderValue(name, ctx, aliases)
    if (v === null) { missing.push(name); return `[${escapeHtml(name)}]` }
    return escapeHtml(v)
  })
  return { html: sanitizeLetterHtml(html), missing }
}

/** Every placeholder a template uses — shown in the editor. */
export function placeholdersIn(body: string): string[] {
  return Array.from(new Set(Array.from(body.matchAll(/\{\{([^{}<>\n]{1,80})\}\}/g)).map((m) => m[1]!.trim())))
}
