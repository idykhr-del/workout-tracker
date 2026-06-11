/**
 * api/notion/backfill-order.ts
 * Vercel Serverless Function
 *
 * POST → Backfill the "order" property on existing workout_exercises pages.
 *
 * Algorithm:
 *   1. Fetch all exercise pages (including created_time metadata).
 *   2. Group pages by session_id.
 *   3. Within each session group, determine unique exercise instances
 *      (by exercise name + instanceId extracted from memo __EXTRA__ if present).
 *   4. Sort instances by the earliest page created_time in the group.
 *   5. Assign order = 1, 2, 3… to each instance (all sets of that instance
 *      get the same order value).
 *   6. PATCH each page whose order property is currently empty.
 *      Skip pages that already have an order value (idempotent).
 *
 * Body (JSON, optional):
 *   { dryRun?: boolean }
 *   dryRun=true → prints what would be updated without writing to Notion.
 *
 * Returns:
 *   { ok, updated, skipped, alreadySet, errors, preview? }
 *   preview: included in dryRun mode — array of { pageId, sessionId, name, order }
 *
 * Environment variables:
 *   NOTION_API_KEY
 *   NOTION_EXERCISES_DB_ID
 *
 * Rate limit: 350 ms between writes (≈ 3 req/s, safe margin under Notion's limit).
 */

const NOTION_BASE    = 'https://api.notion.com/v1'
const NOTION_VERSION = '2022-06-28'
const WRITE_DELAY_MS = 350

type AnyObj = Record<string, unknown>

interface NotionPage {
  id:           string
  created_time: string
  properties:   Record<string, AnyObj>
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
    if (filter) body.filter = filter

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

/** Read a number property. Returns undefined if absent or null. */
function getNum(page: NotionPage, prop: string): number | undefined {
  const v = (page.properties?.[prop] as AnyObj)?.number
  return typeof v === 'number' ? v : undefined
}

/**
 * Attempt to extract instanceId from the __EXTRA__{...} suffix in the memo field.
 * Returns undefined if no extra data or instanceId is absent.
 */
function extractInstanceId(page: NotionPage): string | undefined {
  const memoRaw = getText(page, 'memo')
  const sep     = '__EXTRA__'
  const idx     = memoRaw.indexOf(sep)
  if (idx < 0) return undefined
  try {
    const extra = JSON.parse(memoRaw.slice(idx + sep.length)) as Record<string, unknown>
    return typeof extra.instanceId === 'string' ? extra.instanceId : undefined
  } catch {
    return undefined
  }
}

/** PATCH one exercise page's order property, with 429 retry. */
async function patchOrder(
  pageId: string,
  order: number,
  apiKey: string,
): Promise<'ok' | 'error'> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(`${NOTION_BASE}/pages/${pageId}`, {
      method:  'PATCH',
      headers: mkHeaders(apiKey),
      body:    JSON.stringify({
        properties: {
          order: { number: order },
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
      console.warn(`[backfill-order] PATCH ${pageId} failed: ${msg}`)
      return 'error'
    }
    return 'ok'
  }
  console.warn(`[backfill-order] PATCH ${pageId}: max retries exceeded`)
  return 'error'
}

// ─── Main handler ─────────────────────────────────────────────────────────────

export default async function handler(req: any, res: any) {
  res.setHeader('Cache-Control', 'no-store')

  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' }); return
  }

  const apiKey      = process.env.NOTION_API_KEY
  const exercisesDb = process.env.NOTION_EXERCISES_DB_ID

  if (!apiKey || !exercisesDb) {
    res.status(500).json({ error: 'Missing NOTION_API_KEY or NOTION_EXERCISES_DB_ID' }); return
  }

  const body    = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body ?? {})
  const dryRun  = body.dryRun === true

  console.log(`[backfill-order] start (dryRun=${dryRun})`)

  try {
    // ── Step 1: Fetch all exercise pages ──────────────────────────────────────
    console.log('[backfill-order] fetching all exercise pages…')
    const allPages = await queryAll(exercisesDb, apiKey)
    console.log(`[backfill-order] ${allPages.length} pages fetched`)

    // ── Step 2: Group pages by session_id ─────────────────────────────────────
    const bySession = new Map<string, NotionPage[]>()
    for (const page of allPages) {
      const sid = getText(page, 'session_id')
      if (!sid) continue
      if (!bySession.has(sid)) bySession.set(sid, [])
      bySession.get(sid)!.push(page)
    }
    console.log(`[backfill-order] ${bySession.size} unique sessions`)

    // ── Step 3: Compute target orders per page ────────────────────────────────
    // Maps pageId → target order number
    const orderMap = new Map<string, number>()

    for (const [, pages] of bySession) {
      // Group pages by exercise instance: (name + instanceId)
      // Use created_time to sort instances in appearance order.
      const instanceMap = new Map<string, { minCreated: string; pages: NotionPage[] }>()

      for (const page of pages) {
        const name       = getText(page, 'Name')
        const instanceId = extractInstanceId(page) ?? ''
        const instKey    = `${name}\x00${instanceId}`

        if (!instanceMap.has(instKey)) {
          instanceMap.set(instKey, { minCreated: page.created_time, pages: [] })
        }
        const entry = instanceMap.get(instKey)!
        entry.pages.push(page)
        if (page.created_time < entry.minCreated) {
          entry.minCreated = page.created_time
        }
      }

      // Sort instances by earliest created_time → assign order 1, 2, 3…
      const sorted = [...instanceMap.values()]
        .sort((a, b) => a.minCreated.localeCompare(b.minCreated))

      sorted.forEach((inst, idx) => {
        const order = idx + 1
        for (const page of inst.pages) {
          orderMap.set(page.id, order)
        }
      })
    }

    // ── Step 4: Apply or preview ──────────────────────────────────────────────
    let updated    = 0
    let skipped    = 0
    let alreadySet = 0
    let errors     = 0

    type PreviewItem = { pageId: string; sessionId: string; name: string; order: number }
    const preview: PreviewItem[] = []

    for (const page of allPages) {
      const targetOrder = orderMap.get(page.id)
      if (targetOrder == null) {
        // Page had no session_id (skipped in grouping)
        skipped++
        continue
      }

      const currentOrder = getNum(page, 'order')
      if (currentOrder != null) {
        // Already has an order — skip to keep idempotent
        alreadySet++
        continue
      }

      if (dryRun) {
        preview.push({
          pageId:    page.id,
          sessionId: getText(page, 'session_id'),
          name:      getText(page, 'Name'),
          order:     targetOrder,
        })
        updated++
        continue
      }

      const result = await patchOrder(page.id, targetOrder, apiKey)
      if (result === 'ok') {
        updated++
        console.log(`[backfill-order] ✅ ${page.id} (${getText(page, 'Name')}) → order=${targetOrder}`)
      } else {
        errors++
      }

      await sleep(WRITE_DELAY_MS)
    }

    console.log(
      `[backfill-order] done — updated=${updated} skipped=${skipped} alreadySet=${alreadySet} errors=${errors}`,
    )

    const responseBody: AnyObj = { ok: true, dryRun, updated, skipped, alreadySet, errors }
    if (dryRun) responseBody.preview = preview

    res.status(200).json(responseBody)

  } catch (err: any) {
    console.error('[backfill-order] fatal:', err)
    res.status(500).json({ error: err?.message ?? 'Internal error' })
  }
}
