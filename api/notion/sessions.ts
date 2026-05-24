/**
 * api/notion/sessions.ts
 * Vercel Serverless Function — CORS proxy for Notion API
 *
 * GET    → load all WorkoutData from Notion (sessions + exercises)
 * PUT    → upsert one session (+ recreate its exercise set records)
 * DELETE → archive a session + its exercise records
 *
 * Environment variables (server-side, no VITE_ prefix):
 *   NOTION_API_KEY
 *   NOTION_SESSIONS_DB_ID
 *   NOTION_EXERCISES_DB_ID
 */

// ─── Types ────────────────────────────────────────────────────────────────────

type AnyObj = Record<string, unknown>

interface NotionPage {
  id: string
  properties: Record<string, AnyObj>
}

// ─── Notion API helpers ───────────────────────────────────────────────────────

const NOTION_BASE    = 'https://api.notion.com/v1'
const NOTION_VERSION = '2022-06-28'

function mkHeaders(apiKey: string) {
  return {
    Authorization:    `Bearer ${apiKey}`,
    'Notion-Version': NOTION_VERSION,
    'Content-Type':   'application/json',
  }
}

async function nFetch(
  path: string,
  method: string,
  apiKey: string,
  body?: AnyObj,
  retries = 3,
): Promise<AnyObj> {
  for (let attempt = 1; attempt <= retries; attempt++) {
    const res = await fetch(`${NOTION_BASE}${path}`, {
      method,
      headers: mkHeaders(apiKey),
      body:    body != null ? JSON.stringify(body) : undefined,
    })
    if (res.status === 429) {
      const wait = parseInt(res.headers.get('Retry-After') ?? '1', 10) * 1000
      await sleep(Math.max(wait, 1000))
      continue
    }
    if (!res.ok) {
      const text = await res.text()
      throw new Error(`Notion ${method} ${path} → ${res.status}: ${text}`)
    }
    return res.json() as Promise<AnyObj>
  }
  throw new Error(`Notion ${method} ${path}: max retries exceeded`)
}

async function sleep(ms: number) {
  return new Promise(r => setTimeout(r, ms))
}

/** Fetch ALL pages from a Notion DB, handling pagination automatically. */
async function queryAll(
  dbId: string,
  apiKey: string,
  filter?: AnyObj,
  sorts?: AnyObj[],
): Promise<NotionPage[]> {
  const results: NotionPage[] = []
  let cursor: string | undefined

  while (true) {
    const body: AnyObj = { page_size: 100 }
    if (cursor) body.start_cursor = cursor
    if (filter)  body.filter       = filter
    if (sorts)   body.sorts        = sorts

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

// ─── Property builders ────────────────────────────────────────────────────────

const titleProp = (v: string) => ({ title: [{ text: { content: v.slice(0, 2000) } }] })
const textProp  = (v: string) => ({ rich_text: [{ text: { content: v.slice(0, 2000) } }] })
const numProp   = (v: number | undefined | null) => ({ number: v ?? null })
const dateProp  = (v: string) => ({ date: v ? { start: v } : null })

// ─── Memo encoding helpers ────────────────────────────────────────────────────
//
// Session memo → "<userMemo>__SMETA__<json>"
// Exercise memo → "<userMemo>__EXTRA__<json>"
// If userMemo is empty, just store the JSON.

const SEP_SESSION  = '__SMETA__'
const SEP_EXERCISE = '__EXTRA__'

function encodeMemo(userText: string | undefined, extra: AnyObj, sep: string): string {
  const json = JSON.stringify(extra)
  return userText ? `${userText}${sep}${json}` : json
}

function decodeMemo(raw: string, sep: string): { userMemo?: string; extra: AnyObj } {
  const idx = raw.indexOf(sep)
  if (idx >= 0) {
    try {
      return { userMemo: raw.slice(0, idx) || undefined, extra: JSON.parse(raw.slice(idx + sep.length)) }
    } catch { /* fall through */ }
  }
  // Try bare JSON (extra-only)
  try {
    if (raw.startsWith('{')) return { extra: JSON.parse(raw) }
  } catch { /* fall through */ }
  return { userMemo: raw || undefined, extra: {} }
}

// ─── Session page ↔ WorkoutSession ───────────────────────────────────────────

function buildSessionProps(session: AnyObj): AnyObj {
  const { memo: userMemo, totalCalories, notes, id, date, startTime, endTime, rating } = session as Record<string, unknown>

  const extra: AnyObj = {}
  if (totalCalories != null) extra.totalCalories = totalCalories
  if (Array.isArray(notes) && notes.length > 0) extra.notes = notes

  const memoStr = encodeMemo(userMemo as string | undefined, extra, SEP_SESSION)

  return {
    Name:        titleProp(`${date ?? ''} ${startTime ?? ''}`),
    date:        dateProp(date as string ?? ''),
    startTime:   textProp(startTime as string ?? ''),
    endTime:     textProp(endTime   as string ?? ''),
    rating:      numProp(rating  as number | undefined),
    memo:        textProp(memoStr),
    original_id: textProp(id as string ?? ''),
  }
}

function pageToSession(page: NotionPage): AnyObj {
  const memoRaw = getText(page, 'memo')
  const { userMemo, extra } = decodeMemo(memoRaw, SEP_SESSION)

  return {
    id:             getText(page, 'original_id') || page.id,
    notionPageId:   page.id,
    date:           getDateStr(page, 'date') || getText(page, 'date'),
    startTime:      getText(page, 'startTime'),
    endTime:        getText(page, 'endTime') || undefined,
    rating:         getNum(page, 'rating'),
    memo:           userMemo,
    totalCalories:  (extra.totalCalories as number) ?? undefined,
    notes:          (extra.notes as AnyObj[]) ?? [],
    exercises:      [],   // filled in later
  }
}

// ─── Exercise set page ↔ ExerciseEntry+WorkoutSet ─────────────────────────────

function buildExerciseProps(
  sessionOriginalId: string,
  exCategory: string,
  exName: string,
  setNumber: number,
  set: AnyObj,
  sessionDate: string,
): AnyObj {
  const { memo: userMemo, weight, reps, durationMinutes, distanceKm, incline,
          calories, grip, id: setId, timestamp, instanceId } = set as Record<string, unknown>

  const extra: AnyObj = {}
  if (setId != null)           extra.setId           = setId
  if (instanceId != null)      extra.instanceId      = instanceId
  if (timestamp != null)       extra.timestamp       = timestamp
  if (durationMinutes != null) extra.durationMinutes = durationMinutes
  if (distanceKm != null)      extra.distanceKm      = distanceKm
  if (incline != null)         extra.incline         = incline
  if (calories != null)        extra.calories        = calories
  if (grip)                    extra.grip            = grip

  return {
    Name:       titleProp(exName),
    session_id: textProp(sessionOriginalId),
    category:   textProp(exCategory),
    setNumber:  numProp(setNumber),
    weight:     numProp(typeof weight === 'number' ? weight : undefined),
    reps:       numProp(typeof reps   === 'number' ? reps   : undefined),
    memo:       textProp(encodeMemo(userMemo as string | undefined, extra, SEP_EXERCISE)),
    date:       dateProp(sessionDate),
  }
}

interface ExRecord {
  sessionId:  string
  category:   string
  name:       string
  setNumber:  number
  weight?:    number
  reps?:      number
  userMemo?:  string
  extra:      AnyObj
}

function pageToExRecord(page: NotionPage): ExRecord {
  const memoRaw          = getText(page, 'memo')
  const { userMemo, extra } = decodeMemo(memoRaw, SEP_EXERCISE)

  return {
    sessionId: getText(page, 'session_id'),
    category:  getText(page, 'category'),
    name:      getText(page, 'Name'),
    setNumber: getNum(page, 'setNumber') ?? 0,
    weight:    getNum(page, 'weight'),
    reps:      getNum(page, 'reps'),
    userMemo,
    extra,
  }
}

/** Reconstruct ExerciseEntry[] from flat exercise records for one session. */
function buildExercises(records: ExRecord[]): AnyObj[] {
  const sorted = [...records].sort((a, b) => a.setNumber - b.setNumber)

  // Group by (category, name, instanceId)
  const groups = new Map<string, ExRecord[]>()
  for (const rec of sorted) {
    const instId = (rec.extra.instanceId as string) ?? '_'
    const key    = `${rec.category}\x00${rec.name}\x00${instId}`
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key)!.push(rec)
  }

  const entries: AnyObj[] = []
  for (const [key, recs] of groups) {
    const [category, name, rawInstId] = key.split('\x00')
    const instanceId = rawInstId !== '_' ? rawInstId : undefined

    entries.push({
      category,
      name,
      instanceId,
      sets: recs.map(r => ({
        id:              (r.extra.setId    as string) ?? genId(),
        timestamp:       (r.extra.timestamp as string) ?? new Date().toISOString(),
        weight:          r.weight,
        reps:            r.reps,
        durationMinutes: r.extra.durationMinutes as number | undefined,
        distanceKm:      r.extra.distanceKm      as number | undefined,
        incline:         r.extra.incline          as number | undefined,
        calories:        r.extra.calories         as number | undefined,
        grip:            r.extra.grip             as string | undefined,
        memo:            r.userMemo,
      })),
    })
  }

  return entries
}

function genId(): string {
  return Array.from({ length: 36 }, (_, i) =>
    [8, 13, 18, 23].includes(i)
      ? '-'
      : Math.floor(Math.random() * 16).toString(16)
  ).join('')
}

// ─── Batch helpers ────────────────────────────────────────────────────────────

/** Find an existing session page in Notion by original_id. */
async function findSessionPageId(
  dbId: string, apiKey: string, originalId: string,
): Promise<string | null> {
  const pages = await queryAll(dbId, apiKey, {
    property: 'original_id', rich_text: { equals: originalId },
  })
  return (pages[0]?.id as string) ?? null
}

/** Archive all exercise pages that belong to a session. */
async function archiveExercisesForSession(
  dbId: string, apiKey: string, sessionOriginalId: string,
): Promise<void> {
  const pages = await queryAll(dbId, apiKey, {
    property: 'session_id', rich_text: { equals: sessionOriginalId },
  })
  await Promise.all(
    pages.map(p => nFetch(`/pages/${p.id}`, 'PATCH', apiKey, { archived: true })),
  )
}

/** Create one Notion page per set in a session's exercises. */
async function createExercisePages(
  dbId: string, apiKey: string,
  session: AnyObj,
  rateDelayMs = 0,
): Promise<void> {
  const exercises = (session.exercises ?? []) as AnyObj[]
  for (const ex of exercises) {
    const sets = ((ex as Record<string, unknown>).sets ?? []) as AnyObj[]
    for (let i = 0; i < sets.length; i++) {
      const set = { ...(sets[i] as Record<string, unknown>), instanceId: ex.instanceId }
      const props = buildExerciseProps(
        session.id as string,
        ex.category as string,
        ex.name     as string,
        i + 1,
        set,
        session.date as string,
      )
      await nFetch('/pages', 'POST', apiKey, {
        parent:     { database_id: dbId },
        properties: props,
      })
      if (rateDelayMs > 0) await sleep(rateDelayMs)
    }
  }
}

// ─── Main handler ─────────────────────────────────────────────────────────────

export default async function handler(req: any, res: any) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin',  '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, PUT, DELETE, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  res.setHeader('Cache-Control',                'no-store')

  if (req.method === 'OPTIONS') { res.status(200).end(); return }

  const apiKey      = process.env.NOTION_API_KEY
  const sessionsDb  = process.env.NOTION_SESSIONS_DB_ID
  const exercisesDb = process.env.NOTION_EXERCISES_DB_ID

  if (!apiKey || !sessionsDb || !exercisesDb) {
    res.status(500).json({ error: 'Notion env vars not configured' }); return
  }

  try {
    // ── GET ── load all WorkoutData
    if (req.method === 'GET') {
      const [sessionPages, exercisePages] = await Promise.all([
        queryAll(sessionsDb,  apiKey, undefined, [{ property: 'date', direction: 'descending' }]),
        queryAll(exercisesDb, apiKey),
      ])

      // Index exercise records by sessionId
      const bySession = new Map<string, ExRecord[]>()
      for (const p of exercisePages) {
        const rec = pageToExRecord(p)
        if (!rec.sessionId) continue
        if (!bySession.has(rec.sessionId)) bySession.set(rec.sessionId, [])
        bySession.get(rec.sessionId)!.push(rec)
      }

      // Build full sessions
      const sessions = sessionPages.map(p => {
        const s   = pageToSession(p)
        const recs = bySession.get(s.id as string) ?? []
        s.exercises = buildExercises(recs)
        return s
      })

      res.status(200).json({ sessions, customExercises: [] })
      return
    }

    // ── PUT ── upsert session
    if (req.method === 'PUT') {
      const body    = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body ?? {})
      const session = body.session as AnyObj | undefined
      if (!session?.id) { res.status(400).json({ error: 'Missing session.id' }); return }

      const existingId = await findSessionPageId(sessionsDb, apiKey, session.id as string)
      let notionId: string

      if (existingId) {
        await nFetch(`/pages/${existingId}`, 'PATCH', apiKey, { properties: buildSessionProps(session) })
        notionId = existingId
      } else {
        const created = await nFetch('/pages', 'POST', apiKey, {
          parent:     { database_id: sessionsDb },
          properties: buildSessionProps(session),
        }) as NotionPage
        notionId = created.id
      }

      // Recreate all exercise pages
      await archiveExercisesForSession(exercisesDb, apiKey, session.id as string)
      await createExercisePages(exercisesDb, apiKey, session, 0)

      res.status(200).json({ ok: true, notionId })
      return
    }

    // ── DELETE ── archive session + exercises
    if (req.method === 'DELETE') {
      const body      = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body ?? {})
      const sessionId = body.sessionId as string | undefined
      if (!sessionId) { res.status(400).json({ error: 'Missing sessionId' }); return }

      const existingId = await findSessionPageId(sessionsDb, apiKey, sessionId)
      if (existingId) {
        await nFetch(`/pages/${existingId}`, 'PATCH', apiKey, { archived: true })
      }
      await archiveExercisesForSession(exercisesDb, apiKey, sessionId)

      res.status(200).json({ ok: true })
      return
    }

    res.status(405).json({ error: 'Method not allowed' })
  } catch (err: any) {
    console.error('[notion/sessions]', err)
    res.status(500).json({ error: err?.message ?? 'Internal error' })
  }
}
