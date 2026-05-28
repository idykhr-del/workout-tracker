/**
 * api/notion/backfill-relations.ts
 * Vercel Serverless Function
 *
 * POST → Scan all workout_exercises where session_relation is empty,
 *        look up the matching workout_sessions page by session_id / original_id,
 *        and PATCH the relation property on each exercise record.
 *
 * Returns: { ok, updated, skipped, errors }
 *   updated — relation was set successfully
 *   skipped — no matching session found for that session_id
 *   errors  — PATCH call failed
 *
 * Environment variables (same as sessions.ts):
 *   NOTION_API_KEY
 *   NOTION_SESSIONS_DB_ID
 *   NOTION_EXERCISES_DB_ID
 */

const NOTION_BASE    = 'https://api.notion.com/v1'
const NOTION_VERSION = '2022-06-28'

type AnyObj = Record<string, unknown>

interface NotionPage {
  id:         string
  properties: Record<string, AnyObj>
}

function mkHeaders(apiKey: string) {
  return {
    Authorization:    `Bearer ${apiKey}`,
    'Notion-Version': NOTION_VERSION,
    'Content-Type':   'application/json',
  }
}

async function sleep(ms: number) {
  return new Promise(r => setTimeout(r, ms))
}

/** Cursor-based pagination — fetches every page from a database. */
async function queryAll(
  dbId: string,
  apiKey: string,
  filter?: AnyObj,
): Promise<NotionPage[]> {
  const results: NotionPage[] = []
  let cursor: string | undefined

  while (true) {
    const body: AnyObj = { page_size: 100 }
    if (cursor) body.start_cursor = cursor
    if (filter) body.filter       = filter

    const res = await fetch(`${NOTION_BASE}/databases/${dbId}/query`, {
      method:  'POST',
      headers: mkHeaders(apiKey),
      body:    JSON.stringify(body),
    })

    if (res.status === 429) {
      const wait = parseInt(res.headers.get('Retry-After') ?? '1', 10) * 1000
      await sleep(Math.max(wait, 1000))
      continue
    }
    if (!res.ok) {
      const txt = await res.text().catch(() => String(res.status))
      throw new Error(`queryAll(${dbId}) → ${res.status}: ${txt}`)
    }

    const data = await res.json() as AnyObj
    results.push(...((data.results ?? []) as NotionPage[]))
    if (!data.has_more) break
    cursor = data.next_cursor as string
  }

  return results
}

/** Read a rich_text or title property as a plain string. */
function getText(page: NotionPage, prop: string): string {
  const p = page.properties?.[prop]
  if (!p) return ''
  const arr = (p.rich_text ?? p.title ?? []) as AnyObj[]
  return arr.map(t => (t as AnyObj).plain_text ?? '').join('')
}

/** PATCH one exercise page to set session_relation, with 429 retry. */
async function patchRelation(
  pageId: string,
  sessionNotionId: string,
  apiKey: string,
): Promise<'ok' | 'error'> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(`${NOTION_BASE}/pages/${pageId}`, {
      method:  'PATCH',
      headers: mkHeaders(apiKey),
      body:    JSON.stringify({
        properties: {
          session_relation: {
            relation: [{ id: sessionNotionId }],
          },
        },
      }),
    })

    if (res.status === 429) {
      const wait = parseInt(res.headers.get('Retry-After') ?? '1', 10) * 1000
      await sleep(Math.max(wait, 1000))
      continue
    }
    if (!res.ok) {
      let msg = `HTTP ${res.status}`
      try {
        const j = await res.json() as Record<string, unknown>
        msg = `[${j['code'] ?? 'error'}] ${j['message'] ?? msg}`
      } catch { /* ignore */ }
      console.warn(`[backfill] PATCH ${pageId} failed: ${msg}`)
      return 'error'
    }
    return 'ok'
  }
  console.warn(`[backfill] PATCH ${pageId}: max retries exceeded`)
  return 'error'
}

// ─── Main handler ─────────────────────────────────────────────────────────────

export default async function handler(req: any, res: any) {
  res.setHeader('Cache-Control', 'no-store')

  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' }); return
  }

  const apiKey      = process.env.NOTION_API_KEY
  const sessionsDb  = process.env.NOTION_SESSIONS_DB_ID
  const exercisesDb = process.env.NOTION_EXERCISES_DB_ID

  if (!apiKey || !sessionsDb || !exercisesDb) {
    res.status(500).json({ error: 'Missing NOTION_API_KEY / NOTION_SESSIONS_DB_ID / NOTION_EXERCISES_DB_ID' })
    return
  }

  try {
    // ── Step 1: build original_id → Notion page ID map from sessions ──────────
    console.log('[backfill] fetching all sessions…')
    const sessionPages = await queryAll(sessionsDb, apiKey)

    const sessionMap = new Map<string, string>() // original_id → notion page id
    for (const p of sessionPages) {
      const originalId = getText(p, 'original_id')
      if (originalId) sessionMap.set(originalId, p.id)
    }
    console.log(`[backfill] ${sessionPages.length} sessions, ${sessionMap.size} with original_id`)

    // ── Step 2: fetch exercises where session_relation is empty ───────────────
    console.log('[backfill] fetching exercises without session_relation…')
    const exercisePages = await queryAll(exercisesDb, apiKey, {
      property: 'session_relation',
      relation: { is_empty: true },
    })
    console.log(`[backfill] ${exercisePages.length} exercises to backfill`)

    if (exercisePages.length === 0) {
      res.status(200).json({ ok: true, updated: 0, skipped: 0, errors: 0 })
      return
    }

    // ── Step 3: patch each exercise ───────────────────────────────────────────
    let updated = 0
    let skipped = 0
    let errors  = 0

    for (const exPage of exercisePages) {
      const sessionId      = getText(exPage, 'session_id')
      const sessionNotionId = sessionId ? sessionMap.get(sessionId) : undefined

      if (!sessionNotionId) {
        console.warn(`[backfill] no session for session_id="${sessionId}" (exercise ${exPage.id})`)
        skipped++
        await sleep(50)  // still pace ourselves even on skips
        continue
      }

      const result = await patchRelation(exPage.id, sessionNotionId, apiKey)
      if (result === 'ok') {
        updated++
        console.log(`[backfill] ✅ ${exPage.id} → session ${sessionNotionId}`)
      } else {
        errors++
      }

      await sleep(100)  // ~10 req/s — well within Notion's 3 req/s burst allowance
    }

    console.log(`[backfill] done — updated=${updated} skipped=${skipped} errors=${errors}`)
    res.status(200).json({ ok: true, updated, skipped, errors })

  } catch (err: any) {
    console.error('[backfill] fatal:', err)
    res.status(500).json({ error: err?.message ?? 'Internal error' })
  }
}
