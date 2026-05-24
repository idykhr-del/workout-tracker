/**
 * useWorkoutData.ts
 *
 * Storage strategy (layered):
 *   1. React state       — instant, in-memory (what the UI sees)
 *   2. localStorage+IDB  — local persistent cache (existing)
 *   3. Notion API        — source-of-truth sync (new, async/background)
 *
 * Startup sequence:
 *   a) Initialise from localStorage instantly (no visible flash)
 *   b) Check IndexedDB for more data (existing IDB hydration)
 *   c) Fetch from Notion → merge → update localStorage
 *      If localStorage was empty → show isNotionLoading skeleton
 *
 * Writes: optimistic (state updates immediately), then async Notion sync.
 */

import { useState, useCallback, useEffect, useRef } from 'react'
import type { WorkoutData, WorkoutSession, CustomExercise } from '../types'
import {
  loadDataSync,
  loadDataAsync,
  saveData,
  clearData,
  clearUsage,
  mergeWorkoutData,
} from '../utils/storage'
import {
  loadFromNotion,
  syncSession    as notionSync,
  deleteFromNotion,
  mergeWithNotion,
} from '../utils/notionSync'

export function useWorkoutData() {
  const initial = loadDataSync()

  // ── State ─────────────────────────────────────────────────────────────────
  const [data, setData] = useState<WorkoutData>(initial)

  /**
   * isNotionLoading: true only when localStorage was empty at boot AND
   * we are awaiting the first Notion response.  Consumers can show a skeleton.
   */
  const [isNotionLoading, setIsNotionLoading] = useState<boolean>(
    initial.sessions.length === 0,
  )

  const notionFetched = useRef(false)

  // ── Startup hydration ──────────────────────────────────────────────────────
  useEffect(() => {
    if (notionFetched.current) return
    notionFetched.current = true

    // IDB hydration (existing behaviour, fast)
    loadDataAsync().then(idbData => {
      if (!idbData) return
      setData(prev => {
        const merged = mergeWorkoutData(prev, idbData)
        return merged === prev ? prev : merged
      })
    })

    // Notion hydration (network, slower)
    loadFromNotion()
      .then(notionData => {
        setIsNotionLoading(false)
        if (!notionData || notionData.sessions.length === 0) return
        setData(prev => {
          const merged = mergeWithNotion(prev, notionData)
          // Only re-render + persist if something actually changed
          const changed =
            merged.sessions.length !== prev.sessions.length ||
            merged.sessions.some((s, i) => s.id !== prev.sessions[i]?.id)
          if (changed) saveData(merged)
          return changed ? merged : prev
        })
      })
      .catch(() => setIsNotionLoading(false))
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ── Mutations ──────────────────────────────────────────────────────────────

  const saveSession = useCallback((session: WorkoutSession) => {
    setData(prev => {
      const idx      = prev.sessions.findIndex(s => s.id === session.id)
      const sessions = idx >= 0
        ? prev.sessions.map(s => s.id === session.id ? session : s)
        : [...prev.sessions, session]
      const next = { ...prev, sessions }
      saveData(next)        // sync localStorage + async IDB
      return next
    })
    notionSync(session)     // async Notion sync (fire-and-forget)
  }, [])

  const deleteSession = useCallback((id: string) => {
    setData(prev => {
      const next = { ...prev, sessions: prev.sessions.filter(s => s.id !== id) }
      saveData(next)
      return next
    })
    deleteFromNotion(id)    // async Notion archive (fire-and-forget)
  }, [])

  const addCustomExercise = useCallback((ex: CustomExercise) => {
    setData(prev => {
      const already = prev.customExercises.some(
        c => c.category === ex.category && c.name === ex.name,
      )
      if (already) return prev
      const next = { ...prev, customExercises: [...prev.customExercises, ex] }
      saveData(next)
      return next
    })
  }, [])

  const deleteCustomExercise = useCallback((category: string, name: string) => {
    setData(prev => {
      const next = {
        ...prev,
        customExercises: prev.customExercises.filter(
          c => !(c.category === category && c.name === name),
        ),
      }
      saveData(next)
      return next
    })
  }, [])

  const resetData = useCallback(() => {
    const empty: WorkoutData = { sessions: [], customExercises: [] }
    clearData()
    clearUsage()
    setData(empty)
    // Note: Notion records are NOT deleted on reset to prevent data loss.
    // Clear Notion DB manually if needed.
  }, [])

  return {
    data,
    isNotionLoading,
    saveSession,
    deleteSession,
    addCustomExercise,
    deleteCustomExercise,
    resetData,
  }
}
