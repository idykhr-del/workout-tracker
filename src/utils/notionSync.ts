/**
 * src/utils/notionSync.ts
 *
 * Client-side helpers that call the /api/notion/sessions Vercel Function.
 * All network writes are fire-and-forget — they never block the UI.
 *
 * Reading (loadFromNotion) is awaited only once at startup to hydrate
 * the app when localStorage is empty (cross-device scenario).
 */

import type { WorkoutData, WorkoutSession } from '../types'

const API           = '/api/notion/sessions'
const EXERCISES_API = '/api/notion/exercises'

// ── Read ─────────────────────────────────────────────────────────────────────

/**
 * Fetch all WorkoutData from Notion.
 * Returns null if the server is not configured or a network error occurs.
 */
export async function loadFromNotion(): Promise<WorkoutData | null> {
  try {
    const res = await fetch(API, { signal: AbortSignal.timeout(15_000) })
    if (!res.ok) return null
    const json = await res.json()
    // Ensure shape matches WorkoutData
    if (!Array.isArray(json?.sessions)) return null
    return json as WorkoutData
  } catch {
    return null
  }
}

// ── Writes (fire-and-forget) ─────────────────────────────────────────────────

/**
 * Upsert one session to Notion in the background.
 * Errors are swallowed (logged to console).
 * @param onError  Optional callback for error visibility (e.g. toast)
 */
export function syncSession(
  session: WorkoutSession,
  onError?: (msg: string) => void,
): void {
  fetch(API, {
    method:  'PUT',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ session }),
  })
    .then(async res => {
      if (!res.ok) {
        const txt = await res.text().catch(() => res.statusText)
        console.warn('[notionSync] sync failed:', txt)
        onError?.(`Notion同期エラー: ${res.status}`)
      }
    })
    .catch(err => {
      console.warn('[notionSync] sync error:', err)
    })
}

/**
 * Archive (soft-delete) one session from Notion in the background.
 */
export function deleteFromNotion(
  sessionId: string,
  onError?: (msg: string) => void,
): void {
  fetch(API, {
    method:  'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ sessionId }),
  })
    .then(async res => {
      if (!res.ok) {
        const txt = await res.text().catch(() => res.statusText)
        console.warn('[notionSync] delete failed:', txt)
        onError?.(`Notion削除エラー: ${res.status}`)
      }
    })
    .catch(err => {
      console.warn('[notionSync] delete error:', err)
    })
}

// ── Batch migration ───────────────────────────────────────────────────────────

export interface MigrationResult {
  success: number
  errors:  number
}

const MIGRATION_KEY = 'notion_migrated'

export function hasMigrated(): boolean {
  try { return localStorage.getItem(MIGRATION_KEY) === '1' } catch { return false }
}

export function markMigrated(): void {
  try { localStorage.setItem(MIGRATION_KEY, '1') } catch { /* ignore */ }
}

/**
 * Migrate all sessions + exercise sets to Notion.
 *
 * Flow per session:
 *   1. PUT session metadata (exercises: [] so the server only upserts the
 *      session row and clears old exercise pages, but creates nothing new).
 *   2. POST each exercise set individually to /api/notion/exercises,
 *      waiting 300 ms between requests.
 *   3. Wait 800 ms before the next session.
 *
 * Progress is reported as (done, total) where
 *   total = sessions.length + Σ(all set counts)
 *
 * Errors never abort the loop — the result always reports success/error counts.
 */
export async function migrateToNotion(
  sessions: WorkoutSession[],
  onProgress: (done: number, total: number) => void,
): Promise<MigrationResult> {
  let success = 0
  let errors  = 0
  let done    = 0

  const totalSets = sessions.reduce(
    (sum, s) => sum + s.exercises.reduce((s2, e) => s2 + e.sets.length, 0), 0,
  )
  const total = sessions.length + totalSets
  console.log(`[migrate] start — ${sessions.length} sessions, ${totalSets} sets, total=${total}`)

  for (let i = 0; i < sessions.length; i++) {
    const s = sessions[i]

    // ── 1. Upsert session record (exercises: [] keeps the server call fast) ──
    let sessionNotionId: string | undefined
    try {
      const res = await fetch(API, {
        method:  'PUT',
        headers: { 'Content-Type': 'application/json' },
        // Pass exercises: [] so the server only touches the session row and
        // archives any stale exercise pages without creating new ones.
        body: JSON.stringify({ session: { ...s, exercises: [] } }),
      })
      if (res.ok) {
        success++
        const resBody = await res.json().catch(() => ({})) as Record<string, unknown>
        sessionNotionId = typeof resBody.notionId === 'string' ? resBody.notionId : undefined
        console.log(
          `[migrate] ✅ session (${i + 1}/${sessions.length}) id=${s.id} date=${s.date} notionId=${sessionNotionId ?? '?'}`,
        )
      } else {
        errors++
        let errBody: unknown = null
        try { errBody = await res.json() } catch { /* ignore */ }
        console.warn(
          `[migrate] ❌ session HTTP ${res.status} — id=${s.id} date=${s.date}`,
          errBody ?? '(no body)',
        )
      }
    } catch (err) {
      errors++
      console.error(`[migrate] ❌ session network error — id=${s.id} date=${s.date}`, err)
    }

    done++
    onProgress(done, total)

    // ── 2. POST each exercise set ──────────────────────────────────────────
    const totalSetsForSession = s.exercises.reduce((n, e) => n + e.sets.length, 0)
    console.log(
      `[migrate] → exercises: ${s.exercises.length} types, ${totalSetsForSession} sets for session ${s.date}`,
    )

    for (const ex of s.exercises) {
      for (let j = 0; j < ex.sets.length; j++) {
        // Wait 300 ms before each exercise POST (gives Notion time to breathe)
        await delay(300)

        const setLabel = `${ex.name} set${j + 1} / session ${s.date}`
        const payload: Record<string, unknown> = {
          sessionId:  s.id,
          category:   ex.category,
          name:       ex.name,
          instanceId: ex.instanceId,
          setNumber:  j + 1,
          set:        ex.sets[j],
          date:       s.date,
          // session_relation をセットするために親セッションの Notion page ID を渡す
          // ステップ1が失敗した場合は undefined になり、サーバー側で省略される
          ...(sessionNotionId ? { sessionNotionId } : {}),
        }
        console.log(`[migrate] → POST ${EXERCISES_API} — ${setLabel}`, payload)

        try {
          const res = await fetch(EXERCISES_API, {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            // クライアント側でも memo を事前にクリーンアップ（サーバー側と二重で保護）
            body:    JSON.stringify({
              ...payload,
              set: { ...payload.set, memo: cleanMemo(payload.set.memo) },
            }),
          })
          if (res.ok) {
            success++
            const resBody = await res.json().catch(() => ({})) as Record<string, unknown>
            console.log(`[migrate] ✅ exercise — ${setLabel} → notionId=${resBody.id ?? '?'}`)
          } else {
            errors++
            let errBody: unknown = null
            try { errBody = await res.json() } catch { /* ignore */ }
            console.warn(`[migrate] ❌ exercise HTTP ${res.status} — ${setLabel}`, errBody ?? '(no body)')
          }
        } catch (err) {
          errors++
          console.error(`[migrate] ❌ exercise network error — ${setLabel}`, err)
        }

        done++
        onProgress(done, total)
      }
    }

    // ── 3. Wait 800 ms between sessions ───────────────────────────────────
    if (i < sessions.length - 1) await delay(800)
  }

  console.log(`[migrate] done — success=${success} errors=${errors} total=${total}`)
  return { success, errors }
}

function delay(ms: number) {
  return new Promise<void>(r => setTimeout(r, ms))
}

/** __EXTRA__{...} サフィックスを除去してユーザーメモだけ返す */
function cleanMemo(m: string | undefined): string | undefined {
  if (!m) return m
  const i = m.indexOf('__EXTRA__')
  return i !== -1 ? (m.substring(0, i).trim() || undefined) : m
}

// ── Merge helper ─────────────────────────────────────────────────────────────

/**
 * Merge Notion data into local WorkoutData.
 * - Sessions present in Notion but not local → add them.
 * - Sessions present in both → prefer Notion (source of truth).
 * - Sessions only in local → keep (may not have been synced yet).
 * - customExercises → always keep local (no Notion table for these).
 */
export function mergeWithNotion(local: WorkoutData, notion: WorkoutData): WorkoutData {
  const byId = new Map<string, WorkoutSession>()

  // Start with local
  for (const s of local.sessions) byId.set(s.id, s)

  // Overwrite / add from Notion
  for (const s of notion.sessions) {
    const localSession = byId.get(s.id)
    if (!localSession) {
      byId.set(s.id, s)
    } else {
      // Prefer the one with more set data (conservative merge)
      const localSets  = localSession.exercises.reduce((c, e) => c + e.sets.length, 0)
      const notionSets = s.exercises.reduce((c, e) => c + e.sets.length, 0)
      byId.set(s.id, notionSets >= localSets ? s : localSession)
    }
  }

  const sessions = Array.from(byId.values())
    .sort((a, b) => b.date.localeCompare(a.date) || (b.startTime ?? '').localeCompare(a.startTime ?? ''))

  return { sessions, customExercises: local.customExercises }
}
