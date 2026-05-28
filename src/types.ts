export type Category =
  | '胸'
  | '背中'
  | '腕'
  | '肩'
  | '脚'
  | '腹筋'
  | 'お尻'
  | '有酸素'

export interface WorkoutSet {
  id: string
  weight?: number
  reps?: number
  durationMinutes?: number
  distanceKm?: number
  incline?: number     // ウォーキング傾斜 (%)
  calories?: number    // 推定消費カロリー (kcal)
  grip?: string        // ラットプルダウン グリップ種類
  timestamp: string
  memo?: string
}

export interface ExerciseEntry {
  category: Category
  name: string
  instanceId?: string
  sets: WorkoutSet[]
}

export interface SessionNote {
  score: number
  text: string
  timestamp: string
}

export interface WorkoutSession {
  id: string
  date: string
  startTime: string
  endTime?: string
  rating?: number
  memo?: string
  exercises: ExerciseEntry[]
  notes?: SessionNote[]
  totalCalories?: number   // セッション全体の推定消費カロリー (kcal)
}

export interface CustomExercise {
  category: Category
  name: string
  exerciseType?: 'strength' | 'cardio'  // 未設定の場合は筋トレ扱い
}

export interface WorkoutData {
  sessions: WorkoutSession[]
  customExercises: CustomExercise[]
}

// ── Running / Walking ─────────────────────────────────────────────────────────

export type RunningActivityType = 'running' | 'walking' | 'treadmill' | 'hike'

export interface RunningRecord {
  /** Client-generated UUID */
  id: string
  /** Notion page ID (for PATCH / archive) */
  notionPageId?: string
  /** YYYY-MM-DD */
  date: string
  activityType: RunningActivityType
  /** km */
  distanceKm?: number
  /** seconds */
  durationSec?: number
  /** seconds per km — shown for running / hike */
  avgPaceSec?: number
  avgHeartRate?: number
  maxHeartRate?: number
  calories?: number
  source: 'strava' | 'manual'
  /** Strava activity ID string – used for de-duplication */
  stravaId?: string
  memo?: string
}

export interface StravaTokens {
  accessToken: string
  refreshToken: string
  /** Unix timestamp in seconds */
  expiresAt: number
  /** Unix timestamp in seconds – passed as `after` on next Strava fetch */
  lastSyncEpoch?: number
}
