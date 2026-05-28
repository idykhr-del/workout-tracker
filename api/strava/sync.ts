/**
 * api/strava/sync.ts
 * Vercel Serverless Function — Strava activity sync
 *
 * GET  ?status=1  → { connected: bool, lastSync?: string, athleteName?: string }
 * POST            → fetch Strava activities → save new ones to Notion
 *                   Returns { synced: number, records: RunningRecord[] }
 *
 * Token flow:
 *   - Reads tokens from Notion running_records config row
 *   - Refreshes via Strava if expired
 *   - Saves updated tokens back to Notion
 *
 * Activity type mapping (others ignored):
 *   Run         → running
 *   Walk        → walking
 *   VirtualRun  → treadmill
 *   Hike        → hike
 *
 * Environment variables:
 *   NOTION_API_KEY, NOTION_RUNNING_DB_ID
 *   STRAVA_CLIENT_ID, STRAVA_CLIENT_SECRET
 */

const NOTION_BASE    = 'https://api.notion.com/v1'
const NOTION_VERSION = '2022-06-28'
const CONFIG_ROW_ID  = '__strava_config__'
const STRAVA_BASE    = 'https://www.strava.com/api/v3'
const STRAVA_TOKEN_URL = 'https://www.strava.com/oauth/token'

const ACTIVITY_TYPE_MAP: Record<string, string> = {
  Run:        'running',
  Walk:       'walking',
  VirtualRun: 'treadmill',
  Hike:       'hike',
}

type AnyObj = Record<string, unknown>
interface NotionPage { id: string; properties: Record<string, AnyObj> }

// ─── Notion helpers ───────────────────────────────────────────────────────────

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
      let msg: string
      try {
        const j = await res.json() as Record<string, unknown>
        msg = `[${j['code']}] ${j['message'] ?? JSON.stringify(j)}`
      } catch { msg = await res.text().catch(() => String(res.status)) }
      throw new Error(`Notion ${method} ${path} → ${res.status}: ${msg}`)
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

const titleProp  = (v: string) => ({ title:     [{ text: { content: v.slice(0, 2000) } }] })
const textProp   = (v: string) => ({ rich_text: [{ text: { content: v.slice(0, 2000) } }] })
const numProp    = (v: number | undefined | null) => ({ number: v ?? null })
const dateProp   = (v: string) => ({ date: { start: v } })
const selectProp = (v: string) => ({ select: { name: v } })

function getText(page: NotionPage, prop: string): string {
  const p = page.properties?.[prop]
  if (!p) return ''
  const arr = (p.rich_text ?? p.title ?? []) as AnyObj[]
  return arr.map(t => (t as AnyObj).plain_text ?? '').join('')
}

function getDateStr(page: NotionPage, prop: string): string {
  const d = (page.properties?.[prop] as AnyObj)?.date as AnyObj | undefined
  return (d?.start as string) ?? ''
}

function getNum(page: NotionPage, prop: string): number | undefined {
  const v = (page.properties?.[prop] as AnyObj)?.number
  return typeof v === 'number' ? v : undefined
}

function getSelect(page: NotionPage, prop: string): string {
  const s = (page.properties?.[prop] as AnyObj)?.select as AnyObj | undefined
  return (s?.name as string) ?? ''
}

// ─── Strava token ops ─────────────────────────────────────────────────────────

interface StravaTokens {
  accessToken: string
  refreshToken: string
  expiresAt: number
  lastSyncEpoch?: number
}

async function readTokensFromNotion(dbId: string, apiKey: string): Promise<StravaTokens | null> {
  const pages = await queryAll(dbId, apiKey, {
    property: 'strava_id', rich_text: { equals: CONFIG_ROW_ID },
  })
  if (!pages.length) return null
  const memo = getText(pages[0], 'memo')
  if (!memo) return null
  try { return JSON.parse(memo) as StravaTokens } catch { return null }
}

async function writeTokensToNotion(
  dbId: string, apiKey: string, tokens: StravaTokens, existingPageId?: string,
): Promise<void> {
  const props: AnyObj = {
    Name:      titleProp('__STRAVA_CONFIG__'),
    strava_id: textProp(CONFIG_ROW_ID),
    source:    selectProp('strava'),
    memo:      textProp(JSON.stringify(tokens)),
    date:      dateProp(new Date().toISOString().slice(0, 10)),
  }
  if (existingPageId) {
    await nFetch(`/pages/${existingPageId}`, 'PATCH', apiKey, { properties: props })
  } else {
    await nFetch('/pages', 'POST', apiKey, { parent: { database_id: dbId }, properties: props })
  }
}

async function refreshTokens(
  tokens: StravaTokens, clientId: string, clientSecret: string,
): Promise<StravaTokens> {
  const res = await fetch(STRAVA_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: clientId, client_secret: clientSecret,
      refresh_token: tokens.refreshToken, grant_type: 'refresh_token',
    }),
  })
  if (!res.ok) throw new Error(`Strava token refresh failed: ${res.status}`)
  const data = await res.json() as Record<string, unknown>
  return {
    accessToken:   data.access_token  as string,
    refreshToken:  data.refresh_token as string,
    expiresAt:     data.expires_at    as number,
    lastSyncEpoch: tokens.lastSyncEpoch,
  }
}

/** Returns a valid access token, refreshing if needed. Also saves updated tokens. */
async function getValidAccessToken(
  dbId: string, apiKey: string, clientId: string, clientSecret: string,
): Promise<{ accessToken: string; tokens: StravaTokens; configPageId?: string }> {
  const pages = await queryAll(dbId, apiKey, {
    property: 'strava_id', rich_text: { equals: CONFIG_ROW_ID },
  })
  const configPage = pages[0]
  if (!configPage) throw new Error('Strava tokens not found in Notion — please connect Strava first')

  const memo = getText(configPage, 'memo')
  let tokens: StravaTokens
  try { tokens = JSON.parse(memo) } catch { throw new Error('Invalid token data in Notion config row') }

  const nowSec = Math.floor(Date.now() / 1000)
  if (tokens.expiresAt <= nowSec + 60) {
    console.log('[strava/sync] access token expired, refreshing…')
    tokens = await refreshTokens(tokens, clientId, clientSecret)
    await writeTokensToNotion(dbId, apiKey, tokens, configPage.id)
    console.log('[strava/sync] tokens refreshed + saved')
  }

  return { accessToken: tokens.accessToken, tokens, configPageId: configPage.id }
}

// ─── Strava API fetch ─────────────────────────────────────────────────────────

interface StravaActivity {
  id: number
  name: string
  type: string
  sport_type: string
  start_date_local: string   // ISO 8601 e.g. "2026-05-28T06:30:00Z"
  distance: number           // meters
  moving_time: number        // seconds
  average_heartrate?: number
  max_heartrate?: number
  calories?: number
}

async function fetchStravaActivities(
  accessToken: string, afterEpoch?: number,
): Promise<StravaActivity[]> {
  const params = new URLSearchParams({ per_page: '200' })
  if (afterEpoch) params.set('after', String(afterEpoch))

  const res = await fetch(`${STRAVA_BASE}/athlete/activities?${params}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  if (!res.ok) {
    const txt = await res.text()
    throw new Error(`Strava API error: ${res.status} ${txt}`)
  }
  return res.json() as Promise<StravaActivity[]>
}

// ─── Record conversion ────────────────────────────────────────────────────────

function activityLabel(type: string): string {
  return ({ running: 'ランニング', walking: 'ウォーキング', treadmill: 'トレッドミル', hike: 'ハイキング' } as Record<string, string>)[type] ?? type
}

function stravaToRecord(a: StravaActivity): AnyObj & { stravaId: string } {
  const activityType = ACTIVITY_TYPE_MAP[a.type] ?? ACTIVITY_TYPE_MAP[a.sport_type]
  if (!activityType) throw new Error(`Unsupported type: ${a.type}`)

  const distKm = a.distance > 0 ? +(a.distance / 1000).toFixed(3) : undefined
  const avgPaceSec = (distKm && distKm > 0)
    ? Math.round(a.moving_time / distKm)
    : undefined

  const date = a.start_date_local.slice(0, 10)   // YYYY-MM-DD

  return {
    date,
    activityType,
    distanceKm:   distKm,
    durationSec:  a.moving_time,
    avgPaceSec,
    avgHeartRate: a.average_heartrate ? Math.round(a.average_heartrate) : undefined,
    maxHeartRate: a.max_heartrate     ? Math.round(a.max_heartrate)     : undefined,
    calories:     a.calories          ? Math.round(a.calories)          : undefined,
    source:       'strava',
    stravaId:     String(a.id),
    memo:         a.name || undefined,
  }
}

function buildNotionProps(r: ReturnType<typeof stravaToRecord>): AnyObj {
  const distKm    = r.distanceKm as number | undefined
  const name      = `${r.date} ${activityLabel(r.activityType as string)}${distKm ? ` ${distKm.toFixed(1)}km` : ''}`
  return {
    Name:         titleProp(name),
    date:         dateProp(r.date as string),
    activity_type: selectProp(r.activityType as string),
    distance:     numProp(distKm),
    duration:     numProp(r.durationSec as number | undefined),
    avgPace:      numProp(r.avgPaceSec  as number | undefined),
    avgHeartRate: numProp(r.avgHeartRate as number | undefined),
    maxHeartRate: numProp(r.maxHeartRate as number | undefined),
    calories:     numProp(r.calories as number | undefined),
    source:       selectProp('strava'),
    strava_id:    textProp(r.stravaId),
    memo:         textProp((r.memo as string | undefined) ?? ''),
  }
}

// ─── Main handler ─────────────────────────────────────────────────────────────

export default async function handler(req: any, res: any) {
  res.setHeader('Cache-Control', 'no-store')

  const apiKey       = process.env.NOTION_API_KEY
  const dbId         = process.env.NOTION_RUNNING_DB_ID
  const clientId     = process.env.STRAVA_CLIENT_ID
  const clientSecret = process.env.STRAVA_CLIENT_SECRET

  if (!apiKey || !dbId) {
    res.status(200).json({ connected: false, error: 'NOTION_RUNNING_DB_ID not configured' }); return
  }

  try {
    // ── GET ?status=1 ── connection status check ──────────────────────────────
    if (req.method === 'GET') {
      const tokens = await readTokensFromNotion(dbId, apiKey)
      if (!tokens) {
        res.status(200).json({ connected: false }); return
      }
      const lastSyncISO = tokens.lastSyncEpoch
        ? new Date(tokens.lastSyncEpoch * 1000).toISOString()
        : undefined
      res.status(200).json({ connected: true, lastSync: lastSyncISO }); return
    }

    // ── POST ── perform sync ──────────────────────────────────────────────────
    if (req.method === 'POST') {
      if (!clientId || !clientSecret) {
        res.status(500).json({ error: 'STRAVA_CLIENT_ID / SECRET not configured' }); return
      }

      const { accessToken, tokens, configPageId } = await getValidAccessToken(
        dbId, apiKey, clientId, clientSecret,
      )

      // Fetch activities (since last sync, or last 200 if first time)
      const activities = await fetchStravaActivities(accessToken, tokens.lastSyncEpoch)
      console.log(`[strava/sync] fetched ${activities.length} activities from Strava`)

      // Filter to supported types
      const relevant = activities.filter(
        a => ACTIVITY_TYPE_MAP[a.type] || ACTIVITY_TYPE_MAP[a.sport_type]
      )
      console.log(`[strava/sync] ${relevant.length} relevant (Run/Walk/VirtualRun/Hike)`)

      // Get all existing strava_ids to avoid duplicates
      const existingPages = await queryAll(dbId, apiKey, {
        and: [
          { property: 'source',    select:    { equals: 'strava' } },
          { property: 'strava_id', rich_text: { is_not_empty: true } },
        ],
      })
      const existingIds = new Set(
        existingPages
          .map(p => getText(p, 'strava_id'))
          .filter(id => id && id !== CONFIG_ROW_ID)
      )

      // Create new records
      const newRecords: AnyObj[] = []
      for (const activity of relevant) {
        const sid = String(activity.id)
        if (existingIds.has(sid)) continue

        const record = stravaToRecord(activity)
        const props  = buildNotionProps(record)

        try {
          const page = await nFetch('/pages', 'POST', apiKey, {
            parent: { database_id: dbId }, properties: props,
          }) as NotionPage
          newRecords.push({ ...record, notionPageId: page.id })
          await sleep(150)  // pace requests
        } catch (err) {
          console.warn(`[strava/sync] failed to create record for activity ${sid}:`, err)
        }
      }

      // Update lastSyncEpoch in config row
      const newTokens: StravaTokens = {
        ...tokens,
        lastSyncEpoch: Math.floor(Date.now() / 1000),
      }
      await writeTokensToNotion(dbId, apiKey, newTokens, configPageId)

      console.log(`[strava/sync] done — ${newRecords.length} new records created`)
      res.status(200).json({ ok: true, synced: newRecords.length, records: newRecords }); return
    }

    res.status(405).json({ error: 'Method not allowed' })
  } catch (err: any) {
    console.error('[strava/sync]', err)
    res.status(500).json({ error: err?.message ?? 'Internal error' })
  }
}
