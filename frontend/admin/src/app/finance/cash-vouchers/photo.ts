'use client'
// Files on a cash request (receipts; on old vouchers the photo of the signed
// paper): the one copy of the photo helpers lives in lib/photoPrep.ts and is
// re-exported here for the request pages. Files are read back with the session
// attached — the API serves one only to a login that may open the request.

import { fetchEvidenceUrl } from '../../../lib/photoPrep'
import { CV_BASE } from './data'

export { preparePhoto, prepareReceiptFile, kb, type PreparedPhoto } from '../../../lib/photoPrep'

/** The API path of one file on a request. */
export const attachmentPath = (id: string, aid: string) => `${CV_BASE}/${id}/attachments/${aid}`

/** A blob URL for one file on a request (the caller revokes it). */
export function fetchAttachmentUrl(id: string, aid: string): Promise<string> {
  return fetchEvidenceUrl(attachmentPath(id, aid))
}
