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
}

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
  f('basicSalaryCents', 'Basic salary', 'money', { group: 'Compensation', bind: 'employee.basicSalaryCents' }),
  f('grossSalaryCents', 'Gross salary', 'money', { group: 'Compensation', bind: 'employee.grossSalaryCents' }),
  f('allowances', 'Allowances', 'table', {
    group: 'Compensation',
    columns: [t('name', 'Allowance'), f('amountCents', 'Amount', 'money')],
    help: 'Part of gross — listed for the payslip breakdown',
  }),
  t('salaryStructure', 'Salary structure', { group: 'Compensation' }),
  sel('paymentMethod', 'Payment method', ['bank', 'cash', 'cheque'], { group: 'Compensation', bind: 'employee.paymentMethod' }),
  t('bankName', 'Bank name', { group: 'Compensation', bind: 'employee.bankName' }),
  t('iban', 'Account / IBAN', { group: 'Compensation', bind: 'employee.iban' }),
  f('monthlyTaxCents', 'Monthly income tax', 'money', { group: 'Compensation', bind: 'employee.monthlyTaxCents', help: 'Deducted each payroll until slab-based tax is built' }),
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
    fields: [
      emp(),
      f('date', 'Date', 'date', { required: true, bind: 'startDate' }),
      f('location', 'Branch', 'location'),
      f('shift', 'Shift', 'record', { ref: 'shift', bind: 'refId' }),
      f('checkIn', 'Check-in', 'time'),
      f('checkOut', 'Check-out', 'time'),
      sel('status', 'Status', ['present', 'absent', 'late', 'early_departure', 'half_day', 'missing_punch', 'off_day', 'holiday'], { required: true, bind: 'category' }),
      f('lateMinutes', 'Late by (minutes)', 'number', { bind: 'quantity' }),
      f('remarks', 'Remarks', 'textarea'),
    ] },

  { key: 'attendance_correction', specNo: 9, title: 'Attendance corrections', group: 'Time', kind: 'record',
    workflow: [HOD, HR],
    fields: [
      emp(),
      f('date', 'Date', 'date', { required: true, bind: 'startDate' }),
      sel('type', 'Request', ['regularization', 'missed_punch'], { required: true }),
      f('correctedIn', 'Correct check-in', 'time'),
      f('correctedOut', 'Correct check-out', 'time'),
      f('reason', 'Reason / remarks', 'textarea', { required: true }),
    ] },

  { key: 'shift', specNo: 10, title: 'Shift master', group: 'Time', kind: 'record', config: true,
    fields: [
      t('name', 'Shift name', { required: true }),
      f('start', 'Start time', 'time', { required: true }),
      f('end', 'End time', 'time', { required: true }),
      f('breakMinutes', 'Break (minutes)', 'number'),
      f('graceMinutes', 'Grace period (minutes)', 'number'),
      f('location', 'Branch', 'location'),
    ] },

  { key: 'roster', specNo: 10, title: 'Roster / shift assignment', group: 'Time', kind: 'record',
    workflow: [HOD],
    fields: [
      emp(),
      f('shift', 'Shift', 'record', { ref: 'shift', required: true, bind: 'refId' }),
      f('from', 'From', 'date', { required: true, bind: 'startDate' }),
      f('to', 'To', 'date', { bind: 'endDate' }),
      f('weeklyOff', 'Weekly off', 'multiselect', { options: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'] }),
      f('location', 'Branch', 'location'),
    ] },

  { key: 'shift_swap', specNo: 10, title: 'Shift change / swap', group: 'Time', kind: 'record',
    workflow: [HOD],
    fields: [
      emp(),
      f('swapWith', 'Swap with', 'employee'),
      f('date', 'Date', 'date', { required: true, bind: 'startDate' }),
      f('fromShift', 'From shift', 'record', { ref: 'shift' }),
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
      f('carryForward', 'Carry forward', 'boolean'),
      f('maxCarryForward', 'Max carry forward (days)', 'number'),
    ] },

  { key: 'leave', specNo: 12, title: 'Leave applications', group: 'Time', kind: 'record',
    workflow: [HOD, HR], requires: ['employeeId', 'startDate', 'endDate', 'refId'],
    effect: 'Approved leave comes off the balance. Unpaid leave is deducted in payroll.',
    fields: [
      emp(),
      f('leaveType', 'Leave type', 'record', { ref: 'leave_type', required: true, bind: 'refId' }),
      f('from', 'From', 'date', { required: true, bind: 'startDate' }),
      f('to', 'To', 'date', { required: true, bind: 'endDate' }),
      f('days', 'Days', 'number', { bind: 'quantity', help: 'Calculated from the dates if left blank' }),
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
      f('amount', 'Amount', 'money', { required: true, bind: 'amountCents' }),
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
    workflow: [HOD, HR],
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
    effect: 'Once approved, one installment is deducted in each payroll from the first deduction month until repaid.',
    fields: [
      emp(),
      sel('type', 'Type', ['advance', 'loan'], { required: true, bind: 'category' }),
      f('amount', 'Amount', 'money', { required: true, bind: 'amountCents' }),
      f('date', 'Date', 'date', { bind: 'startDate' }),
      f('installments', 'Number of installments', 'number', { required: true, bind: 'quantity' }),
      f('firstDeduction', 'First deduction month', 'date', { required: true, bind: 'effectiveDate' }),
      f('reason', 'Reason', 'textarea'),
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
    effect: 'Use "Calculate" to fill the figures from salary, OT, leave balance and open loans; adjust, then approve.',
    fields: [
      emp(),
      f('lastWorkingDay', 'Last working day', 'date', { required: true, bind: 'endDate' }),
      f('salaryPayable', 'Salary payable', 'money', { system: true }),
      f('otPayable', 'OT payable', 'money', { system: true }),
      f('leaveEncashment', 'Leave encashment', 'money', { system: true }),
      f('deductions', 'Deductions', 'money', { system: true }),
      f('loanRecovery', 'Advance / loan recovery', 'money', { system: true }),
      f('otherAdjustments', 'Other adjustments (+/−)', 'money', { system: true }),
      f('netAmount', 'Net F&F', 'money', { bind: 'amountCents', readOnly: true, system: true }),
      sel('clearanceStatus', 'Clearance status', ['pending', 'cleared']),
      f('paymentDate', 'Payment date', 'date', { bind: 'effectiveDate' }),
    ] },

  { key: 'letters', specNo: 26, title: 'HR letters', group: 'Documents', kind: 'page' },

  { key: 'eobi_challan', specNo: 27, title: 'EOBI / SESSI payments', group: 'Compliance', kind: 'record',
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

// ─── Validation ──────────────────────────────────────────────────────────────

export interface ValidatedRecord {
  data: Record<string, unknown>
  slots: Partial<Record<RecordSlot, unknown>>
  employee: Record<string, unknown> // employee.<column> bindings
  errors: Array<{ field: string; message: string }>
}

const isEmpty = (v: unknown) => v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0)

function coerce(field: HrField, raw: unknown): { value: unknown; error?: string } {
  if (isEmpty(raw)) return { value: null }
  switch (field.type) {
    case 'number': case 'percent': {
      const n = typeof raw === 'number' ? raw : Number(raw)
      return Number.isFinite(n) ? { value: n } : { value: null, error: 'must be a number' }
    }
    case 'money': {
      // Money is integer paisa everywhere in servd. The admin converts rupees.
      const n = typeof raw === 'number' ? raw : Number(raw)
      if (!Number.isFinite(n)) return { value: null, error: 'must be an amount' }
      return { value: Math.round(n) }
    }
    case 'date': case 'datetime': {
      const d = new Date(String(raw))
      return Number.isNaN(d.getTime()) ? { value: null, error: 'must be a date' } : { value: d.toISOString() }
    }
    case 'time':
      return /^\d{1,2}:\d{2}$/.test(String(raw)) ? { value: String(raw) } : { value: null, error: 'must be HH:MM' }
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
      if (!Array.isArray(raw)) return { value: null, error: 'must be a list' }
      const rows = raw.map((row) => {
        const out: Record<string, unknown> = {}
        for (const col of field.columns ?? []) out[col.key] = coerce(col, (row as Record<string, unknown>)?.[col.key]).value
        return out
      })
      return { value: rows }
    }
    default:
      return { value: typeof raw === 'string' ? raw.trim() : raw }
  }
}

/** Coerce submitted values against a format, and pull out the bound slots. */
export function validateAgainst(fields: HrField[], input: Record<string, unknown>, opts: { partial?: boolean } = {}): ValidatedRecord {
  const out: ValidatedRecord = { data: {}, slots: {}, employee: {}, errors: [] }
  for (const field of fields) {
    if (field.readOnly && !(field.key in input)) continue
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

/**
 * Check a format a person is trying to save. Refuses one that would silently
 * break the section: a missing binding logic depends on, duplicate keys, a
 * select with no options, a reference with nowhere to point.
 */
export function checkFormat(section: HrSection, fields: HrField[]): string[] {
  const problems: string[] = []
  const seen = new Set<string>()
  const TYPES: FieldType[] = ['text', 'textarea', 'number', 'money', 'percent', 'date', 'time', 'datetime', 'select', 'multiselect', 'boolean', 'email', 'phone', 'file', 'employee', 'employees', 'location', 'department', 'orgunit', 'record', 'table']
  const bound = new Set<string>()
  for (const fl of fields) {
    if (!fl.key || !/^[a-zA-Z][a-zA-Z0-9_]*$/.test(fl.key)) problems.push(`"${fl.label || fl.key}" needs a key made of letters, digits and underscores`)
    if (seen.has(fl.key)) problems.push(`Two fields use the key "${fl.key}"`)
    seen.add(fl.key)
    if (!fl.label) problems.push(`Field "${fl.key}" has no label`)
    if (!TYPES.includes(fl.type)) problems.push(`Field "${fl.key}" has an unknown type "${fl.type}"`)
    if ((fl.type === 'select' || fl.type === 'multiselect') && !(fl.options?.length)) problems.push(`"${fl.label}" is a choice field with no options`)
    if ((fl.type === 'record' || fl.type === 'orgunit') && !fl.ref) problems.push(`"${fl.label}" must say what it points to`)
    if (fl.type === 'table' && !(fl.columns?.length)) problems.push(`"${fl.label}" is a table with no columns`)
    if (fl.bind) {
      if (bound.has(fl.bind)) problems.push(`Two fields are bound to ${fl.bind}`)
      bound.add(fl.bind)
    }
  }
  for (const sys of (section.fields ?? []).filter((x) => x.system)) {
    const kept = fields.find((x) => x.key === sys.key)
    if (!kept) problems.push(`"${sys.label}" (${sys.key}) is used by this section's calculations and cannot be removed — relabel it instead`)
    else if (kept.type !== sys.type) problems.push(`"${sys.label}" must stay a ${sys.type} field`)
  }
  for (const slot of section.requires ?? []) {
    if (!bound.has(slot)) {
      problems.push(`This section's calculations need a field bound to "${slot}" — keep one, or bind a new field to it`)
    }
  }
  return problems
}
