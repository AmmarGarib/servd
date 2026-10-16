// Record files — the admin side of the ONE private store for supporting
// documents on any record (backend lib/recordFiles.ts, API /record-files;
// owner, 2026-10-16: files, never a URL). Used by <RecordFiles> (a saved
// record) and <PendingFilesPicker> + uploadRecordFiles (a create form: create
// the record through its own route first, then upload to its id).

import { api } from '../../lib/api'
import { preparePhoto, prepareReceiptFile } from '../../lib/photoPrep'

/** The record types the API knows (backend modules/recordFiles/providers.ts). */
export type RecordOwnerType = 'opex_payment' | 'supplier_bill' | 'goods_receipt' | 'prep_batch' | 'hr_document' | 'fixed_asset'

/** Types that also take Office / CSV / text documents (the server decides; this only shapes the picker). */
export const OFFICE_OWNER_TYPES: ReadonlySet<RecordOwnerType> = new Set(['supplier_bill', 'hr_document', 'fixed_asset'])

export const RECORD_FILES_MAX = 10
export const RECORD_FILES_PER_UPLOAD = 5
/** The server's largest decoded file (lib/evidenceFile.ts). Photos are compressed first, so this caps PDFs / documents. */
export const RECORD_FILE_MAX_BYTES = 3 * 1024 * 1024

const PHOTO_PDF_ACCEPT = 'image/jpeg,image/png,image/webp,image/heic,image/heif,application/pdf'
const OFFICE_ACCEPT = '.pdf,.jpg,.jpeg,.png,.webp,.heic,.heif,.xlsx,.xls,.docx,.doc,.pptx,.ppt,.csv,.txt'
export const acceptFor = (ownerType: RecordOwnerType) => (OFFICE_OWNER_TYPES.has(ownerType) ? OFFICE_ACCEPT : PHOTO_PDF_ACCEPT)

/** One stored file (metadata — the bytes are fetched on View / Download). */
export interface RecordFile { id: string; fileName: string | null; mime: string; sizeBytes: number; createdAt: string; uploadedByName: string | null }
/** A chosen file, ready to send. */
export interface PickedFile { fileName: string; mime: string; dataBase64: string; bytes: number }

export const recordFilesPath = (ownerType: RecordOwnerType, ownerId: string) => `/record-files/${ownerType}/${encodeURIComponent(ownerId)}`
export const recordFilePath = (ownerType: RecordOwnerType, ownerId: string, fileId: string) => `${recordFilesPath(ownerType, ownerId)}/${encodeURIComponent(fileId)}`
export const recordFilesKey = (ownerType: RecordOwnerType, ownerId: string) => ['record-files', ownerType, ownerId] as const

const MIME_BY_EXT: Record<string, string> = {
  pdf: 'application/pdf',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', xls: 'application/vnd.ms-excel',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', doc: 'application/msword',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', ppt: 'application/vnd.ms-powerpoint',
  csv: 'text/csv', txt: 'text/plain',
}
const PHOTO_EXT = new Set(['jpg', 'jpeg', 'png', 'webp', 'heic', 'heif'])
const extOf = (name: string) => (name.includes('.') ? (name.split('.').pop() ?? '').toLowerCase() : '')

function fileToBase64(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => { const s = String(r.result ?? ''); resolve(s.slice(s.indexOf(',') + 1)) }
    r.onerror = () => reject(new Error('This browser could not read the file.'))
    r.readAsDataURL(file)
  })
}

/** Photos are compressed to JPEG (lib/photoPrep); a PDF (and, where allowed, an Office / text file) goes up as it is. */
export async function prepareRecordFile(file: File, ownerType: RecordOwnerType): Promise<PickedFile> {
  const ext = extOf(file.name)
  const base = file.name.replace(/\.[^.]+$/, '') || 'file'
  if (file.type.startsWith('image/') || PHOTO_EXT.has(ext)) {
    const p = await preparePhoto(file)
    if (p.previewUrl) URL.revokeObjectURL(p.previewUrl)
    return { fileName: `${base}.jpg`, mime: p.mime, dataBase64: p.base64, bytes: p.bytes }
  }
  if (file.type === 'application/pdf' || ext === 'pdf') {
    const p = await prepareReceiptFile(new File([file], file.name, { type: 'application/pdf' }))
    return { fileName: ext === 'pdf' ? file.name : `${base}.pdf`, mime: p.mime, dataBase64: p.base64, bytes: p.bytes }
  }
  const mime = MIME_BY_EXT[ext]
  if (!mime || !OFFICE_OWNER_TYPES.has(ownerType)) {
    throw new Error(OFFICE_OWNER_TYPES.has(ownerType)
      ? `${file.name}: not accepted. Use a PDF, a photo, or an Excel, Word, PowerPoint, CSV or text file.`
      : `${file.name}: pick a photo or a PDF.`)
  }
  if (file.size === 0) throw new Error(`${file.name}: the file is empty.`)
  if (file.size > RECORD_FILE_MAX_BYTES) throw new Error(`${file.name} is larger than 3 MB.`)
  return { fileName: file.name, mime, dataBase64: await fileToBase64(file), bytes: file.size }
}

/** Prepare every picked file, refusing more than `room` (what the record still takes). */
export async function pickRecordFiles(list: FileList | File[] | null, ownerType: RecordOwnerType, room: number): Promise<PickedFile[]> {
  const files = Array.from(list ?? [])
  if (files.length > room) {
    throw new Error(room <= 0 ? `This record already has ${RECORD_FILES_MAX} files.` : `You can add ${room} more file${room === 1 ? '' : 's'} (at most ${RECORD_FILES_MAX}).`)
  }
  const out: PickedFile[] = []
  for (const f of files) out.push(await prepareRecordFile(f, ownerType))
  return out
}

/**
 * Upload files to a record that already exists (e.g. right after a create
 * form saved it), five per request. `tenantId` pins the write to the record's
 * company when the screen is in portfolio view (same as api.post's).
 */
export async function uploadRecordFiles(
  ownerType: RecordOwnerType, ownerId: string, files: readonly PickedFile[], opts: { tenantId?: string } = {},
): Promise<RecordFile[]> {
  const saved: RecordFile[] = []
  for (let i = 0; i < files.length; i += RECORD_FILES_PER_UPLOAD) {
    const chunk = files.slice(i, i + RECORD_FILES_PER_UPLOAD).map(({ fileName, mime, dataBase64 }) => ({ fileName, mime, dataBase64 }))
    const r = await api.post<{ files: RecordFile[] }>(recordFilesPath(ownerType, ownerId), { files: chunk }, opts.tenantId ? { tenantId: opts.tenantId } : undefined)
    saved.push(...r.files)
  }
  return saved
}

/** Body shape for routes that take files inline (the dock receive's `photos`). */
export const asUploadBody = (files: readonly PickedFile[]) => files.map(({ fileName, mime, dataBase64 }) => ({ fileName, mime, dataBase64 }))
