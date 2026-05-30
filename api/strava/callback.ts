/**
 * api/strava/callback.ts
 * GET → Handle Strava OAuth callback.
 *
 * Flow:
 *   1. Exchange ?code for access_token + refresh_token via Strava API
 *   2. Store tokens in the Notion running_records DB (special config row)
 *   3. Return an HTML page with a "Return to App" link
 *
 * iOS PWA note:
 *   OAuth opens in Safari (not the PWA WebView). After callback the user
 *   sees this success page. They tap "アプリに戻る" to return to the PWA.
 *   On the next RunningTab mount the app will read tokens from Notion.
 *
 * Environment variables:
 *   STRAVA_CLIENT_ID
 *   STRAVA_CLIENT_SECRET
 *   STRAVA_REDIRECT_URI      (used to derive APP_URL)
 *   NOTION_API_KEY
 *   NOTION_RUNNING_DB_ID
 */

const NOTION_BASE    = 'https://api.notion.com/v1'
const NOTION_VERSION = '2022-06-28'
const CONFIG_ROW_ID  = '__strava_config__'

type AnyObj = Record<string, unknown>
interface NotionPage { id: string; properties: Record<string, AnyObj> }

function mkHeaders(apiKey: string) {
  return {
    Authorization:    `Bearer ${apiKey}`,
    'Notion-Version': NOTION_VERSION,
    'Content-Type':   'application/json',
  }
}

async function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)) }

async function nFetch(path: string, method: string, apiKey: string, body?: AnyObj): Promise<AnyObj> {
  for (let i = 0; i < 3; i++) {
    const res = await fetch(`${NOTION_BASE}${path}`, {
      method, headers: mkHeaders(apiKey),
      body: body != null ? JSON.stringify(body) : undefined,
    })
    if (res.status === 429) { await sleep(2000); continue }
    if (!res.ok) {
      const txt = await res.text().catch(() => String(res.status))
      throw new Error(`Notion ${method} ${path} → ${res.status}: ${txt}`)
    }
    return res.json() as Promise<AnyObj>
  }
  throw new Error('Notion: max retries')
}

async function queryAll(dbId: string, apiKey: string, filter?: AnyObj): Promise<NotionPage[]> {
  const results: NotionPage[] = []
  let cursor: string | undefined
  while (true) {
    const b: AnyObj = { page_size: 100 }
    if (cursor) b.start_cursor = cursor
    if (filter) b.filter = filter
    const data = await nFetch(`/databases/${dbId}/query`, 'POST', apiKey, b)
    results.push(...((data.results ?? []) as NotionPage[]))
    if (!data.has_more) break
    cursor = data.next_cursor as string
  }
  return results
}

const textProp   = (v: string) => ({ rich_text: [{ text: { content: v.slice(0, 2000) } }] })
const titleProp  = (v: string) => ({ title:     [{ text: { content: v.slice(0, 2000) } }] })
const dateProp   = (v: string) => ({ date: { start: v } })
const selectProp = (v: string) => ({ select: { name: v } })

function getText(page: NotionPage, prop: string): string {
  const p = page.properties?.[prop]
  if (!p) return ''
  const arr = (p.rich_text ?? p.title ?? []) as AnyObj[]
  return arr.map(t => (t as AnyObj).plain_text ?? '').join('')
}

async function storeTokensInNotion(
  apiKey: string, dbId: string,
  tokens: { accessToken: string; refreshToken: string; expiresAt: number; lastSyncEpoch?: number },
): Promise<void> {
  const today = new Date().toISOString().slice(0, 10)
  const props: AnyObj = {
    Name:      titleProp('__STRAVA_CONFIG__'),
    strava_id: textProp(CONFIG_ROW_ID),
    source:    selectProp('strava'),
    memo:      textProp(JSON.stringify(tokens)),
    date:      dateProp(today),
  }

  const existing = await queryAll(dbId, apiKey, {
    property: 'strava_id', rich_text: { equals: CONFIG_ROW_ID },
  })

  if (existing.length > 0 && existing[0].id) {
    await nFetch(`/pages/${existing[0].id}`, 'PATCH', apiKey, { properties: props })
  } else {
    await nFetch('/pages', 'POST', apiKey, {
      parent: { database_id: dbId }, properties: props,
    })
  }
}

const APP_URL = 'https://workout-tracker-ivory-three.vercel.app'

function errorHtml(message: string): string {
  return `<!DOCTYPE html><html lang="ja"><head><meta charset="UTF-8"><title>エラー</title>
<style>body{margin:0;font-family:sans-serif;background:#0f0f14;color:#fff;display:flex;align-items:center;justify-content:center;min-height:100svh;padding:24px;box-sizing:border-box;}
.card{background:#1a1a24;border:1px solid #3a1a1a;border-radius:24px;padding:40px 32px;max-width:360px;text-align:center;}
h1{color:#e55;margin:0 0 12px;}p{color:#888;margin:0;}</style></head>
<body><div class="card"><h1>⚠️ 連携エラー</h1><p>${message}</p></div></body></html>`
}

export default async function handler(req: any, res: any) {
  const { code, error, state } = req.query as Record<string, string>

  if (error) {
    console.warn('[strava/callback] OAuth error:', error)
    res.setHeader('Content-Type', 'text/html')
    res.status(400).send(errorHtml(`Strava認証がキャンセルされました: ${error}`))
    return
  }

  if (!code) {
    res.setHeader('Content-Type', 'text/html')
    res.status(400).send(errorHtml('認証コードが見つかりません。もう一度お試しください。'))
    return
  }

  const clientId     = process.env.STRAVA_CLIENT_ID
  const clientSecret = process.env.STRAVA_CLIENT_SECRET
  const apiKey       = process.env.NOTION_API_KEY
  const dbId         = process.env.NOTION_RUNNING_DB_ID

  if (!clientId || !clientSecret) {
    res.setHeader('Content-Type', 'text/html')
    res.status(500).send(errorHtml('サーバー設定エラー（STRAVA_CLIENT_ID / SECRET 未設定）'))
    return
  }

  try {
    // Exchange code for tokens
    const tokenRes = await fetch('https://www.strava.com/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id:     clientId,
        client_secret: clientSecret,
        code,
        grant_type:    'authorization_code',
      }),
    })
    if (!tokenRes.ok) {
      const txt = await tokenRes.text()
      throw new Error(`Token exchange failed: ${tokenRes.status} ${txt}`)
    }

    const tokenData = await tokenRes.json() as Record<string, unknown>
    const accessToken  = tokenData.access_token  as string
    const refreshToken = tokenData.refresh_token as string
    const expiresAt    = tokenData.expires_at    as number
    const athlete      = (tokenData.athlete as Record<string, unknown>) ?? {}
    const athleteName  = String(athlete.firstname ?? '') + (athlete.lastname ? ` ${athlete.lastname}` : '')

    const tokens = { accessToken, refreshToken, expiresAt }

    // Store tokens in Notion (source of truth — no client-side token passing)
    if (apiKey && dbId) {
      try {
        await storeTokensInNotion(apiKey, dbId, tokens)
        console.log('[strava/callback] tokens stored in Notion')
      } catch (e) {
        console.warn('[strava/callback] failed to store tokens in Notion:', e)
      }
    } else {
      console.warn('[strava/callback] NOTION_RUNNING_DB_ID not set — tokens NOT persisted')
    }

    // Redirect straight back to the PWA.
    // The app checks connection status via GET /api/strava/sync?status=1 on mount,
    // which reads the Notion config row — no localStorage or token passing needed.
    res.redirect(302, APP_URL + '/')

  } catch (err: any) {
    console.error('[strava/callback]', err)
    res.setHeader('Content-Type', 'text/html')
    res.status(500).send(errorHtml(`認証処理中にエラーが発生しました。<br>${err?.message ?? ''}`))
  }
}
