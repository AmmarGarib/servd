// HR letters (spec §26).
//
// A letter is HTML with {{placeholders}}. The defaults below are deliberately
// plain — they exist so every letter works on day one, and the HR team replaces
// them with their own formats in admin. Placeholders are filled from the
// employee, the company, the record the letter is about, and today's date.
//
// Every value is HTML-escaped. A name like "Ali <script>" prints as text.

export interface LetterDefault { key: string; title: string; body: string }

const SIGN = `<p>Regards,</p><p><strong>Human Resources</strong><br/>{{company.name}}</p>`
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
  { key: 'final_settlement_statement', title: 'Full & final statement', body: `${HEAD}<p>Full and final settlement:</p><table><tr><td>Salary payable</td><td>{{record.salaryPayable}}</td></tr><tr><td>OT payable</td><td>{{record.otPayable}}</td></tr><tr><td>Leave encashment</td><td>{{record.leaveEncashment}}</td></tr><tr><td>Deductions</td><td>{{record.deductions}}</td></tr><tr><td>Loan recovery</td><td>{{record.loanRecovery}}</td></tr><tr><td>Other adjustments</td><td>{{record.otherAdjustments}}</td></tr><tr><td><strong>Net</strong></td><td><strong>{{record.netAmount}}</strong></td></tr></table>${SIGN}` },
]

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

/** Fill {{a.b}} placeholders. Unknown placeholders are left visible as [a.b]
 *  so a mistyped placeholder is noticed on the page, not silently blank. */
export function renderLetter(body: string, ctx: Record<string, unknown>): { html: string; missing: string[] } {
  const missing: string[] = []
  const html = body.replace(/\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g, (_m, path: string) => {
    const v = path.split('.').reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined), ctx)
    if (v === undefined || v === null || v === '') { missing.push(path); return `[${path}]` }
    return escapeHtml(String(v))
  })
  return { html, missing }
}

/** Every placeholder a template uses — shown in the editor. */
export function placeholdersIn(body: string): string[] {
  return Array.from(new Set(Array.from(body.matchAll(/\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g)).map((m) => m[1]!)))
}
