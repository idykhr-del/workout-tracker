import { useState, useCallback } from 'react'
import type { WorkoutData, WorkoutSession, CustomExercise } from '../types'

const STORAGE_KEY = 'workout_data'

function loadData(): WorkoutData {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) return JSON.parse(raw)
  } catch {
    // ignore
  }
  return { sessions: [], customExercises: [] }
}

function saveData(data: WorkoutData) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(data))
}

export function useWorkoutData() {
  const [data, setData] = useState<WorkoutData>(loadData)

  const persist = useCallback((next: WorkoutData) => {
    saveData(next)
    setData(next)
  }, [])

  const saveSession = useCallback((session: WorkoutSession) => {
    setData(prev => {
      const idx = prev.sessions.findIndex(s => s.id === session.id)
      const sessions =
        idx >= 0
          ? prev.sessions.map(s => (s.id === session.id ? session : s))
          : [...prev.sessions, session]
      const next = { ...prev, sessions }
      saveData(next)
      return next
    })
  }, [])

  const deleteSession = useCallback((id: string) => {
    setData(prev => {
      const next = { ...prev, sessions: prev.sessions.filter(s => s.id !== id) }
      saveData(next)
      return next
    })
  }, [])

  const addCustomExercise = useCallback((ex: CustomExercise) => {
    setData(prev => {
      const already = prev.customExercises.some(
        c => c.category === ex.category && c.name === ex.name
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
          c => !(c.category === category && c.name === name)
        ),
      }
      saveData(next)
      return next
    })
  }, [])

  const resetData = useCallback(() => {
    const next: WorkoutData = { sessions: [], customExercises: [] }
    persist(next)
  }, [persist])

  return {
    data,
    saveSession,
    deleteSession,
    addCustomExercise,
    deleteCustomExercise,
    resetData,
  }
}
