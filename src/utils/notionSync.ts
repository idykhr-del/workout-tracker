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

const API = '/api/notion/sessions'

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
 * Push all sessions to Notion one-by-one, 500ms apart.
 * Calls onProgress(done, total) after each attempt.
 */
export async function migrateAllSessions(
  sessions: WorkoutSession[],
  onProgress: (done: number, total: number) => void,
): Promise<MigrationResult> {
  let success = 0
  let errors  = 0
  const total = sessions.length

  for (let i = 0; i < total; i++) {
    try {
      const res = await fetch(API, {
        method:  'PUT',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ session: sessions[i] }),
      })
      if (res.ok) {
        success++
      } else {
        errors++
        console.warn('[migration] failed:', sessions[i].id, res.status)
      }
    } catch (err) {
      errors++
      console.warn('[migration] error:', err)
    }

    onProgress(i + 1, total)

    // Respect Notion rate limit: ~3 req/sec → wait 400ms between sessions
    if (i < total - 1) await delay(400)
  }

  return { success, errors }
}

function delay(ms: number) {
  return new Promise<void>(r => setTimeout(r, ms))
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
