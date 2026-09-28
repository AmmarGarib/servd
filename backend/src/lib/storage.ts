// Cloudflare R2 / S3-compatible file storage
// Returns presigned URLs for direct browser uploads

import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { nanoid } from 'nanoid'
import path from 'path'

const client = new S3Client({
  region: 'auto',
  endpoint: `https://${process.env['R2_ACCOUNT_ID']}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env['R2_ACCESS_KEY_ID'] ?? '',
    secretAccessKey: process.env['R2_SECRET_ACCESS_KEY'] ?? '',
  },
})

const BUCKET = process.env['R2_BUCKET_NAME'] ?? 'servd-media'
const PUBLIC_URL = process.env['R2_PUBLIC_URL'] ?? ''
const PRESIGN_EXPIRY_SECONDS = 300 // 5 minutes

const ALLOWED_TYPES = [
  'image/jpeg', 'image/png', 'image/webp', 'image/gif',
  // Video — used by the storefront landing hero (operators upload a short
  // background/foreground clip). Kept to web-friendly containers.
  'video/mp4', 'video/webm', 'video/quicktime',
]

// `extraTypes`: types a caller has already validated for its own purpose (the
// content library passes the font types it accepts for .woff2/.woff/.ttf/.otf).
export async function getSignedUploadUrl(filename: string, contentType: string, folder = 'menu', extraTypes: readonly string[] = []) {
  if (!ALLOWED_TYPES.includes(contentType) && !extraTypes.includes(contentType)) {
    throw new Error(`Content type '${contentType}' not allowed`)
  }

  const ext = path.extname(filename)
  const key = `${folder}/${nanoid()}${ext}`

  const command = new PutObjectCommand({
    Bucket: BUCKET,
    Key: key,
    ContentType: contentType,
  })

  const uploadUrl = await getSignedUrl(client, command, { expiresIn: PRESIGN_EXPIRY_SECONDS })
  const publicUrl = `${PUBLIC_URL}/${key}`

  return { uploadUrl, publicUrl, key }
}
