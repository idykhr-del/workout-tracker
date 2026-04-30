import { useState, useMemo } from 'react'
import type { WorkoutData, WorkoutSession } from '../types'
import type { Category } from '../types'
import { CATEGORY_ICONS } from '../data/exercises'

interface Props {
  data: WorkoutData
  onUpdateSession: (session: WorkoutSession) => void
}

// ── Edit state types ───────────────────────────────────────────────────────────

interface EditSet {
  id: string
  weight: string
  reps: string
  durationMinutes: string
  distanceKm: string
  incline: string
  memo: string
  timestamp: string
}

interface EditExercise {
  category: Category
  name: string
  instanceId?: string
  sets: EditSet[]
}

interface EditState {
  sessionId: string
  date: string
  startTime: string
  endTime: string
  rating: string
  memo: string
  exercises: EditExercise[]
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function localDateStr(y: number, m: number, d: number): string {
  return `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`
}

function todayLocalStr(): string {
  const d = new Date()
  return localDateStr(d.getFullYear(), d.getMonth(), d.getDate())
}

/** "2026-04-29" → "2026年4月29日" */
function formatDateJP(dateStr: string): string {
  const parts = dateStr.split('-')
  if (parts.length < 3) return dateStr
  return `${parts[0]}年${parseInt(parts[1])}月${parseInt(parts[2])}日`
}

/** "10:30"〜"11:45" → "10:30〜11:45（75分）" */
function formatTimeRange(start: string, end?: string): string {
  if (!start && !end) return ''
  if (!end) return start || '?'
  const toMin = (t: string) => { const [h, m] = t.split(':').map(Number); return h * 60 + m }
  const diff = toMin(end) - toMin(start)
  const durStr = diff > 0
    ? `（${diff >= 60 ? `${Math.floor(diff / 60)}時間${diff % 60 > 0 ? `${diff % 60}分` : ''}` : `${diff}分`}）`
    : ''
  return `${start}〜${end}${durStr}`
}

function totalSetsOfSession(session: WorkoutSession): number {
  return session.exercises.reduce((s, e) => s + e.sets.length, 0)
}

// ── Category badge ─────────────────────────────────────────────────────────────

function CategoryBadge({ category }: { category: Category }) {
  return (
    <span className="inline-flex items-center gap-0.5 text-[10px] font-semibold px-1.5 py-0.5 rounded-md bg-accent/15 text-accent border border-accent/20">
      {CATEGORY_ICONS[category]}{category}
    </span>
  )
}

// ── View: one exercise block ───────────────────────────────────────────────────

function ExerciseBlock({ entry }: { entry: WorkoutSession['exercises'][number] }) {
  const isCardio = entry.category === '有酸素'
  return (
    <div className="py-2.5 px-4">
      <div className="flex items-center justify-between mb-1.5">
        <span className="text-sm font-semibold text-white">{entry.name}</span>
        <CategoryBadge category={entry.category} />
      </div>
      <div className="space-y-1">
        {entry.sets.map((set, j) => (
          <div key={set.id} className="flex items-center gap-2 text-xs">
            <span className="text-muted w-12 shrink-0">セット{j + 1}</span>
            <span className="text-white font-medium">
              {isCardio
                ? [
                    `${set.durationMinutes ?? 0}分`,
                    set.distanceKm ? `${set.distanceKm}km` : null,
                    set.incline ? `傾斜${set.incline}%` : null,
                  ].filter(Boolean).join(' · ')
                : `${set.weight ?? 0}kg × ${set.reps ?? 0}回`}
            </span>
            {set.calories != null && (
              <span className="text-accentGreen">🔥{set.calories}kcal</span>
            )}
            {set.memo && <span className="text-muted truncate">— {set.memo}</span>}
          </div>
        ))}
      </div>
    </div>
  )
}

// ── View: session card ─────────────────────────────────────────────────────────

function SessionCard({
  session,
  onStartEdit,
}: {
  session: WorkoutSession
  onStartEdit: () => void
}) {
  const timeRange = formatTimeRange(session.startTime, session.endTime)
  const sets = totalSetsOfSession(session)

  return (
    <div className="bg-card border border-border rounded-2xl overflow-hidden">
      {/* Header */}
      <div className="px-4 py-3 bg-surface/60 flex items-center justify-between">
        <div>
          <div className="text-sm font-bold text-white">{timeRange || session.startTime || '時刻不明'}</div>
          <div className="text-xs text-muted mt-0.5">{sets}セット</div>
        </div>
        <div className="flex items-center gap-2">
          {session.rating !== undefined && (
            <div className="flex flex-col items-end">
              <span className="text-[10px] text-muted">評価</span>
              <span className="text-accent font-bold text-sm">{session.rating}/10</span>
            </div>
          )}
          <button
            onClick={onStartEdit}
            className="text-xs text-accent border border-accent/30 bg-accent/10 rounded-lg px-2.5 py-1.5 font-medium active:scale-95 transition-all"
          >
            ✏️ 編集
          </button>
        </div>
      </div>

      {/* Exercises */}
      {session.exercises.length > 0 && (
        <div className="divide-y divide-border/60">
          {session.exercises.map((ex, i) => (
            <ExerciseBlock key={`${ex.name}-${ex.instanceId ?? i}`} entry={ex} />
          ))}
        </div>
      )}

      {/* Session memo */}
      {session.memo && (
        <div className="px-4 py-2.5 border-t border-border bg-surface/30">
          <div className="text-[10px] text-muted mb-0.5 uppercase tracking-wide">メモ</div>
          <div className="text-sm text-white">{session.memo}</div>
        </div>
      )}

      {/* Session notes */}
      {(session.notes?.length ?? 0) > 0 && (
        <div className="px-4 py-2.5 border-t border-border bg-surface/30 space-y-1">
          {session.notes!.map((note, i) => (
            <div key={i} className="flex items-start gap-2 text-xs">
              <span className="text-accentGreen font-bold shrink-0">スコア{note.score}</span>
              <span className="text-white">{note.text}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ── Edit: session edit card ────────────────────────────────────────────────────

function EditSessionCard({
  editState,
  onChange,
  onUpdateSet,
  onDeleteSet,
  onDeleteExercise,
  onSave,
  onCancel,
}: {
  editState: EditState
  onChange: (patch: Partial<EditState>) => void
  onUpdateSet: (exIdx: number, setIdx: number, field: keyof EditSet, value: string) => void
  onDeleteSet: (exIdx: number, setIdx: number) => void
  onDeleteExercise: (exIdx: number) => void
  onSave: () => void
  onCancel: () => void
}) {
  return (
    <div className="bg-card border border-accent/40 rounded-2xl overflow-hidden">
      {/* Edit header */}
      <div className="px-4 py-3 bg-accent/10 border-b border-accent/30">
        <div className="text-xs font-bold text-accent uppercase tracking-wider mb-3">✏️ 編集モード</div>

        {/* Date / times */}
        <div className="grid grid-cols-3 gap-2 mb-2">
          <div>
            <label className="text-[10px] text-muted block mb-1">日付</label>
            <input
              type="date"
              value={editState.date}
              onChange={e => onChange({ date: e.target.value })}
              className="w-full bg-surface border border-border rounded-lg px-2 py-1.5 text-white text-xs"
            />
          </div>
          <div>
            <label className="text-[10px] text-muted block mb-1">開始</label>
            <input
              type="time"
              value={editState.startTime}
              onChange={e => onChange({ startTime: e.target.value })}
              className="w-full bg-surface border border-border rounded-lg px-2 py-1.5 text-white text-xs"
            />
          </div>
          <div>
            <label className="text-[10px] text-muted block mb-1">終了</label>
            <input
              type="time"
              value={editState.endTime}
              onChange={e => onChange({ endTime: e.target.value })}
              className="w-full bg-surface border border-border rounded-lg px-2 py-1.5 text-white text-xs"
            />
          </div>
        </div>

        {/* Rating */}
        <div className="mb-2">
          <label className="text-[10px] text-muted block mb-1">評価 (1〜10)</label>
          <select
            value={editState.rating}
            onChange={e => onChange({ rating: e.target.value })}
            className="w-full bg-surface border border-border rounded-lg px-2 py-1.5 text-white text-xs appearance-none"
          >
            <option value="">未設定</option>
            {[1,2,3,4,5,6,7,8,9,10].map(n => (
              <option key={n} value={n}>{n}</option>
            ))}
          </select>
        </div>

        {/* Memo */}
        <div>
          <label className="text-[10px] text-muted block mb-1">メモ</label>
          <textarea
            value={editState.memo}
            onChange={e => onChange({ memo: e.target.value })}
            rows={2}
            placeholder="ワークアウトのメモ..."
            className="w-full bg-surface border border-border rounded-lg px-2 py-1.5 text-white text-xs resize-none"
          />
        </div>
      </div>

      {/* Exercises */}
      <div className="divide-y divide-border/60">
        {editState.exercises.map((ex, exIdx) => (
          <div key={`${ex.name}-${exIdx}`} className="px-4 py-3">
            {/* Exercise header */}
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-2">
                <span className="text-sm font-semibold text-white">{ex.name}</span>
                <CategoryBadge category={ex.category} />
              </div>
              <button
                onClick={() => onDeleteExercise(exIdx)}
                className="text-xs text-red-400 border border-red-500/30 bg-red-500/10 rounded-lg px-2 py-1"
              >
                × 削除
              </button>
            </div>

            {/* Sets */}
            <div className="space-y-2">
              {ex.sets.map((set, setIdx) => (
                <div key={set.id} className="bg-surface/50 rounded-xl p-2">
                  <div className="flex items-center gap-1 mb-1.5">
                    <span className="text-xs text-muted w-10 shrink-0">S{setIdx + 1}</span>
                    {ex.category === '有酸素' ? (
                      <div className="flex gap-1 flex-1">
                        <input
                          type="number" inputMode="decimal" placeholder="分"
                          value={set.durationMinutes}
                          onChange={e => onUpdateSet(exIdx, setIdx, 'durationMinutes', e.target.value)}
                          className="w-14 bg-bg border border-border rounded-lg px-1.5 py-1 text-white text-xs text-center"
                        />
                        <span className="text-muted text-xs self-center">分</span>
                        <input
                          type="number" inputMode="decimal" placeholder="km"
                          value={set.distanceKm}
                          onChange={e => onUpdateSet(exIdx, setIdx, 'distanceKm', e.target.value)}
                          className="w-14 bg-bg border border-border rounded-lg px-1.5 py-1 text-white text-xs text-center"
                        />
                        <span className="text-muted text-xs self-center">km</span>
                        {ex.name === 'ウォーキング' && (
                          <>
                            <input
                              type="number" inputMode="decimal" placeholder="%"
                              value={set.incline}
                              onChange={e => onUpdateSet(exIdx, setIdx, 'incline', e.target.value)}
                              className="w-12 bg-bg border border-border rounded-lg px-1.5 py-1 text-white text-xs text-center"
                            />
                            <span className="text-muted text-xs self-center">%</span>
                          </>
                        )}
                      </div>
                    ) : (
                      <div className="flex gap-1 flex-1">
                        <input
                          type="number" inputMode="decimal" placeholder="kg"
                          value={set.weight}
                          onChange={e => onUpdateSet(exIdx, setIdx, 'weight', e.target.value)}
                          className="w-16 bg-bg border border-border rounded-lg px-1.5 py-1 text-white text-xs text-center"
                        />
                        <span className="text-muted text-xs self-center">kg×</span>
                        <input
                          type="number" inputMode="numeric" placeholder="回"
                          value={set.reps}
                          onChange={e => onUpdateSet(exIdx, setIdx, 'reps', e.target.value)}
                          className="w-14 bg-bg border border-border rounded-lg px-1.5 py-1 text-white text-xs text-center"
                        />
                        <span className="text-muted text-xs self-center">回</span>
                      </div>
                    )}
                    <button
                      onClick={() => onDeleteSet(exIdx, setIdx)}
                      className="text-red-400 text-sm w-7 h-7 flex items-center justify-center shrink-0"
                    >×</button>
                  </div>
                  {/* Set memo */}
                  <input
                    type="text" placeholder="セットメモ（任意）"
                    value={set.memo}
                    onChange={e => onUpdateSet(exIdx, setIdx, 'memo', e.target.value)}
                    className="w-full bg-bg border border-border rounded-lg px-2 py-1 text-white text-xs"
                  />
                </div>
              ))}
              {ex.sets.length === 0 && (
                <div className="text-xs text-muted text-center py-1">セットがありません</div>
              )}
            </div>
          </div>
        ))}
      </div>

      {/* Save / Cancel */}
      <div className="px-4 py-3 border-t border-border bg-surface/30 flex gap-2">
        <button
          onClick={onSave}
          className="flex-1 bg-accent text-bg font-bold rounded-xl py-3 text-sm active:scale-95 transition-all"
        >
          保存する ✓
        </button>
        <button
          onClick={onCancel}
          className="flex-1 bg-card text-muted border border-border rounded-xl py-3 text-sm"
        >
          キャンセル
        </button>
      </div>
    </div>
  )
}

// ── Main component ────────────────────────────────────────────────────────────

export default function CalendarScreen({ data, onUpdateSession }: Props) {
  const todayStr = todayLocalStr()
  const todayDate = new Date()

  const [year, setYear]   = useState(todayDate.getFullYear())
  const [month, setMonth] = useState(todayDate.getMonth())
  const [selectedDate, setSelectedDate] = useState<string | null>(null)
  const [editingSessionId, setEditingSessionId] = useState<string | null>(null)
  const [editState, setEditState] = useState<EditState | null>(null)

  // date string → sorted sessions
  const sessionsByDate = useMemo(() => {
    const map: Record<string, WorkoutSession[]> = {}
    for (const s of data.sessions) {
      if (!map[s.date]) map[s.date] = []
      map[s.date].push(s)
    }
    for (const d of Object.keys(map)) {
      map[d].sort((a, b) => a.startTime.localeCompare(b.startTime))
    }
    return map
  }, [data.sessions])

  // Calendar geometry
  const firstDayOfWeek = new Date(year, month, 1).getDay()
  const daysInMonth    = new Date(year, month + 1, 0).getDate()
  const cells: (number | null)[] = [
    ...Array<null>(firstDayOfWeek).fill(null),
    ...Array.from({ length: daysInMonth }, (_, i) => i + 1),
  ]
  while (cells.length % 7 !== 0) cells.push(null)

  const selectedSessions = selectedDate ? (sessionsByDate[selectedDate] ?? []) : []

  // ── Edit handlers ──────────────────────────────────────────────────
  const startEditing = (session: WorkoutSession) => {
    setEditingSessionId(session.id)
    setEditState({
      sessionId: session.id,
      date:      session.date,
      startTime: session.startTime ?? '',
      endTime:   session.endTime   ?? '',
      rating:    session.rating != null ? String(session.rating) : '',
      memo:      session.memo    ?? '',
      exercises: session.exercises.map(ex => ({
        category:   ex.category,
        name:       ex.name,
        instanceId: ex.instanceId,
        sets: ex.sets.map(set => ({
          id:              set.id,
          weight:          set.weight          != null ? String(set.weight)          : '',
          reps:            set.reps            != null ? String(set.reps)            : '',
          durationMinutes: set.durationMinutes != null ? String(set.durationMinutes) : '',
          distanceKm:      set.distanceKm      != null ? String(set.distanceKm)      : '',
          incline:         set.incline         != null ? String(set.incline)         : '',
          memo:            set.memo            ?? '',
          timestamp:       set.timestamp,
        })),
      })),
    })
  }

  const cancelEditing = () => {
    setEditingSessionId(null)
    setEditState(null)
  }

  const saveEditing = () => {
    if (!editState) return
    const original = data.sessions.find(s => s.id === editState.sessionId)
    const updated: WorkoutSession = {
      id:        editState.sessionId,
      date:      editState.date,
      startTime: editState.startTime,
      endTime:   editState.endTime   || undefined,
      rating:    editState.rating    ? parseInt(editState.rating)    : undefined,
      memo:      editState.memo      || undefined,
      notes:     original?.notes,   // preserve notes (not editable here)
      exercises: editState.exercises
        .map(ex => ({
          category:   ex.category,
          name:       ex.name,
          instanceId: ex.instanceId,
          sets: ex.sets
            .map(s => ({
              id:              s.id,
              timestamp:       s.timestamp,
              weight:          s.weight          ? parseFloat(s.weight)          : undefined,
              reps:            s.reps            ? parseInt(s.reps)              : undefined,
              durationMinutes: s.durationMinutes ? parseFloat(s.durationMinutes) : undefined,
              distanceKm:      s.distanceKm      ? parseFloat(s.distanceKm)      : undefined,
              incline:         s.incline         ? parseFloat(s.incline)         : undefined,
              memo:            s.memo            || undefined,
            })),
        }))
        .filter(ex => ex.sets.length > 0),
    }
    onUpdateSession(updated)
    setEditingSessionId(null)
    setEditState(null)
    setSelectedDate(null) // close detail since date may have changed
  }

  const patchEditState = (patch: Partial<EditState>) => {
    setEditState(prev => prev ? { ...prev, ...patch } : prev)
  }

  const updateEditSet = (exIdx: number, setIdx: number, field: keyof EditSet, value: string) => {
    setEditState(prev => {
      if (!prev) return prev
      const exercises = prev.exercises.map((ex, i) =>
        i === exIdx
          ? { ...ex, sets: ex.sets.map((s, j) => j === setIdx ? { ...s, [field]: value } : s) }
          : ex
      )
      return { ...prev, exercises }
    })
  }

  const deleteEditSet = (exIdx: number, setIdx: number) => {
    setEditState(prev => {
      if (!prev) return prev
      const exercises = prev.exercises.map((ex, i) =>
        i === exIdx ? { ...ex, sets: ex.sets.filter((_, j) => j !== setIdx) } : ex
      )
      return { ...prev, exercises }
    })
  }

  const deleteEditExercise = (exIdx: number) => {
    setEditState(prev => {
      if (!prev) return prev
      return { ...prev, exercises: prev.exercises.filter((_, i) => i !== exIdx) }
    })
  }

  // ── Calendar navigation ────────────────────────────────────────────
  const goPrev = () => {
    if (month === 0) { setYear(y => y - 1); setMonth(11) }
    else              setMonth(m => m - 1)
    setSelectedDate(null)
    cancelEditing()
  }
  const goNext = () => {
    const now = new Date()
    if (year === now.getFullYear() && month === now.getMonth()) return
    if (month === 11) { setYear(y => y + 1); setMonth(0) }
    else               setMonth(m => m + 1)
    setSelectedDate(null)
    cancelEditing()
  }

  const handleDayClick = (day: number) => {
    const d = localDateStr(year, month, day)
    if (!sessionsByDate[d]) return
    if (editingSessionId) cancelEditing()
    setSelectedDate(prev => (prev === d ? null : d))
  }

  const isNextDisabled = (() => {
    const now = new Date()
    return year === now.getFullYear() && month === now.getMonth()
  })()

  const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土']

  return (
    <div className="flex flex-col h-full overflow-y-auto pb-6">

      {/* ── Month header ── */}
      <div className="flex items-center justify-between px-4 py-3 shrink-0">
        <button
          onClick={goPrev}
          className="w-10 h-10 flex items-center justify-center rounded-xl bg-card border border-border text-white active:bg-surface transition-colors"
        >‹</button>
        <h2 className="text-base font-bold text-white">{year}年{month + 1}月</h2>
        <button
          onClick={goNext}
          disabled={isNextDisabled}
          className="w-10 h-10 flex items-center justify-center rounded-xl bg-card border border-border text-white disabled:opacity-30 active:bg-surface transition-colors"
        >›</button>
      </div>

      {/* ── Weekday headers ── */}
      <div className="grid grid-cols-7 px-4 mb-1 shrink-0">
        {WEEKDAYS.map((d, i) => (
          <div key={d} className={`text-center text-xs font-semibold py-1 ${i === 0 ? 'text-red-400' : i === 6 ? 'text-blue-400' : 'text-muted'}`}>
            {d}
          </div>
        ))}
      </div>

      {/* ── Calendar grid ── */}
      <div className="grid grid-cols-7 px-3 gap-y-1 shrink-0">
        {cells.map((day, i) => {
          if (day === null) return <div key={`pad-${i}`} />
          const dateStr    = localDateStr(year, month, day)
          const isToday    = dateStr === todayStr
          const hasWorkout = Boolean(sessionsByDate[dateStr])
          const isSelected = selectedDate === dateStr
          const dow        = i % 7

          return (
            <button
              key={dateStr}
              onClick={() => handleDayClick(day)}
              className={`
                relative flex flex-col items-center justify-center h-11 rounded-xl transition-all
                ${isSelected ? 'bg-accent/20 border border-accent'
                  : isToday  ? 'bg-surface border border-accent/60'
                  : hasWorkout ? 'bg-card border border-border active:bg-surface'
                  : 'border border-transparent'}
                ${hasWorkout ? 'cursor-pointer' : 'cursor-default'}
              `}
            >
              <span className={`text-sm leading-none ${
                isToday  ? 'text-accent font-bold'
                : dow === 0 ? 'text-red-400'
                : dow === 6 ? 'text-blue-400'
                : hasWorkout ? 'text-white font-medium' : 'text-muted'
              }`}>{day}</span>
              {hasWorkout && <div className="w-1.5 h-1.5 rounded-full bg-accent mt-0.5" />}
            </button>
          )
        })}
      </div>

      {/* ── Legend ── */}
      <div className="flex items-center gap-3 px-4 mt-2 shrink-0">
        <div className="flex items-center gap-1.5">
          <div className="w-1.5 h-1.5 rounded-full bg-accent" />
          <span className="text-xs text-muted">ワークアウト記録あり</span>
        </div>
        <div className="flex items-center gap-1.5">
          <div className="w-3 h-3 rounded-md bg-surface border border-accent/60" />
          <span className="text-xs text-muted">今日</span>
        </div>
      </div>

      {/* ── No data ── */}
      {data.sessions.length === 0 && (
        <div className="flex-1 flex flex-col items-center justify-center text-muted px-8 text-center">
          <div className="text-4xl mb-3">📅</div>
          <div className="text-sm">ワークアウトを記録すると<br />カレンダーに表示されます</div>
        </div>
      )}

      {/* ── Day detail ── */}
      {selectedDate && selectedSessions.length > 0 && (
        <div className="px-4 mt-4 slide-in">
          <div className="flex items-center gap-2 mb-3">
            <div className="w-1 h-5 rounded-full bg-accent" />
            <span className="text-sm font-bold text-white">
              {formatDateJP(selectedDate)}のワークアウト
            </span>
            <span className="text-xs text-muted">({selectedSessions.length}件)</span>
          </div>

          <div className="space-y-3">
            {selectedSessions.map(s =>
              editingSessionId === s.id && editState ? (
                <EditSessionCard
                  key={s.id}
                  editState={editState}
                  onChange={patchEditState}
                  onUpdateSet={updateEditSet}
                  onDeleteSet={deleteEditSet}
                  onDeleteExercise={deleteEditExercise}
                  onSave={saveEditing}
                  onCancel={cancelEditing}
                />
              ) : (
                <SessionCard
                  key={s.id}
                  session={s}
                  onStartEdit={() => startEditing(s)}
                />
              )
            )}
          </div>
        </div>
      )}
    </div>
  )
}
