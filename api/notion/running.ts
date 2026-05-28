/**
 * api/notion/running.ts
 * Vercel Serverless Function — CRUD for running_records Notion DB
 *
 * GET    → { records: RunningRecord[] }
 * POST   → create one record  body: { record: RunningRecord }
 * DELETE → archive one record body: { notionPageId: string }
 * PATCH  → store/update Strava tokens in the config row
 *          body: { stravaTokens: StravaTokens }
 *
 * Special "config" row (used for Strava token storage):
 *   strava_id = '__strava_config__'   ← excluded from GET results
 *   memo = JSON.stringify(StravaTokens)
 *
 * Notion DB schema (create manually, then set NOTION_RUNNING_DB_ID):
 *   Name          TITLE
 *   date          DATE
 *   activity_type SELECT  (running | walking | treadmill | hike)
 *   distance      NUMBER  km
 *   duration      NUMBER  seconds
 *   avgPace       NUMBER  sec/km
 *   avgHeartRate  NUMBER
 *   maxHeartRate  NUMBER
 *   calories      NUMBER
 *   source        SELECT  (strava | manual)
 *   strava_id     RICH_TEXT
 *   memo          RICH_TEXT
 *
 * Environment variables:
 *   NOTION_API_KEY
 *   NOTION_RUNNING_DB_ID
 */

const NOTION_BASE    = 'https://api.notion.com/v1'
const NOTION_VERSION = '2022-06-28'
const CONFIG_ROW_ID  = '__strava_config__'

type AnyObj = Record<string, unknown>

interface NotionPage {
  id:         string
  properties: Record<string, AnyObj>
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function mkHeaders(apiKey: string) {
  return {
    Authorization:    `Bearer ${apiKey}`,
    'Notion-Version': NOTION_VERSION,
    'Content-Type':   'application/json',
  }
}

async function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)) }

async function nFetch(
  path: string, method: string, apiKey: string, body?: AnyObj, retries = 3,
): Promise<AnyObj> {
  for (let attempt = 1; attempt <= retries; attempt++) {
    const res = await fetch(`${NOTION_BASE}${path}`, {
      method,
      headers: mkHeaders(apiKey),
      body: body != null ? JSON.stringify(body) : undefined,
    })
    if (res.status === 429) {
      const wait = parseInt(res.headers.get('Retry-After') ?? '1', 10) * 1000
      await sleep(Math.max(wait, 1000)); continue
    }
    if (!res.ok) {
      let msg: string
      try {
        const j = await res.json() as Record<string, unknown>
        msg = `[${j['code'] ?? 'error'}] ${j['message'] ?? JSON.stringify(j)}`
      } catch { msg = await res.text().catch(() => `HTTP ${res.status}`) }
      throw new Error(`Notion ${method} ${path} → ${res.status}: ${msg}`)
    }
    return res.json() as Promise<AnyObj>
  }
  throw new Error(`Notion ${method} ${path}: max retries exceeded`)
}

async function queryAll(dbId: string, apiKey: string, filter?: AnyObj): Promise<NotionPage[]> {
  const results: NotionPage[] = []
  let cursor: string | undefined
  while (true) {
    const body: AnyObj = { page_size: 100 }
    if (cursor) body.start_cursor = cursor
    if (filter) body.filter       = filter
    const data = await nFetch(`/databases/${dbId}/query`, 'POST', apiKey, body)
    results.push(...((data.results ?? []) as NotionPage[]))
    if (!data.has_more) break
    cursor = data.next_cursor as string
  }
  return results
}

// ─── Property readers ─────────────────────────────────────────────────────────

function getText(page: NotionPage, prop: string): string {
  const p = page.properties?.[prop]
  if (!p) return ''
  const arr = (p.rich_text ?? p.title ?? []) as AnyObj[]
  return arr.map(t => (t as AnyObj).plain_text ?? '').join('')
}

function getNum(page: NotionPage, prop: string): number | undefined {
  const v = (page.properties?.[prop] as AnyObj)?.number
  return typeof v === 'number' ? v : undefined
}

function getDateStr(page: NotionPage, prop: string): string {
  const d = (page.properties?.[prop] as AnyObj)?.date as AnyObj | undefined
  return (d?.start as string) ?? ''
}

function getSelect(page: NotionPage, prop: string): string {
  const s = (page.properties?.[prop] as AnyObj)?.select as AnyObj | undefined
  return (s?.name as string) ?? ''
}

// ─── Property builders ────────────────────────────────────────────────────────

const titleProp  = (v: string) => ({ title:     [{ text: { content: v.slice(0, 2000) } }] })
const textProp   = (v: string) => ({ rich_text: [{ text: { content: v.slice(0, 2000) } }] })
const numProp    = (v: number | undefined | null) => ({ number: v ?? null })
const dateProp   = (v: string) => ({ date: v ? { start: v } : null })
const selectProp = (v: string) => ({ select: v ? { name: v } : null })

// ─── Activity type label ──────────────────────────────────────────────────────

function activityLabel(type: string): string {
  return ({ running: 'ランニング', walking: 'ウォーキング', treadmill: 'トレッドミル', hike: 'ハイキング' } as Record<string, string>)[type] ?? type
}

function buildName(date: string, activityType: string, distanceKm?: number): string {
  const dist = distanceKm != null ? ` ${distanceKm.toFixed(1)}km` : ''
  return `${date} ${activityLabel(activityType)}${dist}`
}

// ─── Record builders ──────────────────────────────────────────────────────────

interface RecordInput {
  id?: string
  date: string
  activityType: string
  distanceKm?: number
  durationSec?: number
  avgPaceSec?: number
  avgHeartRate?: number
  maxHeartRate?: number
  calories?: number
  source: string
  stravaId?: string
  memo?: string
}

function buildRecordProps(r: RecordInput): AnyObj {
  return {
    Name:         titleProp(buildName(r.date, r.activityType, r.distanceKm)),
    date:         dateProp(r.date),
    activity_type: selectProp(r.activityType),
    distance:     numProp(r.distanceKm),
    duration:     numProp(r.durationSec),
    avgPace:      numProp(r.avgPaceSec),
    avgHeartRate: numProp(r.avgHeartRate),
    maxHeartRate: numProp(r.maxHeartRate),
    calories:     numProp(r.calories),
    source:       selectProp(r.source),
    strava_id:    textProp(r.stravaId ?? ''),
    memo:         textProp(r.memo ?? ''),
  }
}

function pageToRecord(page: NotionPage): RecordInput & { notionPageId: string } {
  return {
    id:           getText(page, 'strava_id') || page.id,   // fallback to Notion page id
    notionPageId: page.id,
    date:         getDateStr(page, 'date'),
    activityType: getSelect(page, 'activity_type'),
    distanceKm:   getNum(page, 'distance'),
    durationSec:  getNum(page, 'duration'),
    avgPaceSec:   getNum(page, 'avgPace'),
    avgHeartRate: getNum(page, 'avgHeartRate'),
    maxHeartRate: getNum(page, 'maxHeartRate'),
    calories:     getNum(page, 'calories'),
    source:       getSelect(page, 'source') as 'strava' | 'manual',
    stravaId:     getText(page, 'strava_id') || undefined,
    memo:         getText(page, 'memo') || undefined,
  }
}

// ─── Config (Strava token) row ops ────────────────────────────────────────────

async function getConfigPage(dbId: string, apiKey: string): Promise<NotionPage | null> {
  const pages = await queryAll(dbId, apiKey, {
    property: 'strava_id', rich_text: { equals: CONFIG_ROW_ID },
  })
  return pages[0] ?? null
}

async function upsertConfigRow(
  dbId: string, apiKey: string, tokens: Record<string, unknown>,
): Promise<void> {
  const existing = await getConfigPage(dbId, apiKey)
  const props = {
    Name:      titleProp('__STRAVA_CONFIG__'),
    strava_id: textProp(CONFIG_ROW_ID),
    source:    selectProp('strava'),
    memo:      textProp(JSON.stringify(tokens)),
    date:      dateProp(new Date().toISOString().slice(0, 10)),
  }
  if (existing) {
    await nFetch(`/pages/${existing.id}`, 'PATCH', apiKey, { properties: props })
  } else {
    await nFetch('/pages', 'POST', apiKey, {
      parent: { database_id: dbId },
      properties: props,
    })
  }
}

// ─── Main handler ─────────────────────────────────────────────────────────────

export default async function handler(req: any, res: any) {
  res.setHeader('Access-Control-Allow-Origin',  '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, PATCH, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  res.setHeader('Cache-Control',                'no-store')

  if (req.method === 'OPTIONS') { res.status(200).end(); return }

  const apiKey = process.env.NOTION_API_KEY
  const dbId   = process.env.NOTION_RUNNING_DB_ID

  if (!apiKey || !dbId) {
    res.status(200).json({ records: [] }); return   // gracefully empty if not configured
  }

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body ?? {})

    // ── GET ── list all running records (exclude config row)
    if (req.method === 'GET') {
      const pages = await queryAll(dbId, apiKey)
      const records = pages
        .filter(p => getText(p, 'strava_id') !== CONFIG_ROW_ID)
        .map(pageToRecord)
        .sort((a, b) => b.date.localeCompare(a.date))
      res.status(200).json({ records }); return
    }

    // ── POST ── create one record
    if (req.method === 'POST') {
      const record = body.record as RecordInput | undefined
      if (!record?.date || !record.activityType) {
        res.status(400).json({ error: 'Missing record.date / record.activityType' }); return
      }
      const page = await nFetch('/pages', 'POST', apiKey, {
        parent:     { database_id: dbId },
        properties: buildRecordProps(record),
      }) as NotionPage
      res.status(200).json({ ok: true, id: page.id }); return
    }

    // ── DELETE ── archive one record by Notion page ID
    if (req.method === 'DELETE') {
      const { notionPageId } = body as { notionPageId?: string }
      if (!notionPageId) { res.status(400).json({ error: 'Missing notionPageId' }); return }
      await nFetch(`/pages/${notionPageId}`, 'PATCH', apiKey, { archived: true })
      res.status(200).json({ ok: true }); return
    }

    // ── PATCH ── upsert Strava tokens in config row
    if (req.method === 'PATCH') {
      const { stravaTokens } = body as { stravaTokens?: Record<string, unknown> }
      if (!stravaTokens) { res.status(400).json({ error: 'Missing stravaTokens' }); return }
      await upsertConfigRow(dbId, apiKey, stravaTokens)
      res.status(200).json({ ok: true }); return
    }

    res.status(405).json({ error: 'Method not allowed' })
  } catch (err: any) {
    console.error('[notion/running]', err)
    res.status(500).json({ error: err?.message ?? 'Internal error' })
  }
}
