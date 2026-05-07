// Meta Graph API client for Instagram Business + Facebook Pages publishing.
// Requires env vars: FACEBOOK_APP_ID, FACEBOOK_APP_SECRET
// Tokens stored in Settings table: fb_page_token, fb_page_id, ig_user_id

import { prisma } from './prisma.js'

const GRAPH = 'https://graph.facebook.com/v19.0'

async function getSetting(key: string): Promise<string | null> {
  const row = await prisma.setting.findUnique({ where: { key } })
  return row?.value ?? null
}

export async function getOAuthUrl(redirectUri: string): Promise<string> {
  const appId = process.env['FACEBOOK_APP_ID']
  if (!appId) throw new Error('FACEBOOK_APP_ID not configured')
  const scope = [
    'pages_manage_posts',
    'pages_read_engagement',
    'instagram_basic',
    'instagram_content_publish',
  ].join(',')
  const params = new URLSearchParams({ client_id: appId, redirect_uri: redirectUri, scope, response_type: 'code' })
  return `https://www.facebook.com/dialog/oauth?${params}`
}

export async function exchangeCodeForTokens(code: string, redirectUri: string) {
  const appId     = process.env['FACEBOOK_APP_ID']
  const appSecret = process.env['FACEBOOK_APP_SECRET']
  if (!appId || !appSecret) throw new Error('Facebook app credentials not configured')

  // Short-lived user token
  const tokenRes = await fetch(
    `${GRAPH}/oauth/access_token?client_id=${appId}&client_secret=${appSecret}&redirect_uri=${encodeURIComponent(redirectUri)}&code=${code}`,
  )
  const tokenData = (await tokenRes.json()) as { access_token?: string; error?: { message: string } }
  if (!tokenData.access_token) throw new Error(tokenData.error?.message ?? 'Token exchange failed')

  // Exchange for long-lived token
  const longRes = await fetch(
    `${GRAPH}/oauth/access_token?grant_type=fb_exchange_token&client_id=${appId}&client_secret=${appSecret}&fb_exchange_token=${tokenData.access_token}`,
  )
  const longData = (await longRes.json()) as { access_token?: string; error?: { message: string } }
  if (!longData.access_token) throw new Error(longData.error?.message ?? 'Long-lived token exchange failed')

  // Get pages
  const pagesRes = await fetch(`${GRAPH}/me/accounts?access_token=${longData.access_token}`)
  const pagesData = (await pagesRes.json()) as {
    data?: { id: string; name: string; access_token: string }[]
    error?: { message: string }
  }
  if (!pagesData.data?.length) throw new Error('No Facebook Pages found for this account')

  const page = pagesData.data[0]!

  // Get connected Instagram business account
  const igRes = await fetch(
    `${GRAPH}/${page.id}?fields=instagram_business_account&access_token=${page.access_token}`,
  )
  const igData = (await igRes.json()) as { instagram_business_account?: { id: string }; error?: { message: string } }

  // Persist in settings
  await prisma.$transaction([
    prisma.setting.upsert({ where: { key: 'fb_page_id' },    create: { key: 'fb_page_id',    value: page.id },           update: { value: page.id } }),
    prisma.setting.upsert({ where: { key: 'fb_page_name' },  create: { key: 'fb_page_name',  value: page.name },         update: { value: page.name } }),
    prisma.setting.upsert({ where: { key: 'fb_page_token' }, create: { key: 'fb_page_token', value: page.access_token }, update: { value: page.access_token } }),
    ...(igData.instagram_business_account ? [
      prisma.setting.upsert({ where: { key: 'ig_user_id' }, create: { key: 'ig_user_id', value: igData.instagram_business_account.id }, update: { value: igData.instagram_business_account.id } }),
    ] : []),
  ])

  return {
    pageId:   page.id,
    pageName: page.name,
    igUserId: igData.instagram_business_account?.id ?? null,
  }
}

export async function publishInstagramPost(caption: string, mediaUrls: string[]): Promise<string> {
  const igUserId = await getSetting('ig_user_id')
  const pageToken = await getSetting('fb_page_token')
  if (!igUserId || !pageToken) throw new Error('Instagram not connected — visit Settings > Integrations')

  // Create media container
  const containerRes = await fetch(`${GRAPH}/${igUserId}/media`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      image_url: mediaUrls[0],
      caption,
      access_token: pageToken,
    }),
  })
  const container = (await containerRes.json()) as { id?: string; error?: { message: string } }
  if (!container.id) throw new Error(container.error?.message ?? 'Failed to create media container')

  // Publish
  const publishRes = await fetch(`${GRAPH}/${igUserId}/media_publish`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ creation_id: container.id, access_token: pageToken }),
  })
  const publish = (await publishRes.json()) as { id?: string; error?: { message: string } }
  if (!publish.id) throw new Error(publish.error?.message ?? 'Failed to publish Instagram post')

  return publish.id
}

export async function publishFacebookPost(message: string, mediaUrls: string[]): Promise<string> {
  const pageId    = await getSetting('fb_page_id')
  const pageToken = await getSetting('fb_page_token')
  if (!pageId || !pageToken) throw new Error('Facebook not connected — visit Settings > Integrations')

  const body: Record<string, unknown> = { message, access_token: pageToken }
  if (mediaUrls[0]) body['link'] = mediaUrls[0]

  const res = await fetch(`${GRAPH}/${pageId}/feed`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const data = (await res.json()) as { id?: string; error?: { message: string } }
  if (!data.id) throw new Error(data.error?.message ?? 'Failed to publish Facebook post')
  return data.id
}
