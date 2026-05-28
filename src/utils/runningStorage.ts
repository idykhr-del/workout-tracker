/**
 * src/utils/runningStorage.ts
 * localStorage helpers for running records and Strava tokens.
 */

import type { RunningRecord, StravaTokens } from '../types'

const RECORDS_KEY = 'running_records'
const TOKENS_KEY  = 'strava_tokens'

// ─── Running records ──────────────────────────────────────────────────────────

export function loadRunningRecordsSync(): RunningRecord[] {
  try {
    const raw = localStorage.getItem(RECORDS_KEY)
    if (!raw) return []
    return JSON.parse(raw) as RunningRecord[]
  } catch { return [] }
}

export function saveRunningRecords(records: RunningRecord[]): void {
  try { localStorage.setItem(RECORDS_KEY, JSON.stringify(records)) } catch { /* ignore */ }
}

export function mergeRunningRecords(
  local: RunningRecord[], incoming: RunningRecord[],
): RunningRecord[] {
  const byId = new Map<string, RunningRecord>()
  for (const r of local) byId.set(r.id, r)
  for (const r of incoming) {
    // Prefer incoming (Notion) for shared records
    const existing = byId.get(r.id)
    if (!existing || r.notionPageId) byId.set(r.id, r)
  }
  return Array.from(byId.values())
    .sort((a, b) => b.date.localeCompare(a.date))
}

// ─── Strava tokens ────────────────────────────────────────────────────────────

export function loadStravaTokens(): StravaTokens | null {
  try {
    const raw = localStorage.getItem(TOKENS_KEY)
    if (!raw) return null
    return JSON.parse(raw) as StravaTokens
  } catch { return null }
}

export function saveStravaTokens(tokens: StravaTokens): void {
  try { localStorage.setItem(TOKENS_KEY, JSON.stringify(tokens)) } catch { /* ignore */ }
}

export function clearStravaTokens(): void {
  try { localStorage.removeItem(TOKENS_KEY) } catch { /* ignore */ }
}

export function isStravaConnected(): boolean {
  const t = loadStravaTokens()
  return t != null
}
