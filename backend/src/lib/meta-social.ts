// Meta Graph API client for Instagram Business + Facebook Pages publishing.
// Requires env vars: FACEBOOK_APP_ID, FACEBOOK_APP_SECRET
// The page connection is PER BRAND and stored (token sealed) in
// social_connections — modules/socialConnections (owner C18, 2026-10-26). This
// file only talks to Meta: it never stores anything, and every publish takes the
// brand's APPROVED connection from the caller.

import { AppError } from './errors.js'
import { practiceId, sandboxBlocks } from './sandbox.js'

const GRAPH = 'https://graph.facebook.com/v19.0'

/** A brand's approved page connection (modules/socialConnections approvedConnectionFor). */
export interface SocialPage { pageId: string; igUserId: string | null; token: string }

/** What a finished OAuth flow found — the caller stores it (sealed) as a PENDING connection. */
export interface FoundPage { pageId: string; pageName: string; igUserId: string | null; pageToken: string }

// `state` is a one-time CSRF token minted by /integrations/social/connect and
// verified in the callback. Without it the callback accepted ANY code, so a
// link sent to a logged-in operator silently swapped the connected Facebook /
// Instagram page for the attacker's — every scheduled post would then publish
// to their page.
export async function getOAuthUrl(redirectUri: string, state: string): Promise<string> {
  if (sandboxBlocks('social', { summary: 'connect' })) throw new AppError('SANDBOX', 'Practice copy: social pages cannot be connected here', 403)
  const appId = process.env['FACEBOOK_APP_ID']
  if (!appId) throw new Error('FACEBOOK_APP_ID not configured')
  const scope = [
    'pages_manage_posts',
    'pages_read_engagement',
    'instagram_basic',
    'instagram_content_publish',
  ].join(',')
  const params = new URLSearchParams({ client_id: appId, redirect_uri: redirectUri, scope, response_type: 'code', state })
  return `https://www.facebook.com/dialog/oauth?${params}`
}

/**
 * Trade the OAuth code for the page token. `preferName` (the brand's name)
 * picks the page whose name contains it when the account manages several;
 * otherwise the first page. Stores nothing.
 */
export async function exchangeCodeForTokens(code: string, redirectUri: string, preferName?: string | null): Promise<FoundPage> {
  if (sandboxBlocks('social', { summary: 'oauth callback' })) throw new AppError('SANDBOX', 'Practice copy: social pages cannot be connected here', 403)
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

  const want = (preferName ?? '').trim().toLowerCase()
  const page = (want ? pagesData.data.find((p) => p.name.toLowerCase().includes(want)) : undefined) ?? pagesData.data[0]!

  // Get connected Instagram business account
  const igRes = await fetch(
    `${GRAPH}/${page.id}?fields=instagram_business_account&access_token=${page.access_token}`,
  )
  const igData = (await igRes.json()) as { instagram_business_account?: { id: string }; error?: { message: string } }

  return {
    pageId:    page.id,
    pageName:  page.name,
    igUserId:  igData.instagram_business_account?.id ?? null,
    pageToken: page.access_token,
  }
}

export async function publishInstagramPost(caption: string, mediaUrls: string[], page: SocialPage | null): Promise<string> {
  if (sandboxBlocks('social', { summary: 'instagram post' })) return practiceId() // practice copy: the copied page token is live
  const igUserId = page?.igUserId ?? null
  const pageToken = page?.token ?? null
  if (!igUserId || !pageToken) throw new Error("Instagram is not connected for this brand (or not approved by the CEO yet) — Calendar → Social pages")

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

export async function publishFacebookPost(message: string, mediaUrls: string[], page: SocialPage | null): Promise<string> {
  if (sandboxBlocks('social', { summary: 'facebook post' })) return practiceId() // practice copy: the copied page token is live
  const pageId    = page?.pageId ?? null
  const pageToken = page?.token ?? null
  if (!pageId || !pageToken) throw new Error("Facebook is not connected for this brand (or not approved by the CEO yet) — Calendar → Social pages")

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
