/**
 * api/notion/exercises.ts
 * Vercel Serverless Function — single exercise-set writer
 *
 * POST  → create one record in workout_exercises DB
 *
 * Body (JSON):
 *   {
 *     sessionId:   string          // session.id (original_id key)
 *     category:    string          // exercise category
 *     name:        string          // exercise name
 *     instanceId?: string          // exercise instance UUID
 *     setNumber:   number          // 1-based index within the exercise
 *     set: {
 *       id?:              string
 *       weight?:          number
 *       reps?:            number
 *       durationMinutes?: number
 *       distanceKm?:      number
 *       incline?:         number
 *       calories?:        number
 *       grip?:            string
 *       timestamp?:       string
 *       memo?:            string
 *     }
 *     date: string                 // session.date (YYYY-MM-DD)
 *   }
 *
 * Environment variables:
 *   NOTION_API_KEY
 *   NOTION_EXERCISES_DB_ID
 *
 * Property schema must match api/notion/sessions.ts so the GET handler
 * can reconstruct exercise entries from these pages.
 */

// ─── Notion helpers (mirrored from sessions.ts for compatibility) ─────────────

const NOTION_BASE    = 'https://api.notion.com/v1'
const NOTION_VERSION = '2022-06-28'
const SEP_EXERCISE   = '__EXTRA__'

const titleProp = (v: string) => ({ title:     [{ text: { content: v.slice(0, 2000) } }] })
const textProp  = (v: string) => ({ rich_text: [{ text: { content: v.slice(0, 2000) } }] })
const numProp   = (v: number | undefined | null) => ({ number: v ?? null })
const dateProp  = (v: string) => ({ date: v ? { start: v } : null })

function encodeMemo(userText: string | undefined, extra: Record<string, unknown>): string {
  const json = JSON.stringify(extra)
  return userText ? `${userText}${SEP_EXERCISE}${json}` : json
}

// ─── Request body type ────────────────────────────────────────────────────────

interface ExSet {
  id?:              string
  weight?:          number
  reps?:            number
  durationMinutes?: number
  distanceKm?:      number
  incline?:         number
  calories?:        number
  grip?:            string
  timestamp?:       string
  memo?:            string
}

interface ReqBody {
  sessionId:   string
  category:    string
  name:        string
  instanceId?: string
  setNumber:   number
  set:         ExSet
  date:        string
}

// ─── Property builder ─────────────────────────────────────────────────────────

function buildProps(body: ReqBody): Record<string, unknown> {
  const { sessionId, category, name, instanceId, setNumber, set, date } = body
  const {
    memo: userMemo, weight, reps,
    durationMinutes, distanceKm, incline, calories, grip,
    id: setId, timestamp,
  } = set

  // Pack fields that have no dedicated DB column into memo JSON
  const extra: Record<string, unknown> = {}
  if (setId           != null) extra.setId           = setId
  if (instanceId      != null) extra.instanceId      = instanceId
  if (timestamp       != null) extra.timestamp       = timestamp
  if (durationMinutes != null) extra.durationMinutes = durationMinutes
  if (distanceKm      != null) extra.distanceKm      = distanceKm
  if (incline         != null) extra.incline         = incline
  if (calories        != null) extra.calories        = calories
  if (grip)                    extra.grip            = grip

  return {
    Name:       titleProp(name),
    session_id: textProp(sessionId),
    category:   textProp(category),
    setNumber:  numProp(setNumber),
    weight:     numProp(typeof weight === 'number' ? weight : undefined),
    reps:       numProp(typeof reps   === 'number' ? reps   : undefined),
    memo:       textProp(encodeMemo(userMemo, extra)),
    date:       dateProp(date),
  }
}

// ─── Main handler ─────────────────────────────────────────────────────────────

export default async function handler(req: any, res: any) {
  res.setHeader('Cache-Control', 'no-store')

  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' }); return
  }

  const apiKey = process.env.NOTION_API_KEY
  const dbId   = process.env.NOTION_EXERCISES_DB_ID

  if (!apiKey || !dbId) {
    res.status(500).json({ error: 'Missing NOTION_API_KEY or NOTION_EXERCISES_DB_ID' }); return
  }

  // Parse body (Vercel may provide pre-parsed req.body or raw string)
  let body: ReqBody
  try {
    body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body ?? {}) as ReqBody
  } catch {
    res.status(400).json({ error: 'Invalid JSON body' }); return
  }

  if (!body.sessionId || !body.name || body.setNumber == null || !body.set) {
    res.status(400).json({ error: 'Missing required fields: sessionId, name, setNumber, set' }); return
  }

  // POST to Notion with up to 3 retries on 429
  for (let attempt = 0; attempt < 3; attempt++) {
    let notionRes: Response
    try {
      notionRes = await fetch(`${NOTION_BASE}/pages`, {
        method: 'POST',
        headers: {
          Authorization:    `Bearer ${apiKey}`,
          'Notion-Version': NOTION_VERSION,
          'Content-Type':   'application/json',
        },
        body: JSON.stringify({
          parent:     { database_id: dbId },
          properties: buildProps(body),
        }),
      })
    } catch (err) {
      res.status(500).json({ error: `Network error: ${String(err)}` }); return
    }

    if (notionRes.status === 429) {
      const wait = parseInt(notionRes.headers.get('Retry-After') ?? '1', 10) * 1000
      await new Promise(r => setTimeout(r, Math.max(wait, 1000)))
      continue
    }

    if (!notionRes.ok) {
      const text = await notionRes.text()
      res.status(502).json({ error: `Notion error ${notionRes.status}: ${text}` }); return
    }

    const data = await notionRes.json() as Record<string, unknown>
    res.status(200).json({ ok: true, id: data.id })
    return
  }

  res.status(502).json({ error: 'Notion API: max retries exceeded (429)' })
}
