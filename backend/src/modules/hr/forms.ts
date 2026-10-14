// HR section registry and default formats.
//
// Every section of the HR team's module spec is listed here. Each one that
// captures data has a DEFAULT FORMAT — its field list — taken from the spec.
// The HR team replaces these with their own formats in admin (or by importing
// JSON); what is stored in HrFormDefinition wins over the default.
//
// ─── Formats vs logic ────────────────────────────────────────────────────────
//
// A field may BIND to a slot. Slots are the only things logic reads:
//
//   record slots   employeeId, startDate, endDate, effectiveDate, quantity,
//                  amountCents, refId, category (a classification: status,
//                  paid/unpaid, type, outcome)
//   employee slots employee.<column> — the HrEmployee columns (Employee Master)
//
// So the leave balance reads a leave's startDate/endDate/quantity/refId, not a
// field called "From". HR can rename, reorder, add and remove fields freely.
//
// Two things a format cannot do, because logic would silently stop:
//   - drop a binding the section needs (`requires`);
//   - drop or re-key a SYSTEM field. A handful of values are read or written
//     by logic itself (approved OT hours, the new designation on a promotion,
//     the parts of a final settlement). Their label and help can change; their
//     key and type cannot.

export type FieldType =
  | 'text' | 'textarea' | 'number' | 'money' | 'percent'
  | 'date' | 'time' | 'datetime'
  | 'select' | 'multiselect' | 'boolean'
  | 'email' | 'phone' | 'file'
  | 'employee' | 'employees' | 'location' | 'department'
  | 'orgunit' // `ref` names the kind: designation | grade | business_unit | sub_department | cost_center
  | 'record'  // `ref` names the section: leave_type, shift, candidate, …
  | 'table'   // repeatable rows; `columns` holds sub-fields (dependents, allowances)

export type RecordSlot = 'employeeId' | 'startDate' | 'endDate' | 'effectiveDate' | 'quantity' | 'amountCents' | 'refId' | 'category'

export interface HrField {
  key: string
  label: string
  type: FieldType
  required?: boolean
  options?: string[]
  ref?: string
  bind?: RecordSlot | `employee.${string}`
  group?: string
  help?: string
  columns?: HrField[]
  /** number / percent / money: the smallest value accepted. */
  min?: number
  /** number / percent: whole numbers only. */
  integer?: boolean
  /** Computed by logic — shown, not typed. */
  readOnly?: boolean
  /** Logic reads or writes this key. Relabel freely; the key and type are fixed. */
  system?: boolean
}

export type ApproverRole = 'hod' | 'hr' | 'management'
export interface WorkflowStep { key: string; label: string; role: ApproverRole }

export interface HrSection {
  key: string
  /** Number in the HR team's spec, so both sides can refer to the same thing. */
  specNo: number
  title: string
  group: string
  /** record = entries captured through a format; page = a dedicated screen. */
  kind: 'record' | 'page'
  /** Record sections that hold settings (shift master, leave types) rather than employee events. */
  config?: boolean
  fields?: HrField[]
  workflow?: WorkflowStep[]
  stages?: string[]
  /** Slots this section's logic reads. A format must keep a field bound to each. */
  requires?: RecordSlot[]
  /** What happens on final approval, in words — shown in the UI. */
  effect?: string
  /**
   * The section's work moved elsewhere: no new records (createRecord → 409
   * SECTION_MOVED with `message`), existing ones stay readable. `path` is the
   * admin page that does it now.
   */
  movedTo?: { path: string; label: string; message: string }
}

/**
 * A text field whose `ref` is this holds a bank account id (Configuration →
 * Bank accounts) of the record's own company — checked like any other
 * reference (routes checkReferences), shown as the company's bank picker.
 */
export const BANK_ACCOUNT_REF = 'bank_account'

// ── small builders ──
const t = (key: string, label: string, extra: Partial<HrField> = {}): HrField => ({ key, label, type: 'text', ...extra })
const f = (key: string, label: string, type: FieldType, extra: Partial<HrField> = {}): HrField => ({ key, label, type, ...extra })
const sel = (key: string, label: string, options: string[], extra: Partial<HrField> = {}): HrField => ({ key, label, type: 'select', options, ...extra })
const emp = (extra: Partial<HrField> = {}): HrField => ({ key: 'employee', label: 'Employee', type: 'employee', required: true, bind: 'employeeId', ...extra })

const HOD: WorkflowStep = { key: 'hod', label: 'HOD approval', role: 'hod' }
const HR: WorkflowStep = { key: 'hr', label: 'HR approval', role: 'hr' }
const MGMT: WorkflowStep = { key: 'management', label: 'Management approval', role: 'management' }

export const EMPLOYMENT_TYPES = ['permanent', 'probation', 'contract', 'temporary', 'intern']
export const EMPLOYEE_STATUSES = ['active', 'on_leave', 'resigned', 'terminated', 'separated']
export const ORG_UNIT_KINDS = ['business_unit', 'sub_department', 'designation', 'grade', 'cost_center'] as const

export const DOCUMENT_TYPES = [
  'cnic_front', 'cnic_back', 'frc', 'photograph', 'educational', 'experience_certificate',
  'previous_employment', 'offer_letter', 'employment_contract', 'joining_form',
  'medical_fitness', 'reference_check', 'eobi', 'sessi', 'other',
]

// ── Employee Master (spec §3). Core columns are bound; the rest lands in data. ──
export const EMPLOYEE_MASTER_FIELDS: HrField[] = [
  // Personal
  t('employeeCode', 'Employee ID', { group: 'Personal information', bind: 'employee.employeeCode', help: 'Leave blank to generate' }),
  t('fullName', 'Employee name', { group: 'Personal information', required: true, bind: 'employee.fullName' }),
  t('fatherHusbandName', 'Father / husband name', { group: 'Personal information', bind: 'employee.fatherHusbandName' }),
  t('cnic', 'CNIC number', { group: 'Personal information', bind: 'employee.cnic' }),
  f('cnicIssueDate', 'CNIC issue date', 'date', { group: 'Personal information' }),
  f('cnicExpiry', 'CNIC expiry date', 'date', { group: 'Personal information', bind: 'employee.cnicExpiry' }),
  f('dateOfBirth', 'Date of birth', 'date', { group: 'Personal information', bind: 'employee.dateOfBirth' }),
  sel('gender', 'Gender', ['male', 'female', 'other'], { group: 'Personal information', bind: 'employee.gender' }),
  sel('maritalStatus', 'Marital status', ['single', 'married', 'divorced', 'widowed'], { group: 'Personal information' }),
  sel('bloodGroup', 'Blood group', ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'], { group: 'Personal information' }),
  t('nationality', 'Nationality', { group: 'Personal information' }),
  f('photoUrl', 'Photograph', 'file', { group: 'Personal information', bind: 'employee.photoUrl' }),
  // Family / dependents
  f('dependents', 'Family / dependents', 'table', {
    group: 'Family / dependents',
    columns: [
      t('name', 'Dependent name'),
      sel('relationship', 'Relationship', ['spouse', 'son', 'daughter', 'father', 'mother', 'other']),
      f('dateOfBirth', 'Date of birth', 'date'),
      sel('gender', 'Gender', ['male', 'female', 'other']),
      t('cnicBForm', 'CNIC / B-Form number'),
      sel('status', 'Dependent status', ['active', 'inactive']),
      f('medicalEligible', 'Medical eligibility', 'boolean'),
      f('medicalStart', 'Medical benefit start', 'date'),
      f('medicalEnd', 'Medical benefit end', 'date'),
      f('frcDocument', 'FRC reference / document', 'file'),
    ],
  }),
  // Contact
  f('phone', 'Mobile', 'phone', { group: 'Contact information', bind: 'employee.phone' }),
  f('personalEmail', 'Personal email', 'email', { group: 'Contact information', bind: 'employee.personalEmail' }),
  f('currentAddress', 'Current address', 'textarea', { group: 'Contact information' }),
  f('permanentAddress', 'Permanent address', 'textarea', { group: 'Contact information' }),
  t('emergencyContact', 'Emergency contact', { group: 'Contact information' }),
  t('emergencyRelationship', 'Emergency contact relationship', { group: 'Contact information' }),
  // Employment
  f('joiningDate', 'Joining date', 'date', { group: 'Employment information', bind: 'employee.joiningDate' }),
  f('departmentId', 'Department', 'department', { group: 'Employment information', bind: 'employee.departmentId' }),
  f('designationId', 'Designation', 'orgunit', { ref: 'designation', group: 'Employment information', bind: 'employee.designationId' }),
  f('gradeId', 'Job grade / level', 'orgunit', { ref: 'grade', group: 'Employment information', bind: 'employee.gradeId' }),
  f('locationId', 'Branch', 'location', { group: 'Employment information', bind: 'employee.locationId' }),
  f('managerId', 'Reporting manager', 'employee', { group: 'Employment information', bind: 'employee.managerId' }),
  sel('employmentType', 'Employment type', EMPLOYMENT_TYPES, { group: 'Employment information', bind: 'employee.employmentType' }),
  sel('status', 'Employee status', EMPLOYEE_STATUSES, { group: 'Employment information', bind: 'employee.status' }),
  f('probationStart', 'Probation start date', 'date', { group: 'Employment information' }),
  f('probationEnd', 'Probation end date', 'date', { group: 'Employment information', bind: 'employee.probationEnd' }),
  f('confirmationDate', 'Confirmation date', 'date', { group: 'Employment information', bind: 'employee.confirmationDate' }),
  f('contractEnd', 'Contract end date', 'date', { group: 'Employment information', bind: 'employee.contractEnd' }),
  f('noticePeriodDays', 'Notice period (days)', 'number', { group: 'Employment information', bind: 'employee.noticePeriodDays' }),
  // Compensation
  f('basicSalaryCents', 'Basic salary', 'money', { group: 'Compensation', bind: 'employee.basicSalaryCents', min: 0, help: 'Cannot be more than gross' }),
  f('grossSalaryCents', 'Gross salary', 'money', { group: 'Compensation', bind: 'employee.grossSalaryCents', min: 0 }),
  f('allowances', 'Allowances', 'table', {
    group: 'Compensation',
    columns: [t('name', 'Allowance'), f('amountCents', 'Amount', 'money', { min: 0 })],
    help: 'Part of gross — listed for the payslip breakdown',
  }),
  t('salaryStructure', 'Salary structure', { group: 'Compensation' }),
  sel('paymentMethod', 'Payment method', ['bank', 'cash', 'cheque'], { group: 'Compensation', bind: 'employee.paymentMethod' }),
  t('bankName', 'Bank name', { group: 'Compensation', bind: 'employee.bankName' }),
  t('iban', 'Account / IBAN', { group: 'Compensation', bind: 'employee.iban' }),
  f('monthlyTaxCents', 'Monthly income tax', 'money', { group: 'Compensation', bind: 'employee.monthlyTaxCents', min: 0, help: 'Deducted each payroll until slab-based tax is built' }),
  // Statutory
  t('eobiNo', 'EOBI no.', { group: 'Statutory', bind: 'employee.eobiNo' }),
  t('sessiNo', 'SESSI no.', { group: 'Statutory', bind: 'employee.sessiNo' }),
  t('ntn', 'Tax / NTN', { group: 'Statutory', bind: 'employee.ntn' }),
]

const RECRUITMENT_STAGES = [
  'applied', 'shortlisted', 'phone_screening', 'interview', 'technical_test',
  'reference_check', 'selected', 'offer', 'joined', 'rejected', 'withdrawn',
]

export const HR_SECTIONS: HrSection[] = [
  { key: 'dashboard', specNo: 1, title: 'HR dashboard', group: 'Overview', kind: 'page' },
  { key: 'org', specNo: 2, title: 'Organization setup', group: 'Setup', kind: 'page' },
  { key: 'employees', specNo: 3, title: 'Employee master', group: 'People', kind: 'page', fields: EMPLOYEE_MASTER_FIELDS },
  { key: 'documents', specNo: 4, title: 'Employee documents', group: 'People', kind: 'page' },

  { key: 'requisition', specNo: 5, title: 'Manpower requisition', group: 'Hiring', kind: 'record',
    workflow: [HOD, HR, MGMT], requires: ['quantity'],
    fields: [
      f('department', 'Department', 'department', { required: true }),
      f('location', 'Branch', 'location'),
      t('position', 'Position', { required: true }),
      f('headcount', 'Required headcount', 'number', { required: true, bind: 'quantity' }),
      sel('requestType', 'Replacement / new position', ['replacement', 'new']),
      f('reason', 'Reason for hiring', 'textarea'),
      t('qualification', 'Required qualification'),
      t('experience', 'Required experience'),
      f('salaryBudget', 'Salary budget', 'money', { bind: 'amountCents' }),
      f('requiredBy', 'Required joining date', 'date', { bind: 'startDate' }),
    ] },

  { key: 'job_opening', specNo: 6, title: 'Job openings', group: 'Hiring', kind: 'record',
    fields: [
      t('position', 'Job position', { required: true }),
      f('requisition', 'Requisition', 'record', { ref: 'requisition', bind: 'refId' }),
      f('description', 'Job description', 'textarea'),
      f('postedOn', 'Posted on', 'multiselect', { options: ['LinkedIn', 'Rozee.pk', 'Facebook', 'Instagram', 'Referral', 'Walk-in', 'Agency', 'Other'] }),
      sel('vacancyStatus', 'Vacancy status', ['open', 'on_hold', 'filled', 'closed'], { required: true }),
      f('openedOn', 'Opened on', 'date', { bind: 'startDate' }),
    ] },

  { key: 'candidate', specNo: 6, title: 'Candidates', group: 'Hiring', kind: 'record', stages: RECRUITMENT_STAGES,
    fields: [
      f('job', 'Job', 'record', { ref: 'job_opening', bind: 'refId' }),
      t('name', 'Candidate name', { required: true }),
      f('phone', 'Contact', 'phone', { required: true }),
      f('email', 'Email', 'email'),
      f('cv', 'CV', 'file'),
      t('qualification', 'Qualification'),
      t('experience', 'Experience'),
      f('currentSalary', 'Current salary', 'money'),
      f('expectedSalary', 'Expected salary', 'money', { bind: 'amountCents' }),
      t('noticePeriod', 'Notice period'),
      f('availableFrom', 'Availability', 'date', { bind: 'startDate' }),
      sel('source', 'Recruitment source', ['LinkedIn', 'Rozee.pk', 'Facebook', 'Instagram', 'Referral', 'Walk-in', 'Agency', 'Other']),
    ] },

  { key: 'interview', specNo: 6, title: 'Interviews', group: 'Hiring', kind: 'record',
    fields: [
      f('candidate', 'Candidate', 'record', { ref: 'candidate', required: true, bind: 'refId' }),
      f('scheduledAt', 'Interview schedule', 'datetime', { required: true, bind: 'startDate' }),
      f('panel', 'Interview panel', 'employees'),
      f('evaluation', 'Evaluation', 'textarea'),
      f('technicalEvaluation', 'Technical evaluation', 'textarea'),
      f('score', 'Score', 'number'),
      sel('hodRecommendation', 'HOD recommendation', ['hire', 'hold', 'reject']),
      sel('hrRecommendation', 'HR recommendation', ['hire', 'hold', 'reject']),
      f('approvedSalary', 'Approved salary', 'money', { bind: 'amountCents' }),
      sel('finalDecision', 'Final decision', ['selected', 'rejected', 'on_hold']),
    ] },

  { key: 'offer', specNo: 7, title: 'Offers', group: 'Hiring', kind: 'record',
    workflow: [HR, MGMT], requires: ['amountCents', 'startDate'],
    effect: 'Once approved and accepted, "Create employee" makes the Employee Master record from it.',
    fields: [
      f('candidate', 'Candidate', 'record', { ref: 'candidate', bind: 'refId' }),
      t('candidateName', 'Candidate name', { required: true, system: true }),
      f('designation', 'Designation', 'orgunit', { ref: 'designation', system: true }),
      f('department', 'Department', 'department', { system: true }),
      f('location', 'Branch', 'location', { system: true }),
      f('salaryOffered', 'Salary offered (gross)', 'money', { required: true, bind: 'amountCents' }),
      f('joiningDate', 'Joining date', 'date', { required: true, bind: 'startDate' }),
      f('probationMonths', 'Probation period (months)', 'number'),
      f('noticePeriodDays', 'Notice period (days)', 'number'),
      f('benefits', 'Benefits', 'textarea'),
      f('offerExpiry', 'Offer expiry', 'date', { bind: 'endDate' }),
      sel('acceptance', 'Offer acceptance', ['pending', 'accepted', 'declined']),
      f('documents', 'Candidate documents', 'file'),
    ] },

  { key: 'onboarding', specNo: 8, title: 'Onboarding', group: 'Hiring', kind: 'record',
    fields: [
      emp(),
      f('documentsVerified', 'Document verification', 'boolean', { group: 'Checklist' }),
      f('employeeIdIssued', 'Employee ID generated', 'boolean', { group: 'Checklist' }),
      f('attendanceSetup', 'Attendance setup', 'boolean', { group: 'Checklist' }),
      f('payrollSetup', 'Payroll setup', 'boolean', { group: 'Checklist' }),
      f('bankDetails', 'Bank details', 'boolean', { group: 'Checklist' }),
      f('departmentAssigned', 'Department assignment', 'boolean', { group: 'Checklist' }),
      f('branchAssigned', 'Branch assignment', 'boolean', { group: 'Checklist' }),
      f('managerAssigned', 'Reporting manager', 'boolean', { group: 'Checklist' }),
      f('idCard', 'ID card', 'boolean', { group: 'Checklist' }),
      f('uniform', 'Uniform', 'boolean', { group: 'Checklist' }),
      f('assets', 'Assets', 'boolean', { group: 'Checklist' }),
      f('orientation', 'Orientation', 'boolean', { group: 'Checklist' }),
      f('induction', 'Induction', 'boolean', { group: 'Checklist' }),
      f('policyAcknowledged', 'Policy acknowledgement', 'boolean', { group: 'Checklist' }),
      f('notes', 'Notes', 'textarea'),
    ] },

  { key: 'attendance', specNo: 9, title: 'Attendance', group: 'Time', kind: 'record', requires: ['employeeId', 'startDate', 'category'],
    effect: 'Written automatically from clock-in punches (time clock, tablet or kiosk PIN): present or late against the rostered shift and the grace minutes in HR settings; a day with an in and no out becomes missing punch. HR keys only the exceptions, and a row HR keyed or edited is never overwritten by a punch.',
    fields: [
      emp(),
      f('date', 'Date', 'date', { required: true, bind: 'startDate' }),
      f('location', 'Branch', 'location'),
      f('shift', 'Shift', 'record', { ref: 'shift', bind: 'refId' }),
      f('checkIn', 'Check-in', 'time', { system: true }),
      f('checkOut', 'Check-out', 'time', { system: true }),
      sel('status', 'Status', ['present', 'absent', 'late', 'early_departure', 'half_day', 'missing_punch', 'off_day', 'holiday'], { required: true, bind: 'category' }),
      f('lateMinutes', 'Late by (minutes)', 'number', { bind: 'quantity' }),
      f('remarks', 'Remarks', 'textarea'),
    ] },

  { key: 'attendance_correction', specNo: 9, title: 'Attendance corrections', group: 'Time', kind: 'record',
    workflow: [HOD, HR], requires: ['employeeId', 'startDate'],
    effect: 'On final approval the corrected check-in / check-out are written to that day\'s attendance record, and present or late is worked out again against the rostered shift.',
    fields: [
      emp(),
      f('date', 'Date', 'date', { required: true, bind: 'startDate' }),
      sel('type', 'Request', ['regularization', 'missed_punch'], { required: true }),
      f('correctedIn', 'Correct check-in', 'time', { system: true }),
      f('correctedOut', 'Correct check-out', 'time', { system: true }),
      f('reason', 'Reason / remarks', 'textarea', { required: true }),
    ] },

  { key: 'shift', specNo: 10, title: 'Shift master', group: 'Time', kind: 'record', config: true,
    effect: 'The only list of shifts. The roster assigns them, the /scheduling week is generated from them, and attendance marks late against their start.',
    fields: [
      t('name', 'Shift name', { required: true, system: true }),
      f('start', 'Start time', 'time', { required: true, system: true }),
      f('end', 'End time', 'time', { required: true, system: true }),
      f('breakMinutes', 'Break (minutes)', 'number', { system: true }),
      f('graceMinutes', 'Grace period (minutes)', 'number', { help: 'For reference — lateness is marked and docked against the grace minutes in HR settings' }),
      f('location', 'Branch', 'location'),
    ] },

  { key: 'roster', specNo: 10, title: 'Roster / shift assignment', group: 'Time', kind: 'record',
    workflow: [HOD], requires: ['employeeId', 'refId', 'startDate'],
    effect: 'Once approved it is the person\'s standing shift and weekly offs: the /scheduling week is generated from it (managers change only the exceptions there) and attendance marks late against it.',
    fields: [
      emp(),
      f('shift', 'Shift', 'record', { ref: 'shift', required: true, bind: 'refId' }),
      f('from', 'From', 'date', { required: true, bind: 'startDate' }),
      f('to', 'To', 'date', { bind: 'endDate' }),
      f('weeklyOff', 'Weekly off', 'multiselect', { options: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'], system: true }),
      f('location', 'Branch', 'location'),
    ] },

  { key: 'shift_swap', specNo: 10, title: 'Shift change / swap', group: 'Time', kind: 'record',
    workflow: [HOD], requires: ['employeeId', 'startDate'],
    effect: 'Once approved the day moves on the rota: the employee works the "to" shift, and the person swapped with works the employee\'s shift. The only shift swap in servd.',
    fields: [
      emp(),
      f('swapWith', 'Swap with', 'employee', { system: true }),
      f('date', 'Date', 'date', { required: true, bind: 'startDate' }),
      f('fromShift', 'From shift', 'record', { ref: 'shift', system: true }),
      f('toShift', 'To shift', 'record', { ref: 'shift', bind: 'refId' }),
      f('reason', 'Reason', 'textarea'),
    ] },

  { key: 'overtime', specNo: 11, title: 'Overtime', group: 'Time', kind: 'record',
    workflow: [HOD, HR], requires: ['employeeId', 'startDate', 'quantity'],
    effect: 'On final approval the OT amount is calculated (approved hours × hourly rate × multiplier) and flows into that month\'s payroll.',
    fields: [
      emp(),
      f('date', 'Date', 'date', { required: true, bind: 'startDate' }),
      f('department', 'Department', 'department'),
      f('location', 'Branch', 'location'),
      f('regularHours', 'Regular working hours', 'number'),
      f('otStart', 'OT start time', 'time'),
      f('otEnd', 'OT end time', 'time'),
      f('otHours', 'OT hours', 'number', { required: true, bind: 'quantity' }),
      f('approvedHours', 'Approved OT hours', 'number', { system: true, readOnly: true, help: 'Set by the approver; defaults to OT hours' }),
      f('multiplier', 'OT multiplier', 'number', { system: true, help: 'Blank = the HR setting' }),
      f('otRate', 'OT hourly rate', 'money', { system: true, readOnly: true }),
      f('otAmount', 'OT amount', 'money', { bind: 'amountCents', system: true, readOnly: true }),
      f('reason', 'Reason', 'textarea'),
    ] },

  { key: 'leave_type', specNo: 12, title: 'Leave types', group: 'Time', kind: 'record', config: true, requires: ['quantity', 'category'],
    fields: [
      t('name', 'Leave type', { required: true }),
      t('code', 'Code'),
      f('entitlementDays', 'Entitlement (days per year)', 'number', { required: true, bind: 'quantity' }),
      sel('pay', 'Paid or unpaid', ['paid', 'unpaid'], { required: true, bind: 'category' }),
      f('carryForward', 'Carry forward', 'boolean', { system: true, help: 'Unused days roll into the next leave year' }),
      f('maxCarryForward', 'Max carry forward (days)', 'number', { system: true, help: 'Blank = no cap' }),
    ] },

  { key: 'leave', specNo: 12, title: 'Leave applications', group: 'Time', kind: 'record',
    workflow: [HOD, HR], requires: ['employeeId', 'startDate', 'endDate', 'refId'],
    effect: 'Approved leave comes off the balance. Unpaid leave is deducted in payroll.',
    fields: [
      emp(),
      f('leaveType', 'Leave type', 'record', { ref: 'leave_type', required: true, bind: 'refId' }),
      f('from', 'From', 'date', { required: true, bind: 'startDate' }),
      f('to', 'To', 'date', { required: true, bind: 'endDate' }),
      f('days', 'Days', 'number', { bind: 'quantity', help: 'Calculated from the dates. For a half day, pick one date and enter 0.5' }),
      f('reason', 'Reason', 'textarea'),
      f('handoverTo', 'Handover to', 'employee'),
    ] },

  { key: 'leave_adjustment', specNo: 12, title: 'Leave adjustments', group: 'Time', kind: 'record',
    workflow: [HR], requires: ['employeeId', 'refId', 'quantity'],
    fields: [
      emp(),
      f('leaveType', 'Leave type', 'record', { ref: 'leave_type', required: true, bind: 'refId' }),
      f('days', 'Days (+ to add, − to remove)', 'number', { required: true, bind: 'quantity' }),
      f('effectiveDate', 'Effective date', 'date', { bind: 'effectiveDate' }),
      f('reason', 'Reason', 'textarea', { required: true }),
    ] },

  { key: 'holiday', specNo: 13, title: 'Holidays', group: 'Time', kind: 'record', config: true, requires: ['startDate'],
    fields: [
      t('name', 'Holiday', { required: true }),
      f('date', 'Holiday date', 'date', { required: true, bind: 'startDate' }),
      sel('type', 'Holiday type', ['public', 'company', 'religious', 'optional'], { required: true }),
      f('location', 'Branch (blank = all)', 'location'),
      f('paid', 'Paid', 'boolean'),
      f('compensatoryOff', 'Compensatory off if worked', 'boolean'),
    ] },

  { key: 'payroll', specNo: 14, title: 'Payroll', group: 'Pay', kind: 'page' },

  { key: 'payroll_adjustment', specNo: 14, title: 'Bonuses, incentives & adjustments', group: 'Pay', kind: 'record',
    workflow: [HR], requires: ['employeeId', 'effectiveDate', 'amountCents', 'category'],
    effect: 'Approved adjustments are added to (or deducted from) the payroll of the month they fall in.',
    fields: [
      emp(),
      f('month', 'Payroll month', 'date', { required: true, bind: 'effectiveDate', help: 'Any date in the month' }),
      sel('kind', 'Type', ['bonus', 'incentive', 'allowance', 'arrears', 'deduction', 'other_deduction'], { required: true, bind: 'category' }),
      f('amount', 'Amount', 'money', { required: true, bind: 'amountCents', min: 0, help: 'Always a positive amount — the type says whether it is paid or deducted' }),
      f('reason', 'Reason', 'textarea'),
    ] },

  { key: 'benefit', specNo: 15, title: 'Employee benefits', group: 'Pay', kind: 'record',
    fields: [
      emp(),
      sel('benefitType', 'Benefit', ['medical', 'other'], { required: true }),
      sel('coverage', 'Covers', ['employee', 'spouse', 'children', 'dependents']),
      t('dependentName', 'Dependent name'),
      t('relationship', 'Relationship'),
      f('start', 'Benefit start date', 'date', { bind: 'startDate' }),
      f('end', 'Benefit end date', 'date', { bind: 'endDate' }),
      sel('benefitStatus', 'Benefit status', ['active', 'ended', 'suspended']),
      f('notes', 'Notes', 'textarea'),
    ] },

  { key: 'probation_review', specNo: 16, title: 'Probation reviews', group: 'People', kind: 'record',
    workflow: [HOD, HR], requires: ['employeeId', 'category'],
    effect: 'Confirm → employee becomes permanent with a confirmation date. Extend → probation end moves to the new date. Terminate → start a termination.',
    fields: [
      emp(),
      f('dueDate', 'Evaluation due date', 'date', { bind: 'endDate' }),
      f('evaluation', 'Evaluation', 'textarea'),
      sel('rating', 'Rating', ['exceeds', 'meets', 'below', 'unsatisfactory']),
      sel('hodRecommendation', 'HOD recommendation', ['confirm', 'extend', 'terminate']),
      sel('hrRecommendation', 'HR recommendation', ['confirm', 'extend', 'terminate']),
      sel('outcome', 'Outcome', ['confirm', 'extend', 'terminate'], { required: true, bind: 'category' }),
      f('extendTo', 'Extend probation to', 'date', { bind: 'effectiveDate' }),
    ] },

  { key: 'performance_review', specNo: 17, title: 'Performance reviews', group: 'People', kind: 'record',
    workflow: [HOD, HR],
    fields: [
      emp(),
      t('period', 'Review period', { required: true }),
      f('kpis', 'KPIs', 'textarea'),
      f('goals', 'Goals', 'textarea'),
      f('selfEvaluation', 'Employee evaluation', 'textarea'),
      f('hodEvaluation', 'HOD evaluation', 'textarea'),
      f('hrEvaluation', 'HR evaluation', 'textarea'),
      f('rating', 'Rating (1–5)', 'number', { bind: 'quantity' }),
      f('comments', 'Comments', 'textarea'),
      f('pip', 'Performance improvement plan', 'boolean'),
      f('incrementRecommendation', 'Increment recommendation (%)', 'percent'),
      f('promotionRecommendation', 'Recommend promotion', 'boolean'),
    ] },

  { key: 'training_request', specNo: 18, title: 'Training needs', group: 'People', kind: 'record',
    workflow: [HOD, HR], requires: ['employeeId'],
    fields: [
      emp(),
      t('need', 'Training need', { required: true }),
      f('justification', 'Justification', 'textarea'),
    ] },

  { key: 'training', specNo: 18, title: 'Training programs', group: 'People', kind: 'record',
    fields: [
      t('program', 'Training program', { required: true }),
      sel('type', 'Training type', ['internal', 'external', 'on_the_job', 'online']),
      t('trainer', 'Trainer'),
      f('date', 'Training date', 'date', { required: true, bind: 'startDate' }),
      f('endDate', 'End date', 'date', { bind: 'endDate' }),
      f('participants', 'Participants', 'employees'),
      f('attendance', 'Attendance', 'textarea'),
      f('cost', 'Training cost', 'money', { bind: 'amountCents' }),
      f('feedback', 'Training feedback', 'textarea'),
      f('evaluation', 'Training evaluation', 'textarea'),
      f('certificate', 'Certificate', 'file'),
    ] },

  { key: 'er_case', specNo: 19, title: 'Employee relations cases', group: 'People', kind: 'record',
    workflow: [HR, MGMT], stages: ['open', 'investigation', 'action', 'closed'],
    fields: [
      emp(),
      sel('category', 'Category', ['complaint', 'grievance', 'incident', 'misconduct', 'other'], { required: true }),
      f('description', 'Description', 'textarea', { required: true }),
      f('incidentDate', 'Incident date', 'date', { bind: 'startDate' }),
      f('investigation', 'Investigation', 'textarea'),
      f('counselling', 'Counselling', 'textarea'),
      sel('action', 'Action', ['none', 'counselling', 'verbal_warning', 'written_warning', 'show_cause', 'suspension', 'termination']),
      f('managementDecision', 'Management decision', 'textarea'),
    ] },

  { key: 'asset_assignment', specNo: 20, title: 'Employee assets', group: 'People', kind: 'record',
    fields: [
      emp(),
      sel('assetType', 'Asset type', ['laptop', 'mobile', 'id_card', 'uniform', 'keys', 'access_card', 'other'], { required: true }),
      t('assetNumber', 'Asset number'),
      f('issueDate', 'Issue date', 'date', { required: true, bind: 'startDate' }),
      f('returnDate', 'Return date', 'date', { bind: 'endDate' }),
      sel('condition', 'Condition', ['new', 'good', 'fair', 'damaged']),
      f('acknowledged', 'Employee acknowledgement', 'boolean'),
    ] },

  { key: 'promotion', specNo: 21, title: 'Promotions', group: 'Movement', kind: 'record',
    workflow: [HOD, HR, MGMT], requires: ['employeeId', 'effectiveDate'],
    effect: 'On final approval the employee\'s designation and salary change from the effective date.',
    fields: [
      emp(),
      f('newDesignation', 'New designation', 'orgunit', { ref: 'designation', required: true, system: true }),
      f('revisedSalary', 'Revised gross salary', 'money', { bind: 'amountCents' }),
      f('effectiveDate', 'Effective date', 'date', { required: true, bind: 'effectiveDate' }),
      f('reason', 'Reason', 'textarea'),
    ] },

  { key: 'transfer', specNo: 21, title: 'Transfers', group: 'Movement', kind: 'record',
    workflow: [HOD, HR], requires: ['employeeId', 'effectiveDate'],
    effect: 'On final approval the employee\'s branch, department and manager change.',
    fields: [
      emp(),
      f('newLocation', 'New branch', 'location', { system: true }),
      f('newDepartment', 'New department', 'department', { system: true }),
      f('newManager', 'New manager', 'employee', { system: true }),
      f('effectiveDate', 'Effective date', 'date', { required: true, bind: 'effectiveDate' }),
      f('reason', 'Reason', 'textarea'),
    ] },

  { key: 'salary_revision', specNo: 22, title: 'Salary revisions', group: 'Movement', kind: 'record',
    workflow: [HR, MGMT], requires: ['employeeId', 'amountCents', 'effectiveDate'],
    effect: 'On final approval the new gross (and basic, if given) becomes the employee\'s salary. The increase is worked out for you.',
    fields: [
      emp(),
      f('revisedGross', 'Revised gross salary', 'money', { required: true, bind: 'amountCents' }),
      f('revisedBasic', 'Revised basic salary', 'money', { system: true }),
      f('increaseAmount', 'Increase amount', 'money', { readOnly: true, system: true }),
      f('increasePct', 'Increase %', 'percent', { readOnly: true, system: true }),
      f('effectiveDate', 'Effective date', 'date', { required: true, bind: 'effectiveDate' }),
      f('reason', 'Reason', 'textarea'),
    ] },

  { key: 'loan', specNo: 23, title: 'Loans & advances', group: 'Pay', kind: 'record',
    workflow: [HR, MGMT], requires: ['employeeId', 'amountCents', 'quantity', 'effectiveDate'],
    effect: 'Once approved it is paid out and booked (from the bank or the safe), and one installment is deducted in each payroll from the first deduction month until repaid.',
    fields: [
      emp(),
      sel('type', 'Type', ['advance', 'loan'], { required: true, bind: 'category' }),
      f('amount', 'Amount', 'money', { required: true, bind: 'amountCents' }),
      f('date', 'Date', 'date', { bind: 'startDate' }),
      f('installments', 'Number of installments', 'number', { required: true, bind: 'quantity', integer: true, min: 1 }),
      f('firstDeduction', 'First deduction month', 'date', { required: true, bind: 'effectiveDate' }),
      f('reason', 'Reason', 'textarea'),
      // Where the money comes from when it is paid out on approval (hr/ledger.ts
      // postLoanDisbursement reads these keys). Blank = the way the employee
      // is paid. HR's, never the employee's (hidden from self-service).
      sel('paidFrom', 'Paid from', ['bank', 'cash'], { group: 'Payment', help: 'Blank = the way the employee is paid (cash staff from the safe, the rest by bank)' }),
      t('bankAccount', 'Bank account', { group: 'Payment', ref: BANK_ACCOUNT_REF, help: 'Blank = the company\'s bank. Management can pick it when approving.' }),
    ] },

  { key: 'resignation', specNo: 24, title: 'Resignations', group: 'Separation', kind: 'record',
    workflow: [HOD, HR], requires: ['employeeId', 'endDate'],
    effect: 'On final approval the employee is marked resigned with their last working day.',
    fields: [
      emp(),
      f('resignationDate', 'Resignation date', 'date', { required: true, bind: 'startDate' }),
      f('lastWorkingDay', 'Last working day', 'date', { required: true, bind: 'endDate' }),
      f('noticePeriodDays', 'Notice period (days)', 'number'),
      f('reason', 'Reason', 'textarea'),
    ] },

  { key: 'termination', specNo: 24, title: 'Terminations', group: 'Separation', kind: 'record',
    workflow: [HR, MGMT], requires: ['employeeId', 'endDate'],
    effect: 'On final approval the employee is marked terminated with their last working day.',
    fields: [
      emp(),
      f('terminationDate', 'Termination date', 'date', { required: true, bind: 'startDate' }),
      f('lastWorkingDay', 'Last working day', 'date', { required: true, bind: 'endDate' }),
      sel('category', 'Category', ['misconduct', 'performance', 'redundancy', 'probation', 'other']),
      f('reason', 'Reason', 'textarea', { required: true }),
    ] },

  { key: 'exit_clearance', specNo: 24, title: 'Exit & clearance', group: 'Separation', kind: 'record',
    workflow: [HR],
    fields: [
      emp(),
      f('exitInterview', 'Exit interview', 'textarea'),
      f('assetsReturned', 'Asset return', 'boolean', { group: 'Clearance' }),
      f('departmentClearance', 'Department clearance', 'boolean', { group: 'Clearance' }),
      f('hrClearance', 'HR clearance', 'boolean', { group: 'Clearance' }),
      f('financeClearance', 'Finance clearance', 'boolean', { group: 'Clearance' }),
      f('finalAttendanceDays', 'Final attendance (days)', 'number'),
      f('leaveBalanceDays', 'Leave balance (days)', 'number'),
      f('notes', 'Notes', 'textarea'),
    ] },

  { key: 'final_settlement', specNo: 25, title: 'Full & final settlement', group: 'Separation', kind: 'record',
    workflow: [HR, MGMT], requires: ['employeeId', 'endDate'],
    effect: 'Use "Calculate" to fill the figures from salary, OT, leave balance, gratuity, open loans, income tax and EOBI / SESSI; adjust, then approve. Approval books it; "Mark paid" records the payment.',
    fields: [
      emp(),
      f('lastWorkingDay', 'Last working day', 'date', { required: true, bind: 'endDate' }),
      f('salaryPayable', 'Salary payable', 'money', { system: true }),
      f('otPayable', 'OT payable', 'money', { system: true }),
      f('leaveEncashment', 'Leave encashment', 'money', { system: true }),
      // Gratuity at exit (H6; logic.ts gratuityFor): 30 days of the last gross
      // per counted year, permanent staff with a year or more. Booked to 6036.
      f('gratuity', 'Gratuity', 'money', { system: true, help: '30 days of the last gross salary for each year of service (more than 6 months counts as a year) — permanent staff with at least a year. "Calculate" works it out.' }),
      f('deductions', 'Deductions', 'money', { system: true }),
      f('loanRecovery', 'Advance / loan recovery', 'money', { system: true }),
      // The statutory lines a payslip carries for the same days (logic.ts
      // finalSettlement → computePayslip).
      f('incomeTax', 'Income tax', 'money', { system: true, help: 'The monthly tax on the salary paid. Add any tax on leave encashment by hand.' }),
      f('eobiEmployee', 'EOBI (employee share)', 'money', { system: true }),
      f('eobiEmployer', 'EOBI (employer share)', 'money', { system: true, help: 'Company cost — not taken off the net' }),
      f('sessiEmployer', 'SESSI / PESSI (employer)', 'money', { system: true, help: 'Company cost — not taken off the net' }),
      f('otherAdjustments', 'Other adjustments (+/−)', 'money', { system: true }),
      f('netAmount', 'Net F&F', 'money', { bind: 'amountCents', readOnly: true, system: true }),
      sel('clearanceStatus', 'Clearance status', ['pending', 'cleared']),
      f('paymentDate', 'Payment date', 'date', { bind: 'effectiveDate' }),
    ] },

  { key: 'letters', specNo: 26, title: 'HR letters', group: 'Documents', kind: 'page' },

  // Retired (owner Q1 default, 2026-10-13): EOBI, SESSI and salary tax are
  // paid over in Accounting → Statutory payments, which books them against
  // 2042 / 2043 / 2044. Rows recorded here stay readable (and are listed there
  // as "recorded in HR, not on the books"); no new ones.
  { key: 'eobi_challan', specNo: 27, title: 'EOBI / SESSI payments (moved)', group: 'Compliance', kind: 'record',
    effect: 'EOBI, SESSI and salary tax challans are recorded in Accounting → Statutory payments, which books them. The payments recorded here before are kept for reference.',
    movedTo: {
      path: '/accounting/statutory', label: 'Accounting → Statutory payments',
      message: 'EOBI, SESSI and salary tax challans are recorded in Accounting → Statutory payments',
    },
    fields: [
      sel('scheme', 'Scheme', ['EOBI', 'SESSI'], { required: true }),
      f('month', 'Contribution month', 'date', { required: true, bind: 'effectiveDate' }),
      f('amount', 'Amount paid', 'money', { required: true, bind: 'amountCents' }),
      f('paidOn', 'Paid on', 'date', { bind: 'startDate' }),
      t('challanNo', 'Challan / reference no.'),
      f('challan', 'Challan copy', 'file'),
    ] },

  { key: 'compliance_item', specNo: 27, title: 'Compliance register', group: 'Compliance', kind: 'record',
    fields: [
      t('name', 'Item', { required: true }),
      sel('category', 'Category', ['registration', 'license', 'inspection', 'government_form', 'labour_record', 'tax_record', 'other']),
      t('reference', 'Reference no.'),
      f('issueDate', 'Issue date', 'date', { bind: 'startDate' }),
      f('expiryDate', 'Expiry / renewal date', 'date', { bind: 'endDate' }),
      f('document', 'Document', 'file'),
      f('notes', 'Notes', 'textarea'),
    ] },

  { key: 'ess', specNo: 28, title: 'Employee self-service', group: 'Portals', kind: 'page' },
  { key: 'manager', specNo: 29, title: 'Manager / HOD portal', group: 'Portals', kind: 'page' },
  { key: 'reports', specNo: 30, title: 'HR reports', group: 'Overview', kind: 'page' },
]

export function sectionByKey(key: string): HrSection | undefined {
  return HR_SECTIONS.find((s) => s.key === key)
}

export const RECORD_SECTIONS = HR_SECTIONS.filter((s) => s.kind === 'record')

/** What an employee may raise for themselves through self-service. A shift
 *  swap is always of their OWN shift (the employee field is filled in for
 *  them) and goes to their reporting manager (audit PPL-13). */
export const ESS_SECTIONS = ['leave', 'overtime', 'attendance_correction', 'shift_swap', 'training_request', 'resignation', 'loan']

/**
 * Money in HR is never negative: a deduction is its own kind, not a minus
 * sign. A negative salary was accepted and payroll paid it (audit PPL-07).
 * Enforced whatever a format says (formats are data); the exceptions are the
 * figures logic computes (readOnly) and the few values that are signed by
 * nature, listed here by section.
 */
export const SIGNED_MONEY: Record<string, string[]> = { final_settlement: ['otherAdjustments'] }

/** Labels of money values below zero in a record's data — table cells too. */
export function negativeMoney(section: string, fields: HrField[], data: Record<string, unknown>): string[] {
  const signed = SIGNED_MONEY[section] ?? []
  const bad: string[] = []
  for (const fl of fields) {
    if (fl.readOnly || signed.includes(fl.key)) continue
    const v = data[fl.key]
    if (fl.type === 'money' && typeof v === 'number' && v < 0) bad.push(fl.label)
    if (fl.type === 'table' && Array.isArray(v)) {
      for (const col of fl.columns ?? []) {
        if (col.type !== 'money') continue
        if (v.some((row) => typeof (row as Record<string, unknown> | null)?.[col.key] === 'number' && ((row as Record<string, unknown>)[col.key] as number) < 0)) bad.push(`${fl.label}: ${col.label}`)
      }
    }
  }
  return bad
}

// ─── Validation ──────────────────────────────────────────────────────────────

export interface ValidatedRecord {
  data: Record<string, unknown>
  slots: Partial<Record<RecordSlot, unknown>>
  employee: Record<string, unknown> // employee.<column> bindings
  errors: Array<{ field: string; message: string }>
}

const isEmpty = (v: unknown) => v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0)

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})?)?$/

/**
 * A date as HR means it: YYYY-MM-DD, or a full ISO timestamp. Strict, because
 * `new Date()` is not — it rolls 31 June into 1 July, reads '1' as 2001 and
 * 'June 5' as a date in 2001. The day must exist in its month.
 */
export function parseHrDate(raw: unknown): Date | null {
  const s = String(raw).trim()
  const m = DATE_RE.exec(s)
  if (!m) return null
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3])
  if (y < 1900 || y > 2999 || mo < 1 || mo > 12 || d < 1 || d > new Date(Date.UTC(y, mo, 0)).getUTCDate()) return null
  if (m[4] !== undefined && (Number(m[4]) > 23 || Number(m[5]) > 59 || Number(m[6] ?? 0) > 59)) return null
  const out = new Date(s)
  return Number.isNaN(out.getTime()) ? null : out
}

const TIME_RE = /^([01]?\d|2[0-3]):([0-5]\d)$/

function coerce(field: HrField, raw: unknown): { value: unknown; error?: string } {
  if (isEmpty(raw)) return { value: null }
  switch (field.type) {
    case 'number': case 'percent': {
      const n = typeof raw === 'number' ? raw : Number(raw)
      if (!Number.isFinite(n)) return { value: null, error: 'must be a number' }
      if (field.integer && !Number.isInteger(n)) return { value: null, error: 'must be a whole number' }
      if (field.min !== undefined && n < field.min) return { value: null, error: `must be at least ${field.min}` }
      return { value: n }
    }
    case 'money': {
      // Money is integer paisa everywhere in servd. The admin converts rupees.
      const n = typeof raw === 'number' ? raw : Number(raw)
      if (!Number.isFinite(n)) return { value: null, error: 'must be an amount' }
      if (field.min !== undefined && n < field.min) return { value: null, error: field.min === 0 ? 'cannot be negative' : `must be at least ${field.min}` }
      return { value: Math.round(n) }
    }
    case 'date': case 'datetime': {
      const d = parseHrDate(raw)
      return d ? { value: d.toISOString() } : { value: null, error: 'must be a real date (YYYY-MM-DD)' }
    }
    case 'time': {
      const m = TIME_RE.exec(String(raw).trim())
      return m ? { value: `${m[1]!.padStart(2, '0')}:${m[2]}` } : { value: null, error: 'must be a time between 00:00 and 23:59' }
    }
    case 'boolean':
      return { value: raw === true || raw === 'true' || raw === 1 || raw === 'yes' }
    case 'select':
      if (field.options && !field.options.includes(String(raw))) return { value: null, error: `must be one of: ${field.options.join(', ')}` }
      return { value: String(raw) }
    case 'multiselect': case 'employees': {
      const arr = Array.isArray(raw) ? raw.map(String) : String(raw).split(',').map((s) => s.trim()).filter(Boolean)
      if (field.type === 'multiselect' && field.options) {
        const bad = arr.filter((a) => !field.options!.includes(a))
        if (bad.length) return { value: null, error: `unknown option: ${bad.join(', ')}` }
      }
      return { value: arr }
    }
    case 'email':
      return /^\S+@\S+\.\S+$/.test(String(raw)) ? { value: String(raw).trim() } : { value: null, error: 'must be an email address' }
    case 'table': {
      // Each row is checked like a small form: a bad cell is an error, never
      // quietly saved as blank.
      if (!Array.isArray(raw)) return { value: null, error: 'must be a list' }
      const rows: Array<Record<string, unknown>> = []
      const errors: string[] = []
      raw.forEach((row, i) => {
        if (!row || typeof row !== 'object' || Array.isArray(row)) { errors.push(`row ${i + 1} is not a row`); return }
        const v = validateAgainst(field.columns ?? [], row as Record<string, unknown>)
        for (const e of v.errors) errors.push(`row ${i + 1}: ${e.message}`)
        rows.push(v.data)
      })
      return errors.length ? { value: null, error: errors.join(', ') } : { value: rows }
    }
    default:
      return { value: typeof raw === 'string' ? raw.trim() : raw }
  }
}

/**
 * Coerce submitted values against a format, and pull out the bound slots.
 *
 * A readOnly field is computed by logic, so it is never taken from the input —
 * whatever the client sends for it is ignored. An edit passes `stored` (the
 * record's current data) and keeps the stored value.
 */
export function validateAgainst(fields: HrField[], input: Record<string, unknown>, opts: { partial?: boolean; stored?: Record<string, unknown> } = {}): ValidatedRecord {
  const out: ValidatedRecord = { data: {}, slots: {}, employee: {}, errors: [] }
  for (const field of fields) {
    if (field.readOnly) {
      if (opts.stored && field.key in opts.stored) out.data[field.key] = opts.stored[field.key]
      continue
    }
    const has = field.key in input
    if (!has && opts.partial) continue
    const { value, error } = coerce(field, input[field.key])
    if (error) { out.errors.push({ field: field.key, message: `${field.label} ${error}` }); continue }
    if (field.required && isEmpty(value) && !opts.partial) {
      out.errors.push({ field: field.key, message: `${field.label} is required` })
      continue
    }
    if (field.bind?.startsWith('employee.')) out.employee[field.bind.slice('employee.'.length)] = value
    else if (field.bind) out.slots[field.bind as RecordSlot] = value
    out.data[field.key] = value
  }
  return out
}

// What kind of field may fill each slot. Logic reads a slot as typed data —
// an employee id, a date, paisa — so the field bound to it must produce that:
// a text field on employeeId would skip the company check on references, and
// a plain number on amountCents would skip the rupee-to-paisa conversion.
const DATE_TYPES: FieldType[] = ['date', 'datetime']
const SLOT_TYPES: Record<RecordSlot, FieldType[]> = {
  employeeId: ['employee'],
  startDate: DATE_TYPES, endDate: DATE_TYPES, effectiveDate: DATE_TYPES,
  quantity: ['number', 'percent'],
  amountCents: ['money'],
  refId: ['record', 'orgunit', 'location', 'department', 'employee'],
  category: ['select'],
}

/** The same for Employee Master columns. A column holding an id is filled
 *  only by the matching reference field (and org unit kind), never by text.
 *  Columns not listed hold text. */
export const EMPLOYEE_COLUMN_TYPES: Record<string, { types: FieldType[]; ref?: string }> = {
  departmentId: { types: ['department'] },
  designationId: { types: ['orgunit'], ref: 'designation' },
  gradeId: { types: ['orgunit'], ref: 'grade' },
  locationId: { types: ['location'] },
  managerId: { types: ['employee'] },
  cnicExpiry: { types: DATE_TYPES }, dateOfBirth: { types: DATE_TYPES }, joiningDate: { types: DATE_TYPES },
  probationEnd: { types: DATE_TYPES }, confirmationDate: { types: DATE_TYPES }, contractEnd: { types: DATE_TYPES },
  lastWorkingDay: { types: DATE_TYPES },
  noticePeriodDays: { types: ['number'] },
  basicSalaryCents: { types: ['money'] }, grossSalaryCents: { types: ['money'] }, monthlyTaxCents: { types: ['money'] },
  employmentType: { types: ['select'] }, status: { types: ['select'] },
}
const TEXT_COLUMN_TYPES: FieldType[] = ['text', 'textarea', 'email', 'phone', 'select', 'file']

/**
 * Choice values logic compares literally, by section and binding. A format
 * must keep every value in `keep` — HR relabels what a value is called in the
 * label, not the value. Where `closed` is set, HR may drop the other values
 * but add none: logic would put an unknown value in a branch that pays wrongly.
 * Without `closed`, an added value falls into the harmless default noted.
 */
export const SYSTEM_OPTIONS: Record<string, Array<{ bind: string; keep: string[]; closed?: string[] }>> = {
  // Payroll deducts 'deduction' and 'other_deduction' and pays everything else
  // as an earning — a new "fine" would be paid out, so no new kinds.
  payroll_adjustment: [{ bind: 'category', keep: ['deduction', 'other_deduction'], closed: ['bonus', 'incentive', 'allowance', 'arrears', 'deduction', 'other_deduction'] }],
  // Anything but 'unpaid' is paid leave off the balance, so no third kind.
  leave_type: [{ bind: 'category', keep: ['paid', 'unpaid'], closed: ['paid', 'unpaid'] }],
  // Payroll docks absent, half_day and late; the dashboard counts present. A
  // status HR adds docks nothing, like present — a payslip edit covers the rest.
  attendance: [{ bind: 'category', keep: ['present', 'absent', 'late', 'half_day'] }],
  // confirm and extend write to the employee. Any other outcome (terminate, or
  // one HR adds) writes nothing — a termination has its own approval.
  probation_review: [{ bind: 'category', keep: ['confirm', 'extend'] }],
  employees: [
    // Approvals write resigned/terminated, payroll leaves out separated, and
    // active/on_leave are the current staff. A status HR adds is simply not
    // current; the person is still paid for the days they were employed.
    { bind: 'employee.status', keep: EMPLOYEE_STATUSES },
    // Probation and contract end dates are tracked; confirmation writes
    // permanent. Another type gets no reminders.
    { bind: 'employee.employmentType', keep: ['permanent', 'probation', 'contract'] },
  ],
}

const FIELD_TYPES: FieldType[] = ['text', 'textarea', 'number', 'money', 'percent', 'date', 'time', 'datetime', 'select', 'multiselect', 'boolean', 'email', 'phone', 'file', 'employee', 'employees', 'location', 'department', 'orgunit', 'record', 'table']

/** Problems with one field on its own — also run on a table's columns. */
function fieldProblems(fl: HrField): string[] {
  const problems: string[] = []
  if (!fl.key || !/^[a-zA-Z][a-zA-Z0-9_]*$/.test(fl.key)) problems.push(`"${fl.label || fl.key}" needs a key made of letters, digits and underscores`)
  if (!fl.label) problems.push(`Field "${fl.key}" has no label`)
  if (!FIELD_TYPES.includes(fl.type)) problems.push(`Field "${fl.key}" has an unknown type "${fl.type}"`)
  if ((fl.type === 'select' || fl.type === 'multiselect') && !(fl.options?.length)) problems.push(`"${fl.label}" is a choice field with no options`)
  if ((fl.type === 'record' || fl.type === 'orgunit') && !fl.ref) problems.push(`"${fl.label}" must say what it points to`)
  if (fl.type === 'record' && fl.ref && !RECORD_SECTIONS.some((s) => s.key === fl.ref)) problems.push(`"${fl.label}" points to "${fl.ref}", which is not an HR record section`)
  if (fl.type === 'orgunit' && fl.ref && !(ORG_UNIT_KINDS as readonly string[]).includes(fl.ref)) problems.push(`"${fl.label}" points to "${fl.ref}", which is not an org unit kind`)
  return problems
}

/** Which field types may bind `bind`, and the org unit kind or record section they must point at. */
function bindTypes(bind: string): { types: FieldType[]; ref?: string } {
  if (bind.startsWith('employee.')) return EMPLOYEE_COLUMN_TYPES[bind.slice('employee.'.length)] ?? { types: TEXT_COLUMN_TYPES }
  return { types: SLOT_TYPES[bind as RecordSlot] ?? [] }
}

/**
 * A saved format with the section's default SYSTEM fields it is missing put
 * back: the ones logic reads that were added to the default after a company
 * saved its own (a full & final's 'gratuity', finance wave B). Without them
 * validateAgainst would drop the value on save, and checkFormat would refuse
 * the format's next edit. Each goes in after the default field it follows,
 * when the saved format has that one, else at the end; a binding the saved
 * format already gives another field is left off. checkFormat forbids
 * removing a system field, so this only ever restores newer ones.
 */
export function withSystemFields(section: HrSection, fields: HrField[]): HrField[] {
  const defaults = section.fields ?? []
  const missing = defaults.filter((d) => d.system && !fields.some((x) => x.key === d.key))
  if (missing.length === 0) return fields
  const out = [...fields]
  const bound = new Set(out.map((x) => x.bind).filter((b): b is NonNullable<HrField['bind']> => !!b))
  for (const sys of missing) {
    let field: HrField = { ...sys }
    if (sys.bind && bound.has(sys.bind)) {
      const { bind: _unused, ...rest } = sys
      void _unused
      field = rest
    }
    if (field.bind) bound.add(field.bind)
    const di = defaults.indexOf(sys)
    let at = out.length
    for (let i = di - 1; i >= 0; i--) {
      const j = out.findIndex((x) => x.key === defaults[i]!.key)
      if (j >= 0) { at = j + 1; break }
    }
    out.splice(at, 0, field)
  }
  return out
}

/**
 * Check a format a person is trying to save. Refuses one that would silently
 * break the section: a missing binding logic depends on, a field whose type
 * doesn't fit what it is bound to, a choice value logic compares against,
 * duplicate keys, a select with no options, a reference with nowhere to point.
 *
 * A section employees raise for themselves must keep an approval step (or a
 * request would approve itself) and its employee field (or the request would
 * belong to nobody, and nobody would be its "own" requester).
 */
export function checkFormat(section: HrSection, fields: HrField[], workflow?: WorkflowStep[]): string[] {
  const problems: string[] = []
  const seen = new Set<string>()
  const bound = new Set<string>()
  for (const fl of fields) {
    problems.push(...fieldProblems(fl))
    if (seen.has(fl.key)) problems.push(`Two fields use the key "${fl.key}"`)
    seen.add(fl.key)
    if (fl.type === 'table') {
      if (!(fl.columns?.length)) problems.push(`"${fl.label}" is a table with no columns`)
      for (const col of fl.columns ?? []) {
        problems.push(...fieldProblems(col).map((p) => `${fl.label}: ${p}`))
        if (col.type === 'table') problems.push(`${fl.label}: "${col.label}" — a table cannot hold another table`)
        if (col.bind) problems.push(`${fl.label}: "${col.label}" — a table column cannot be bound`)
      }
    }
    if (fl.bind) {
      if (bound.has(fl.bind)) problems.push(`Two fields are bound to ${fl.bind}`)
      bound.add(fl.bind)
      const want = bindTypes(fl.bind)
      if (!want.types.includes(fl.type)) problems.push(`"${fl.label}" is bound to ${fl.bind}, which takes a ${want.types.join(' or ')} field — not ${fl.type}`)
      else if (want.ref && fl.ref !== want.ref) problems.push(`"${fl.label}" is bound to ${fl.bind}, so it must point to ${want.ref}`)
    }
  }
  const defaults = section.fields ?? []
  for (const sys of defaults.filter((x) => x.system)) {
    const kept = fields.find((x) => x.key === sys.key)
    if (!kept) problems.push(`"${sys.label}" (${sys.key}) is used by this section's calculations and cannot be removed — relabel it instead`)
    else if (kept.type !== sys.type) problems.push(`"${sys.label}" must stay a ${sys.type} field`)
  }
  for (const slot of section.requires ?? []) {
    const kept = fields.find((x) => x.bind === slot)
    if (!kept) {
      problems.push(`This section's calculations need a field bound to "${slot}" — keep one, or bind a new field to it`)
      continue
    }
    // Logic reads the reference as a particular thing (a leave's refId is its
    // leave type), so it must keep pointing at it.
    const was = defaults.find((x) => x.bind === slot)
    if (was?.ref && (kept.type !== was.type || kept.ref !== was.ref)) problems.push(`"${kept.label}" is bound to ${slot}, so it must point to ${was.ref}`)
  }
  for (const rule of SYSTEM_OPTIONS[section.key] ?? []) {
    const fl = fields.find((x) => x.bind === rule.bind)
    if (!fl || fl.type !== 'select') continue
    const missing = rule.keep.filter((o) => !(fl.options ?? []).includes(o))
    if (missing.length) problems.push(`"${fl.label}" must keep the choice${missing.length > 1 ? 's' : ''} ${missing.join(', ')} — the calculations look for ${missing.length > 1 ? 'them' : 'it'}`)
    const extra = rule.closed ? (fl.options ?? []).filter((o) => !rule.closed!.includes(o)) : []
    if (extra.length) problems.push(`"${fl.label}" cannot have new choices (${extra.join(', ')}) — the calculations would not know what to do with them. It may use: ${rule.closed!.join(', ')}`)
  }
  // An approval is recorded against its step's key, so two steps sharing one
  // would both read as decided when only the first was.
  const stepKeys = new Set<string>()
  for (const w of workflow ?? []) {
    if (stepKeys.has(w.key)) problems.push(`Two approval steps use the key "${w.key}"`)
    stepKeys.add(w.key)
  }
  if (ESS_SECTIONS.includes(section.key)) {
    if (!bound.has('employeeId') && !(section.requires ?? []).includes('employeeId')) {
      problems.push('Employees raise this for themselves, so it needs a field bound to "employeeId"')
    }
    if (workflow && workflow.length === 0) {
      problems.push('Employees raise this for themselves, so it needs at least one approval step')
    }
  }
  return problems
}
