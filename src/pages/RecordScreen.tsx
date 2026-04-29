import { useState, useEffect, useMemo } from 'react'
import type { Category, WorkoutSession, ExerciseEntry, WorkoutSet, SessionNote } from '../types'
import {
  PRIMARY_CATEGORIES,
  SECONDARY_CATEGORIES,
  CATEGORY_ICONS,
  DEFAULT_EXERCISES,
} from '../data/exercises'
import type { CustomExercise } from '../types'
import {
  loadDraftSync,
  loadDraftAsync,
  saveDraft,
  clearDraft,
  mergeDraft,
  loadUsageSync,
  incrementUsage,
  type UsageMap,
} from '../utils/storage'

interface Props {
  onSaveSession: (session: WorkoutSession) => void
  customExercises: CustomExercise[]
  onAddCustomExercise: (ex: CustomExercise) => void
  sessions: WorkoutSession[]        // ← for previous record lookup
}

const FIVE_HOURS_MS = 5 * 60 * 60 * 1000

// ── Helpers ─────────────────────────────────────────────────────────
function newSession(): WorkoutSession {
  return {
    id: crypto.randomUUID(),
    // Use local date (toISOString gives UTC which can be wrong near midnight in JST)
    date: todayStr(),
    // startTime is set on the first set addition, not session creation
    startTime: '',
    exercises: [],
    notes: [],
  }
}

function getLastSetTimestamp(session: WorkoutSession): string | null {
  let last: string | null = null
  for (const ex of session.exercises) {
    for (const set of ex.sets) {
      if (!last || set.timestamp > last) last = set.timestamp
    }
  }
  return last
}

function getExerciseEntryLabel(exercises: ExerciseEntry[], entry: ExerciseEntry): string {
  const sameNameEntries = exercises.filter(e => e.name === entry.name)
  const idx = sameNameEntries.findIndex(e => e.instanceId === entry.instanceId)
  if (idx <= 0) return entry.name
  return `${entry.name}（${idx + 1}回目）`
}

function todayStr(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function nowTimeStr(): string {
  return new Date().toTimeString().slice(0, 5)
}

function sortByUsage(names: string[], category: string, usage: UsageMap): string[] {
  return [...names].sort((a, b) => {
    const ca = usage[`${category}/${a}`] ?? 0
    const cb = usage[`${category}/${b}`] ?? 0
    return cb - ca
  })
}

/** Find the most recent completed session (not the current draft) that logged this exercise. */
function getPreviousRecord(
  sessions: WorkoutSession[],
  currentSessionId: string,
  category: string,
  name: string,
): { maxWeight: number; maxReps: number; sets: number; isCardio: boolean; maxDuration: number } | null {
  const isCardio = category === '有酸素'
  // Sort descending by date
  const sorted = [...sessions]
    .filter(s => s.id !== currentSessionId)
    .sort((a, b) => b.date.localeCompare(a.date) || (b.startTime ?? '').localeCompare(a.startTime ?? ''))

  for (const s of sorted) {
    const entries = s.exercises.filter(e => e.category === category && e.name === name)
    if (entries.length === 0) continue
    const allSets = entries.flatMap(e => e.sets)
    if (allSets.length === 0) continue
    if (isCardio) {
      return {
        isCardio: true,
        maxDuration: Math.max(...allSets.map(s => s.durationMinutes ?? 0)),
        sets: allSets.length,
        maxWeight: 0,
        maxReps: 0,
      }
    }
    return {
      isCardio: false,
      maxWeight: Math.max(...allSets.map(s => s.weight ?? 0)),
      maxReps: Math.max(...allSets.map(s => s.reps ?? 0)),
      sets: allSets.length,
      maxDuration: 0,
    }
  }
  return null
}

// ── Component ────────────────────────────────────────────────────────
export default function RecordScreen({
  onSaveSession,
  customExercises,
  onAddCustomExercise,
  sessions,
}: Props) {
  const [session, setSession] = useState<WorkoutSession>(() => loadDraftSync() ?? newSession())
  const [usage, setUsage] = useState<UsageMap>(() => loadUsageSync())

  const [selectedCategory, setSelectedCategory] = useState<Category>('胸')
  const [selectedExercise, setSelectedExercise] = useState<string>(() => DEFAULT_EXERCISES['胸'][0])
  const [currentInstanceId, setCurrentInstanceId] = useState(() => crypto.randomUUID())
  const [isMemoMode, setIsMemoMode] = useState(false)
  const [showSecondary, setShowSecondary] = useState(false)

  const [weightInput, setWeightInput] = useState('')
  const [repsInput, setRepsInput] = useState('')
  const [durationInput, setDurationInput] = useState('')
  const [distanceInput, setDistanceInput] = useState('')
  const [setMemoInput, setSetMemoInput] = useState('')

  const [showDatePicker, setShowDatePicker] = useState(false)
  const [customDate, setCustomDate] = useState(todayStr())
  const [customTime, setCustomTime] = useState(nowTimeStr())
  const [useCustomDateTime, setUseCustomDateTime] = useState(false)

  const [noteScore, setNoteScore] = useState(5)
  const [noteText, setNoteText] = useState('')

  const [editingSetId, setEditingSetId] = useState<string | null>(null)
  const [showFinishModal, setShowFinishModal] = useState(false)
  const [rating, setRating] = useState(7)
  const [finishMemo, setFinishMemo] = useState('')
  const [showCustomModal, setShowCustomModal] = useState(false)
  const [customName, setCustomName] = useState('')
  const [showSuccess, setShowSuccess] = useState(false)
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null)
  const [toast, setToast] = useState('')

  const isCardio = selectedCategory === '有酸素'

  // ── Sorted exercise list ──────────────────────────────────────────
  const allExercisesSorted = useMemo(() => {
    const base = [
      ...DEFAULT_EXERCISES[selectedCategory],
      ...customExercises.filter(c => c.category === selectedCategory).map(c => c.name),
    ]
    return sortByUsage(base, selectedCategory, usage)
  }, [selectedCategory, customExercises, usage])

  const allExercisesForCat = (cat: Category) => [
    ...DEFAULT_EXERCISES[cat],
    ...customExercises.filter(c => c.category === cat).map(c => c.name),
  ]

  // ── Previous record ───────────────────────────────────────────────
  const previousRecord = useMemo(
    () => getPreviousRecord(sessions, session.id, selectedCategory, selectedExercise),
    [sessions, session.id, selectedCategory, selectedExercise],
  )

  // ── IDB hydration ────────────────────────────────────────────────
  useEffect(() => {
    loadDraftAsync().then(idbDraft => {
      if (!idbDraft) return
      setSession(prev => {
        const merged = mergeDraft(prev, idbDraft)
        if (!merged || merged === prev) return prev
        return merged
      })
    })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ── Persistence ───────────────────────────────────────────────────
  const updateSession = (next: WorkoutSession) => {
    saveDraft(next)
    setSession(next)
  }

  useEffect(() => {
    saveDraft(session)
  }, [session])

  // ── Utilities ─────────────────────────────────────────────────────
  const showToast = (msg: string) => {
    setToast(msg)
    setTimeout(() => setToast(''), 4000)
  }

  const clearSetInputs = () => {
    setWeightInput('')
    setRepsInput('')
    setDurationInput('')
    setDistanceInput('')
    setSetMemoInput('')
    setEditingSetId(null)
  }

  function resolveTimestamp(): string {
    if (useCustomDateTime && customDate && customTime) {
      return new Date(`${customDate}T${customTime}:00`).toISOString()
    }
    return new Date().toISOString()
  }

  function buildNewSet(existingId?: string): WorkoutSet {
    return {
      id: existingId ?? crypto.randomUUID(),
      timestamp: existingId ? new Date().toISOString() : resolveTimestamp(),
      ...(isCardio
        ? {
            durationMinutes: parseFloat(durationInput),
            distanceKm: distanceInput ? parseFloat(distanceInput) : undefined,
          }
        : {
            weight: parseFloat(weightInput),
            reps: parseInt(repsInput, 10),
          }),
      memo: setMemoInput.trim() || undefined,
    }
  }

  // ── Navigation ────────────────────────────────────────────────────
  const handleCategoryClick = (cat: Category) => {
    setSelectedCategory(cat)
    setIsMemoMode(false)
    setSelectedExercise(allExercisesForCat(cat)[0] ?? '')
    setCurrentInstanceId(crypto.randomUUID())
    clearSetInputs()
  }

  const handleExerciseChange = (name: string) => {
    setSelectedExercise(name)
    setCurrentInstanceId(crypto.randomUUID())
    clearSetInputs()
  }

  // ── Entry / set lookups ───────────────────────────────────────────
  const currentExerciseEntry = (): ExerciseEntry | undefined =>
    session.exercises.find(
      e => e.category === selectedCategory && e.name === selectedExercise && e.instanceId === currentInstanceId,
    )

  const currentSets = currentExerciseEntry()?.sets ?? []

  const currentExerciseLabel = useMemo(() => {
    const sameNameEntries = session.exercises.filter(e => e.name === selectedExercise)
    const existingIdx = sameNameEntries.findIndex(e => e.instanceId === currentInstanceId)
    const ordinal = existingIdx >= 0 ? existingIdx + 1 : sameNameEntries.length + 1
    return ordinal > 1 ? `${selectedExercise}（${ordinal}回目）` : selectedExercise
  }, [session.exercises, selectedExercise, currentInstanceId])

  const totalSets = session.exercises.reduce((acc, e) => acc + e.sets.length, 0)

  // ── Set CRUD ──────────────────────────────────────────────────────
  const startEditSet = (set: WorkoutSet) => {
    setEditingSetId(set.id)
    setSetMemoInput(set.memo ?? '')
    if (isCardio) {
      setDurationInput(String(set.durationMinutes ?? ''))
      setDistanceInput(String(set.distanceKm ?? ''))
    } else {
      setWeightInput(String(set.weight ?? ''))
      setRepsInput(String(set.reps ?? ''))
    }
  }

  const deleteSet = (setId: string) => {
    const updatedExercises = session.exercises
      .map(e => {
        if (e.category === selectedCategory && e.name === selectedExercise && e.instanceId === currentInstanceId) {
          return { ...e, sets: e.sets.filter(s => s.id !== setId) }
        }
        return e
      })
      .filter(e => e.sets.length > 0)
    updateSession({ ...session, exercises: updatedExercises })
    setDeleteConfirmId(null)
    if (editingSetId === setId) clearSetInputs()
  }

  const addOrUpdateSet = () => {
    if (isCardio ? !durationInput : !weightInput || !repsInput) return

    // ── 5-hour auto-split ────────────────────────────────────────
    if (!editingSetId) {
      const lastTs = getLastSetTimestamp(session)
      if (lastTs && Date.now() - new Date(lastTs).getTime() >= FIVE_HOURS_MS) {
        onSaveSession({ ...session, endTime: new Date().toTimeString().slice(0, 5) })
        clearDraft()

        const splitSet = buildNewSet()
        const newInstanceId = crypto.randomUUID()
        setCurrentInstanceId(newInstanceId)

        // startTime = the actual time of the triggering set (= now, since it's post-split)
        const splitNow = new Date()
        const freshSession: WorkoutSession = {
          ...newSession(),
          date: `${splitNow.getFullYear()}-${String(splitNow.getMonth() + 1).padStart(2, '0')}-${String(splitNow.getDate()).padStart(2, '0')}`,
          startTime: splitNow.toTimeString().slice(0, 5),
          exercises: [{
            category: selectedCategory,
            name: selectedExercise,
            instanceId: newInstanceId,
            sets: [splitSet],
          }],
        }
        updateSession(freshSession)
        clearSetInputs()
        showToast('前回のトレーニングから5時間以上経過したため、新しいセッションを開始しました')
        return
      }
    }

    // ── Normal add / update ──────────────────────────────────────
    const newSet = buildNewSet(editingSetId ?? undefined)
    const ex = currentExerciseEntry()
    let updatedExercises: ExerciseEntry[]

    if (ex) {
      updatedExercises = session.exercises.map(e => {
        if (e.category === selectedCategory && e.name === selectedExercise && e.instanceId === currentInstanceId) {
          const sets = editingSetId
            ? e.sets.map(s => (s.id === editingSetId ? newSet : s))
            : [...e.sets, newSet]
          return { ...e, sets }
        }
        return e
      })
    } else {
      updatedExercises = [
        ...session.exercises,
        { category: selectedCategory, name: selectedExercise, instanceId: currentInstanceId, sets: [newSet] },
      ]
    }

    // ── Update startTime / date on the very first set ────────────────
    // "セッションの開始時刻はその日の最初のセット追加時刻とする"
    const isFirstSet = !editingSetId && totalSets === 0
    const resolvedTs  = resolveTimestamp()
    const resolvedDate = new Date(resolvedTs)

    const sessionPatch: Partial<WorkoutSession> = {}
    if (isFirstSet) {
      sessionPatch.startTime = resolvedDate.toTimeString().slice(0, 5)
      // If using a custom date, the session's date should reflect that too
      if (useCustomDateTime && customDate) {
        sessionPatch.date = customDate
      }
    }

    updateSession({ ...session, exercises: updatedExercises, ...sessionPatch })

    // Usage count: +1 per SESSION (not per set).
    // Only increment if this exercise has no existing entry in the current session yet.
    if (!editingSetId) {
      const alreadyUsedInSession = session.exercises.some(
        e => e.category === selectedCategory && e.name === selectedExercise,
      )
      if (!alreadyUsedInSession) {
        const updated = incrementUsage(selectedCategory, selectedExercise)
        setUsage(updated)
      }
    }

    clearSetInputs()
  }

  // ── Notes ─────────────────────────────────────────────────────────
  const addNote = () => {
    if (!noteText.trim()) return
    const note: SessionNote = {
      score: noteScore,
      text: noteText.trim(),
      timestamp: new Date().toISOString(),
    }
    updateSession({ ...session, notes: [...(session.notes ?? []), note] })
    setNoteText('')
    setNoteScore(5)
  }

  // ── Finish ────────────────────────────────────────────────────────
  const finishWorkout = () => {
    if (totalSets === 0) return
    onSaveSession({ ...session, endTime: new Date().toTimeString().slice(0, 5), rating, memo: finishMemo })
    clearDraft()
    setShowFinishModal(false)
    setShowSuccess(true)
    setTimeout(() => {
      setShowSuccess(false)
      const fresh = newSession()
      updateSession(fresh)
      setFinishMemo('')
      setRating(7)
      setUseCustomDateTime(false)
    }, 2500)
  }

  // ── Category grid ─────────────────────────────────────────────────
  const isCatActive = (cat: Category) => selectedCategory === cat && !isMemoMode

  const renderCatBtn = (cat: Category) => (
    <button
      key={cat}
      onClick={() => handleCategoryClick(cat)}
      className={`flex flex-col items-center justify-center py-2 px-1 rounded-xl text-[11px] font-medium transition-all ${
        isCatActive(cat)
          ? 'bg-accent text-bg font-bold shadow-lg shadow-accent/30'
          : 'bg-card text-muted border border-border'
      }`}
    >
      <span className="text-base mb-0.5">{CATEGORY_ICONS[cat]}</span>
      <span>{cat}</span>
    </button>
  )

  // ── Render ───────────────────────────────────────────────────────
  return (
    <div className="flex flex-col h-full">

      {/* Success overlay */}
      {showSuccess && (
        <div className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-bg/95 slide-in">
          <div className="text-6xl mb-4">🎉</div>
          <div className="text-2xl font-bold text-accent mb-2">ワークアウト完了！</div>
          <div className="text-muted text-center px-8">
            お疲れ様でした！<br />{totalSets}セットを記録しました。
          </div>
        </div>
      )}

      {/* Past-datetime warning */}
      {useCustomDateTime && (
        <div className="mx-4 mt-2 px-3 py-1.5 rounded-xl bg-yellow-500/10 border border-yellow-500/30 flex items-center gap-2 text-xs text-yellow-400">
          <span>⚠️</span>
          <span>過去の日時で記録中 — {customDate} {customTime}</span>
          <button onClick={() => setUseCustomDateTime(false)} className="ml-auto">✕</button>
        </div>
      )}

      <div className="flex-1 overflow-y-auto pb-2">

        {/* ── Category selector ── */}
        <div className="px-4 pt-3">
          <div className="grid grid-cols-3 gap-1.5">
            {PRIMARY_CATEGORIES.map(renderCatBtn)}
          </div>

          <button
            onClick={() => setShowSecondary(v => !v)}
            className="mt-1.5 w-full flex items-center justify-center gap-1 text-xs text-muted py-1.5 rounded-xl border border-border bg-card/50 active:bg-card transition-all"
          >
            {showSecondary ? '▲ 閉じる' : '▼ もっと見る（腹筋・お尻・メモ）'}
          </button>

          {showSecondary && (
            <div className="grid grid-cols-3 gap-1.5 mt-1.5 slide-in">
              {SECONDARY_CATEGORIES.map(renderCatBtn)}
              <button
                onClick={() => setIsMemoMode(true)}
                className={`flex flex-col items-center justify-center py-2 px-1 rounded-xl text-[11px] font-medium transition-all ${
                  isMemoMode
                    ? 'bg-accentGreen text-bg font-bold shadow-lg shadow-accentGreen/30'
                    : 'bg-card text-muted border border-border'
                }`}
              >
                <span className="text-base mb-0.5">📝</span>
                <span>メモ</span>
              </button>
            </div>
          )}
        </div>

        {/* ── MEMO MODE ── */}
        {isMemoMode ? (
          <div className="px-4 mt-3">
            <div className="bg-card border border-border rounded-2xl p-4">
              <div className="text-xs text-muted mb-3 font-medium uppercase tracking-wider">セッションメモを追加</div>
              <div className="mb-3">
                <label className="text-xs text-muted block mb-1">スコア</label>
                <select
                  value={noteScore}
                  onChange={e => setNoteScore(Number(e.target.value))}
                  className="w-full bg-surface border border-border rounded-xl px-3 py-2.5 text-white text-sm appearance-none"
                >
                  {[1,2,3,4,5,6,7,8,9,10].map(n => (
                    <option key={n} value={n}>{n}</option>
                  ))}
                </select>
              </div>
              <div className="mb-3">
                <label className="text-xs text-muted block mb-1">メモ</label>
                <textarea
                  value={noteText}
                  onChange={e => setNoteText(e.target.value)}
                  placeholder="気づいたことや体調など..."
                  rows={3}
                  className="w-full bg-surface border border-border rounded-xl px-3 py-2.5 text-white text-sm resize-none"
                />
              </div>
              <button
                onClick={addNote}
                disabled={!noteText.trim()}
                className="w-full bg-accentGreen disabled:opacity-40 text-bg font-bold rounded-xl py-3 text-sm active:scale-95 transition-all"
              >
                ＋ メモを追加
              </button>
            </div>

            {(session.notes?.length ?? 0) > 0 && (
              <div className="mt-3">
                <div className="text-xs text-muted mb-2 font-medium uppercase tracking-wider">
                  今日のメモ ({session.notes!.length})
                </div>
                <div className="bg-card border border-border rounded-2xl divide-y divide-border">
                  {session.notes!.map((note, i) => (
                    <div key={i} className="px-4 py-3">
                      <div className="flex items-center gap-2 mb-1">
                        <span className="text-accentGreen font-bold text-sm">スコア {note.score}</span>
                        <span className="text-xs text-muted">
                          {new Date(note.timestamp).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })}
                        </span>
                      </div>
                      <div className="text-sm text-white">{note.text}</div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>

        ) : (
          /* ── EXERCISE MODE ── */
          <>
            {/* Exercise selector */}
            <div className="px-4 mt-3 flex gap-2">
              <select
                value={selectedExercise}
                onChange={e => handleExerciseChange(e.target.value)}
                className="flex-1 bg-card border border-border rounded-xl px-3 py-2.5 text-sm text-white appearance-none"
              >
                {allExercisesSorted.map(ex => {
                  const count = usage[`${selectedCategory}/${ex}`] ?? 0
                  return (
                    <option key={ex} value={ex}>
                      {count > 0 ? `${ex} (${count})` : ex}
                    </option>
                  )
                })}
              </select>
              <button
                onClick={() => setShowCustomModal(true)}
                className="bg-card border border-border rounded-xl px-3 py-2.5 text-accent text-sm font-medium whitespace-nowrap"
              >
                ＋ カスタム
              </button>
            </div>

            {/* Previous record */}
            {previousRecord && (
              <div className="px-4 mt-1">
                <p className="text-xs text-muted">
                  前回:{' '}
                  {previousRecord.isCardio
                    ? `${previousRecord.maxDuration}分 × ${previousRecord.sets}セット`
                    : `${previousRecord.maxWeight}kg × ${previousRecord.maxReps}回 × ${previousRecord.sets}セット`}
                </p>
              </div>
            )}

            {/* Set input card */}
            <div className="px-4 mt-2">
              <div className="bg-card border border-border rounded-2xl p-3">
                {/* Header + datetime toggle */}
                <div className="flex items-center justify-between mb-2">
                  <div className="text-xs text-muted font-medium">
                    {editingSetId ? 'セットを編集' : `新しいセット — ${currentExerciseLabel}`}
                  </div>
                  <button
                    onClick={() => {
                      if (!showDatePicker) { setCustomDate(todayStr()); setCustomTime(nowTimeStr()) }
                      setShowDatePicker(v => !v)
                    }}
                    className={`text-xs px-2 py-1 rounded-lg border transition-all ${
                      useCustomDateTime
                        ? 'text-yellow-400 border-yellow-500/40 bg-yellow-500/10'
                        : 'text-muted border-border bg-surface/50'
                    }`}
                  >
                    🕐 日時を変更
                  </button>
                </div>

                {/* Datetime picker */}
                {showDatePicker && (
                  <div className="mb-2 p-2.5 bg-surface rounded-xl border border-border slide-in">
                    <div className="flex gap-2 mb-2">
                      <div className="flex-1">
                        <label className="text-xs text-muted block mb-1">日付</label>
                        <input
                          type="date" value={customDate} max={todayStr()}
                          onChange={e => { setCustomDate(e.target.value); setUseCustomDateTime(true) }}
                          className="w-full bg-bg border border-border rounded-lg px-2 py-1.5 text-white text-xs"
                        />
                      </div>
                      <div className="flex-1">
                        <label className="text-xs text-muted block mb-1">時刻</label>
                        <input
                          type="time" value={customTime}
                          onChange={e => { setCustomTime(e.target.value); setUseCustomDateTime(true) }}
                          className="w-full bg-bg border border-border rounded-lg px-2 py-1.5 text-white text-xs"
                        />
                      </div>
                    </div>
                    <div className="flex gap-2">
                      <button
                        onClick={() => { setUseCustomDateTime(true); setShowDatePicker(false) }}
                        className="flex-1 bg-accent text-bg text-xs font-bold rounded-lg py-1.5"
                      >
                        この日時で記録
                      </button>
                      <button
                        onClick={() => { setUseCustomDateTime(false); setShowDatePicker(false) }}
                        className="flex-1 bg-card text-muted text-xs border border-border rounded-lg py-1.5"
                      >
                        現在時刻を使う
                      </button>
                    </div>
                  </div>
                )}

                {isCardio ? (
                  <div className="flex gap-2 mb-2">
                    <div className="flex-1">
                      <label className="text-xs text-muted block mb-1">時間 (分)</label>
                      <input
                        type="number" inputMode="decimal" placeholder="30"
                        value={durationInput} onChange={e => setDurationInput(e.target.value)}
                        className="w-full bg-surface border border-border rounded-xl px-3 py-2.5 text-white text-center text-lg font-bold"
                      />
                    </div>
                    <div className="flex-1">
                      <label className="text-xs text-muted block mb-1">距離 (km) 任意</label>
                      <input
                        type="number" inputMode="decimal" placeholder="5.0"
                        value={distanceInput} onChange={e => setDistanceInput(e.target.value)}
                        className="w-full bg-surface border border-border rounded-xl px-3 py-2.5 text-white text-center text-lg font-bold"
                      />
                    </div>
                  </div>
                ) : (
                  <div className="flex gap-2 mb-2">
                    <div className="flex-1">
                      <label className="text-xs text-muted block mb-1">重量 (kg)</label>
                      <input
                        type="number" inputMode="decimal" placeholder="60"
                        value={weightInput} onChange={e => setWeightInput(e.target.value)}
                        className="w-full bg-surface border border-border rounded-xl px-3 py-2.5 text-white text-center text-lg font-bold"
                      />
                    </div>
                    <div className="flex items-end pb-2.5 text-muted font-bold">×</div>
                    <div className="flex-1">
                      <label className="text-xs text-muted block mb-1">回数 (reps)</label>
                      <input
                        type="number" inputMode="numeric" placeholder="10"
                        value={repsInput} onChange={e => setRepsInput(e.target.value)}
                        className="w-full bg-surface border border-border rounded-xl px-3 py-2.5 text-white text-center text-lg font-bold"
                      />
                    </div>
                  </div>
                )}

                <input
                  type="text" placeholder="メモ（任意）"
                  value={setMemoInput} onChange={e => setSetMemoInput(e.target.value)}
                  className="w-full bg-surface border border-border rounded-xl px-3 py-2 text-white text-sm mb-2"
                />

                <button
                  onClick={addOrUpdateSet}
                  disabled={isCardio ? !durationInput : !weightInput || !repsInput}
                  className="w-full bg-accent disabled:opacity-40 text-bg font-bold rounded-xl py-3 text-sm transition-all active:scale-95"
                >
                  {editingSetId ? '✓ セットを更新' : '＋ セットを追加'}
                </button>
                {editingSetId && (
                  <button onClick={clearSetInputs} className="mt-1.5 w-full text-muted text-sm py-1.5">
                    キャンセル
                  </button>
                )}
              </div>
            </div>

            {/* Sets list */}
            {currentSets.length > 0 && (
              <div className="px-4 mt-3">
                <div className="text-xs text-muted mb-1.5 font-medium uppercase tracking-wider">
                  {currentExerciseLabel} — {currentSets.length}セット
                </div>
                <div className="space-y-1.5">
                  {currentSets.map((set, idx) => (
                    <div key={set.id}>
                      <button
                        onClick={() => {
                          if (deleteConfirmId === set.id) { setDeleteConfirmId(null); return }
                          if (editingSetId === set.id) { clearSetInputs(); return }
                          startEditSet(set)
                        }}
                        className={`w-full flex items-center justify-between px-4 py-2.5 rounded-xl border transition-all ${
                          editingSetId === set.id ? 'bg-accent/10 border-accent' : 'bg-card border-border'
                        }`}
                      >
                        <span className="text-muted text-sm shrink-0">セット {idx + 1}</span>
                        <div className="flex-1 text-right mr-2">
                          <span className="font-bold text-white">
                            {isCardio
                              ? `${set.durationMinutes}分${set.distanceKm ? ` · ${set.distanceKm}km` : ''}`
                              : `${set.weight}kg × ${set.reps}回`}
                          </span>
                          {set.memo && <div className="text-xs text-muted mt-0.5 truncate">{set.memo}</div>}
                        </div>
                        <button
                          onClick={e => { e.stopPropagation(); setDeleteConfirmId(set.id) }}
                          className="text-muted text-lg w-8 h-8 flex items-center justify-center shrink-0"
                        >
                          ×
                        </button>
                      </button>
                      {deleteConfirmId === set.id && (
                        <div className="flex gap-2 mt-1 slide-in">
                          <button
                            onClick={() => deleteSet(set.id)}
                            className="flex-1 bg-red-500/20 text-red-400 border border-red-500/30 rounded-xl py-2 text-sm font-medium"
                          >
                            削除する
                          </button>
                          <button
                            onClick={() => setDeleteConfirmId(null)}
                            className="flex-1 bg-card text-muted border border-border rounded-xl py-2 text-sm"
                          >
                            キャンセル
                          </button>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </>
        )}

        {/* Today's summary */}
        {(session.exercises.length > 0 || (session.notes?.length ?? 0) > 0) && (
          <div className="px-4 mt-3">
            <div className="text-xs text-muted mb-1.5 font-medium uppercase tracking-wider">
              今日の記録 — {totalSets}セット
            </div>
            <div className="bg-card border border-border rounded-2xl divide-y divide-border">
              {session.exercises.map((ex, i) => (
                <button
                  key={i}
                  onClick={() => {
                    setIsMemoMode(false)
                    setSelectedCategory(ex.category)
                    setSelectedExercise(ex.name)
                    setCurrentInstanceId(
                      (ex.instanceId ?? crypto.randomUUID()) as ReturnType<typeof crypto.randomUUID>,
                    )
                    clearSetInputs()
                    if (SECONDARY_CATEGORIES.includes(ex.category)) setShowSecondary(true)
                  }}
                  className="w-full flex items-center justify-between px-4 py-3 text-left"
                >
                  <div>
                    <div className="text-sm font-medium text-white">
                      {getExerciseEntryLabel(session.exercises, ex)}
                    </div>
                    <div className="text-xs text-muted">{ex.category}</div>
                  </div>
                  <div className="text-accent font-bold text-sm">{ex.sets.length}セット</div>
                </button>
              ))}
              {(session.notes?.length ?? 0) > 0 && (
                <div className="flex items-center justify-between px-4 py-3">
                  <div className="text-sm font-medium text-white">📝 メモ</div>
                  <div className="text-accentGreen font-bold text-sm">{session.notes!.length}件</div>
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Finish button */}
      <div className="px-4 py-3 border-t border-border bg-bg">
        <button
          onClick={() => { if (totalSets > 0) setShowFinishModal(true) }}
          disabled={totalSets === 0}
          className="w-full bg-accentGreen/90 disabled:opacity-30 text-bg font-bold rounded-2xl py-4 text-base transition-all active:scale-95 shadow-lg shadow-accentGreen/20"
        >
          ワークアウトを終了する 💪
        </button>
      </div>

      {/* Finish modal */}
      {showFinishModal && (
        <div className="fixed inset-0 z-40 flex items-end">
          <div className="absolute inset-0 bg-black/60" onClick={() => setShowFinishModal(false)} />
          <div className="relative w-full bg-surface rounded-t-3xl px-4 pt-6 pb-8 slide-in">
            <div className="w-10 h-1 bg-border rounded-full mx-auto mb-6" />
            <div className="text-lg font-bold text-white mb-6 text-center">ワークアウトを保存</div>
            <div className="mb-6">
              <div className="text-sm text-muted mb-3 text-center">今日の評価</div>
              <div className="grid grid-cols-5 gap-2">
                {[1,2,3,4,5,6,7,8,9,10].map(n => (
                  <button
                    key={n} onClick={() => setRating(n)}
                    className={`py-3 rounded-xl font-bold text-sm transition-all ${
                      rating === n ? 'bg-accent text-bg shadow-lg shadow-accent/30' : 'bg-card text-muted border border-border'
                    }`}
                  >
                    {n}
                  </button>
                ))}
              </div>
            </div>
            <div className="mb-6">
              <div className="text-sm text-muted mb-2">メモ (任意)</div>
              <textarea
                value={finishMemo} onChange={e => setFinishMemo(e.target.value)}
                placeholder="今日のワークアウトについて..." rows={3}
                className="w-full bg-card border border-border rounded-xl px-3 py-3 text-white text-sm resize-none"
              />
            </div>
            <button
              onClick={finishWorkout}
              className="w-full bg-accent text-bg font-bold rounded-2xl py-4 text-base active:scale-95 transition-all"
            >
              保存する ✓
            </button>
          </div>
        </div>
      )}

      {/* Custom exercise modal */}
      {showCustomModal && (
        <div className="fixed inset-0 z-40 flex items-end">
          <div className="absolute inset-0 bg-black/60" onClick={() => setShowCustomModal(false)} />
          <div className="relative w-full bg-surface rounded-t-3xl px-4 pt-6 pb-8 slide-in">
            <div className="w-10 h-1 bg-border rounded-full mx-auto mb-6" />
            <div className="text-lg font-bold text-white mb-4">カスタム種目を追加</div>
            <div className="text-sm text-muted mb-2">カテゴリ: {selectedCategory}</div>
            <input
              type="text" placeholder="種目名" value={customName}
              onChange={e => setCustomName(e.target.value)}
              className="w-full bg-card border border-border rounded-xl px-3 py-3 text-white text-sm mb-4"
            />
            <button
              onClick={() => {
                if (!customName.trim()) return
                const name = customName.trim()
                onAddCustomExercise({ category: selectedCategory, name })
                handleExerciseChange(name)
                setCustomName('')
                setShowCustomModal(false)
              }}
              className="w-full bg-accent text-bg font-bold rounded-2xl py-4 text-base"
            >
              追加する
            </button>
          </div>
        </div>
      )}

      {/* Toast */}
      {toast && (
        <div className="fixed bottom-24 left-4 right-4 z-50 slide-in">
          <div className="bg-surface border border-accent/40 text-white px-4 py-3 rounded-2xl text-sm shadow-xl text-center">
            {toast}
          </div>
        </div>
      )}
    </div>
  )
}
