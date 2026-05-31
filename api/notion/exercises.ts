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

const titleProp  = (v: string) => ({ title:     [{ text: { content: v.slice(0, 2000) } }] })
const textProp   = (v: string) => ({ rich_text: [{ text: { content: v.slice(0, 2000) } }] })
const numProp    = (v: number | undefined | null) => ({ number: v ?? null })
const dateProp   = (v: string) => ({ date: v ? { start: v } : null })
const selectProp = (v: string) => ({ select: v ? { name: v } : null })

/** __EXTRA__{...} サフィックスを除去してユーザーメモだけ返す */
function cleanMemo(m: string | undefined): string {
  if (!m) return ''
  const i = m.indexOf('__EXTRA__')
  return i !== -1 ? m.substring(0, i).trim() : m
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
  sessionId:       string
  category:        string
  name:            string
  instanceId?:     string
  setNumber:       number
  set:             ExSet
  date:            string
  sessionNotionId?: string   // Notion page ID of the parent session (for session_relation)
}

// ─── Property builder ─────────────────────────────────────────────────────────

function buildProps(body: ReqBody): Record<string, unknown> {
  const { sessionId, category, name, setNumber, set, date, sessionNotionId } = body
  const { memo: userMemo, weight, reps } = set

  const props: Record<string, unknown> = {
    Name:       titleProp(name),
    session_id: textProp(sessionId),
    category:   selectProp(category),
    setNumber:  numProp(setNumber),
    weight:     numProp(typeof weight === 'number' ? weight : undefined),
    reps:       numProp(typeof reps   === 'number' ? reps   : undefined),
    // ユーザーメモのみ。__EXTRA__{...} サフィックスは除去する
    memo:       textProp(cleanMemo(userMemo)),
    date:       dateProp(date),
  }

  // session_relation が指定されていればリレーションを設定する（なければ省略）
  if (sessionNotionId) {
    props.session_relation = { relation: [{ id: sessionNotionId }] }
  }

  return props
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

  const props = buildProps(body)
  // Log property keys to Vercel Function logs for debugging
  console.log('[exercises] buildProps keys:', Object.keys(props).join(', '))

  const notionBody = { parent: { database_id: dbId }, properties: props }

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
        body: JSON.stringify(notionBody),
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
      // Extract Notion's human-readable message (same format as sessions.ts)
      let notionMsg: string
      try {
        const j = await notionRes.json() as Record<string, unknown>
        notionMsg = `[${j['code'] ?? 'error'}] ${j['message'] ?? JSON.stringify(j)}`
      } catch {
        notionMsg = await notionRes.text().catch(() => `HTTP ${notionRes.status}`)
      }
      console.error(
        `[exercises] Notion ${notionRes.status}:`, notionMsg,
        '\n  → props:', JSON.stringify(props).slice(0, 600),
      )
      res.status(502).json({ error: `Notion ${notionRes.status}: ${notionMsg}` }); return
    }

    const data = await notionRes.json() as Record<string, unknown>
    res.status(200).json({ ok: true, id: data.id })
    return
  }

  res.status(502).json({ error: 'Notion API: max retries exceeded (429)' })
}
