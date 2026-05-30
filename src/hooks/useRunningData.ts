/**
 * src/hooks/useRunningData.ts
 *
 * Storage strategy:
 *   1. React state  — instant, in-memory
 *   2. localStorage — running records cache only (no tokens stored here)
 *   3. Notion API   — source of truth for both records and Strava tokens
 *
 * Startup:
 *   a) Read running records from localStorage instantly
 *   b) If empty → call /api/notion/running to hydrate
 *   c) Check Strava connection via GET /api/strava/sync?status=1 (reads Notion)
 */

import { useState, useEffect, useRef, useCallback } from 'react'
import type { RunningRecord } from '../types'
import {
  loadRunningRecordsSync,
  saveRunningRecords,
  mergeRunningRecords,
} from '../utils/runningStorage'

const API_RUNNING = '/api/notion/running'
const API_SYNC    = '/api/strava/sync'

interface SyncResult {
  synced: number
  error?: string
}

interface StatusResult {
  connected: boolean
  lastSync?: string   // ISO string
}

export function useRunningData() {
  const initial = loadRunningRecordsSync()

  const [records,         setRecords]         = useState<RunningRecord[]>(initial)
  const [stravaConnected, setStravaConnected] = useState<boolean>(false)  // always confirmed via server
  const [lastSync,        setLastSync]        = useState<string | null>(null)
  const [isLoading,       setIsLoading]       = useState<boolean>(initial.length === 0)
  const [syncing,         setSyncing]         = useState(false)

  const fetched = useRef(false)

  // ── Startup: hydrate from Notion if localStorage empty ────────────────────
  useEffect(() => {
    if (fetched.current) return
    fetched.current = true

    // Check Strava connection status from Notion via server (single source of truth)
    fetch(`${API_SYNC}?status=1`)
      .then(r => r.json() as Promise<StatusResult>)
      .then(status => {
        setStravaConnected(status.connected)
        if (status.lastSync) setLastSync(status.lastSync)
      })
      .catch(() => { /* silently ignore — may not be configured */ })

    // Hydrate running records from Notion
    if (initial.length > 0) {
      setIsLoading(false)
      return
    }
    fetch(API_RUNNING)
      .then(r => r.ok ? r.json() as Promise<{ records: RunningRecord[] }> : null)
      .then(data => {
        if (!data?.records?.length) return
        const merged = mergeRunningRecords([], data.records)
        setRecords(merged)
        saveRunningRecords(merged)
      })
      .catch(() => { /* offline / not configured */ })
      .finally(() => setIsLoading(false))
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ── Add a manually-entered record ─────────────────────────────────────────
  const addRecord = useCallback(async (record: Omit<RunningRecord, 'id' | 'source'>) => {
    const newRecord: RunningRecord = {
      ...record,
      id:     crypto.randomUUID(),
      source: 'manual',
    }

    // Optimistic update
    setRecords(prev => {
      const next = mergeRunningRecords(prev, [newRecord])
      saveRunningRecords(next)
      return next
    })

    // Persist to Notion (fire-and-forget)
    fetch(API_RUNNING, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ record: newRecord }),
    })
      .then(async r => {
        if (r.ok) {
          const { id: notionPageId } = await r.json() as { id: string }
          // Attach notionPageId so deletes work
          setRecords(prev => {
            const next = prev.map(rec =>
              rec.id === newRecord.id ? { ...rec, notionPageId } : rec,
            )
            saveRunningRecords(next)
            return next
          })
        }
      })
      .catch(() => { /* offline */ })
  }, [])

  // ── Delete a record ───────────────────────────────────────────────────────
  const deleteRecord = useCallback((id: string) => {
    let notionPageId: string | undefined
    setRecords(prev => {
      const target = prev.find(r => r.id === id)
      notionPageId = target?.notionPageId
      const next = prev.filter(r => r.id !== id)
      saveRunningRecords(next)
      return next
    })
    if (notionPageId) {
      fetch(API_RUNNING, {
        method:  'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ notionPageId }),
      }).catch(() => { /* offline */ })
    }
  }, [])

  // ── Disconnect Strava ─────────────────────────────────────────────────────
  const disconnectStrava = useCallback(() => {
    setStravaConnected(false)
    setLastSync(null)
  }, [])

  // ── Sync from Strava ──────────────────────────────────────────────────────
  const syncStrava = useCallback(async (): Promise<SyncResult> => {
    setSyncing(true)
    try {
      const res = await fetch(API_SYNC, { method: 'POST' })
      const data = await res.json() as {
        ok?: boolean; synced?: number; records?: RunningRecord[]; error?: string
      }

      if (!res.ok || data.error) {
        if (res.status === 401 || (data.error ?? '').includes('token')) {
          setStravaConnected(false)
        }
        return { synced: 0, error: data.error ?? `HTTP ${res.status}` }
      }

      const newRecords = (data.records ?? []) as RunningRecord[]
      if (newRecords.length > 0) {
        setRecords(prev => {
          const merged = mergeRunningRecords(prev, newRecords)
          saveRunningRecords(merged)
          return merged
        })
      }

      setStravaConnected(true)
      setLastSync(new Date().toISOString())

      return { synced: data.synced ?? newRecords.length }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Network error'
      return { synced: 0, error: msg }
    } finally {
      setSyncing(false)
    }
  }, [])

  return {
    records,
    stravaConnected,
    lastSync,
    isLoading,
    syncing,
    addRecord,
    deleteRecord,
    disconnectStrava,
    syncStrava,
  }
}
