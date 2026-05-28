/**
 * src/hooks/useRunningData.ts
 *
 * Storage strategy (same layered approach as useWorkoutData):
 *   1. React state       — instant, in-memory
 *   2. localStorage      — local persistent cache
 *   3. Notion API        — source-of-truth sync (async)
 *
 * Startup:
 *   a) Read from localStorage instantly
 *   b) If empty → call /api/notion/running to hydrate
 *   c) After each Strava sync → update both state and localStorage
 */

import { useState, useEffect, useRef, useCallback } from 'react'
import type { RunningRecord } from '../types'
import {
  loadRunningRecordsSync,
  saveRunningRecords,
  mergeRunningRecords,
  loadStravaTokens,
  saveStravaTokens,
  clearStravaTokens,
  isStravaConnected,
} from '../utils/runningStorage'

const API_RUNNING = '/api/notion/running'
const API_SYNC    = '/api/strava/sync'
const API_AUTH    = '/api/strava/auth'

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
  const [stravaConnected, setStravaConnected] = useState<boolean>(isStravaConnected())
  const [lastSync,        setLastSync]        = useState<string | null>(null)
  const [isLoading,       setIsLoading]       = useState<boolean>(initial.length === 0)
  const [syncing,         setSyncing]         = useState(false)

  const fetched = useRef(false)

  // ── Startup: hydrate from Notion if localStorage empty ────────────────────
  useEffect(() => {
    if (fetched.current) return
    fetched.current = true

    // Check Strava connection status from server (picks up auth done on other devices / after callback)
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

  // ── Open Strava OAuth in a new window (iOS PWA compatible) ──────────────
  //
  // window.location.href navigates the PWA away and loses its state on iOS.
  // window.open('_blank') opens a new Safari window instead, leaving the PWA
  // intact. The callback page calls window.close() to dismiss Safari and the
  // user is returned to the PWA automatically.
  //
  // Two signals to detect completion:
  //   1. postMessage { type: 'strava_connected' } sent by the callback page
  //   2. Polling: popup.closed becomes true after window.close()
  // Either one triggers a server status re-check to confirm connection.
  const connectStrava = useCallback(() => {
    // Do NOT use noopener/noreferrer — we need window.opener in the callback
    const popup = window.open(API_AUTH, '_blank')

    const recheckStatus = () => {
      fetch(`${API_SYNC}?status=1`)
        .then(r => r.json() as Promise<StatusResult>)
        .then(status => {
          setStravaConnected(status.connected)
          if (status.lastSync) setLastSync(status.lastSync)
        })
        .catch(() => {})
    }

    // Signal 1: postMessage from callback page
    const handleMessage = (e: MessageEvent) => {
      if ((e.data as { type?: string })?.type === 'strava_connected') {
        window.removeEventListener('message', handleMessage)
        recheckStatus()
      }
    }
    window.addEventListener('message', handleMessage)

    // Signal 2: poll until popup closes (fallback for cases where postMessage
    // is blocked, e.g. cross-origin restrictions in some iOS versions)
    if (popup) {
      const timer = setInterval(() => {
        if (popup.closed) {
          clearInterval(timer)
          window.removeEventListener('message', handleMessage)
          recheckStatus()
        }
      }, 600)
    }
  }, [])

  // ── Disconnect Strava ─────────────────────────────────────────────────────
  const disconnectStrava = useCallback(() => {
    clearStravaTokens()
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
        // If Strava says token expired or not found, clear local tokens
        if (res.status === 401 || (data.error ?? '').includes('token')) {
          clearStravaTokens()
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

      // Strava tokens are stored server-side in Notion; update local status
      setStravaConnected(true)
      const now = new Date().toISOString()
      setLastSync(now)

      // Persist updated token metadata to localStorage (for offline status display)
      const existing = loadStravaTokens()
      if (existing) {
        saveStravaTokens({ ...existing, lastSyncEpoch: Math.floor(Date.now() / 1000) })
      } else {
        // Mark as connected without a real token (server has it in Notion)
        saveStravaTokens({ accessToken: '', refreshToken: '', expiresAt: 0, lastSyncEpoch: Math.floor(Date.now() / 1000) })
      }

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
    connectStrava,
    disconnectStrava,
    syncStrava,
  }
}
