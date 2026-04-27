import { useState, useEffect, useRef, useMemo } from 'react'
import type { Category, WorkoutSession, ExerciseEntry, WorkoutSet, SessionNote } from '../types'
import { CATEGORIES, CATEGORY_ICONS, DEFAULT_EXERCISES } from '../data/exercises'
import type { CustomExercise } from '../types'

interface Props {
  onSaveSession: (session: WorkoutSession) => void
  customExercises: CustomExercise[]
  onAddCustomExercise: (ex: CustomExercise) => void
}

const DRAFT_KEY = 'workout_draft'
const FIVE_HOURS_MS = 5 * 60 * 60 * 1000

function loadDraft(): WorkoutSession | null {
  try {
    const raw = localStorage.getItem(DRAFT_KEY)
    if (raw) return JSON.parse(raw)
  } catch { /* empty */ }
  return null
}

function saveDraft(session: WorkoutSession) {
  localStorage.setItem(DRAFT_KEY, JSON.stringify(session))
}

function clearDraft() {
  localStorage.removeItem(DRAFT_KEY)
}

function newSession(): WorkoutSession {
  const now = new Date()
  return {
    id: crypto.randomUUID(),
    date: now.toISOString().split('T')[0],
    startTime: now.toTimeString().slice(0, 5),
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

export default function RecordScreen({ onSaveSession, customExercises, onAddCustomExercise }: Props) {
  const [session, setSession] = useState<WorkoutSession>(() => loadDraft() ?? newSession())
  const [selectedCategory, setSelectedCategory] = useState<Category>('胸')
  const [selectedExercise, setSelectedExercise] = useState<string>(() => DEFAULT_EXERCISES['胸'][0])
  const [currentInstanceId, setCurrentInstanceId] = useState(() => crypto.randomUUID())
  const [isMemoMode, setIsMemoMode] = useState(false)

  // Set inputs
  const [weightInput, setWeightInput] = useState('')
  const [repsInput, setRepsInput] = useState('')
  const [durationInput, setDurationInput] = useState('')
  const [distanceInput, setDistanceInput] = useState('')
  const [setMemoInput, setSetMemoInput] = useState('')

  // Session note inputs
  const [noteScore, setNoteScore] = useState(5)
  const [noteText, setNoteText] = useState('')

  // UI state
  const [editingSetId, setEditingSetId] = useState<string | null>(null)
  const [showFinishModal, setShowFinishModal] = useState(false)
  const [rating, setRating] = useState(7)
  const [finishMemo, setFinishMemo] = useState('')
  const [showCustomModal, setShowCustomModal] = useState(false)
  const [customName, setCustomName] = useState('')
  const [showSuccess, setShowSuccess] = useState(false)
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null)
  const [toast, setToast] = useState('')

  const setsEndRef = useRef<HTMLDivElement>(null)
  const isCardio = selectedCategory === '有酸素'

  const allExercises = (cat: Category) => [
    ...DEFAULT_EXERCISES[cat],
    ...customExercises.filter(c => c.category === cat).map(c => c.name),
  ]

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

  // New instance + exercise reset when category changes
  useEffect(() => {
    if (isMemoMode) return
    const exercises = allExercises(selectedCategory)
    setSelectedExercise(exercises[0] ?? '')
    setCurrentInstanceId(crypto.randomUUID())
    clearSetInputs()
  }, [selectedCategory]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    saveDraft(session)
  }, [session])

  const handleCategoryClick = (cat: Category) => {
    setSelectedCategory(cat)
    setIsMemoMode(false)
  }

  const handleExerciseChange = (name: string) => {
    setSelectedExercise(name)
    setCurrentInstanceId(crypto.randomUUID())
    clearSetInputs()
  }

  const updateSession = (updated: WorkoutSession) => {
    setSession(updated)
  }

  const currentExercise = (): ExerciseEntry | undefined =>
    session.exercises.find(
      e => e.category === selectedCategory && e.name === selectedExercise && e.instanceId === currentInstanceId
    )

  const currentSets = currentExercise()?.sets ?? []

  // Label for the current instance (shows "（N回目）" if this is not the first occurrence)
  const currentExerciseLabel = useMemo(() => {
    const sameNameEntries = session.exercises.filter(e => e.name === selectedExercise)
    const existingIdx = sameNameEntries.findIndex(e => e.instanceId === currentInstanceId)
    const ordinal = existingIdx >= 0 ? existingIdx + 1 : sameNameEntries.length + 1
    return ordinal > 1 ? `${selectedExercise}（${ordinal}回目）` : selectedExercise
  }, [session.exercises, selectedExercise, currentInstanceId])

  const totalSets = session.exercises.reduce((acc, e) => acc + e.sets.length, 0)

  const addOrUpdateSet = () => {
    if (isCardio ? !durationInput : !weightInput || !repsInput) return

    // Auto-split: check 5h gap (only for new sets, not edits)
    if (!editingSetId) {
      const lastTs = getLastSetTimestamp(session)
      if (lastTs && Date.now() - new Date(lastTs).getTime() >= FIVE_HOURS_MS) {
        // Auto-save current session
        const now = new Date()
        onSaveSession({ ...session, endTime: now.toTimeString().slice(0, 5) })
        clearDraft()

        // Build the set that triggered the split
        const splitSet: WorkoutSet = buildNewSet()
        const newInstanceId = crypto.randomUUID()
        setCurrentInstanceId(newInstanceId)

        const freshSession = newSession()
        const nextSession: WorkoutSession = {
          ...freshSession,
          exercises: [{
            category: selectedCategory,
            name: selectedExercise,
            instanceId: newInstanceId,
            sets: [splitSet],
          }],
        }
        updateSession(nextSession)
        clearSetInputs()
        showToast('前回のトレーニングから5時間以上経過したため、新しいセッションを開始しました')
        setTimeout(() => setsEndRef.current?.scrollIntoView({ behavior: 'smooth' }), 100)
        return
      }
    }

    const newSet = buildNewSet(editingSetId ?? undefined)
    const ex = currentExercise()
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

    updateSession({ ...session, exercises: updatedExercises })
    clearSetInputs()
    setTimeout(() => setsEndRef.current?.scrollIntoView({ behavior: 'smooth' }), 100)
  }

  function buildNewSet(id?: string): WorkoutSet {
    return {
      id: id ?? crypto.randomUUID(),
      timestamp: new Date().toISOString(),
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
    const updatedExercises = session.exercises.map(e => {
      if (e.category === selectedCategory && e.name === selectedExercise && e.instanceId === currentInstanceId) {
        return { ...e, sets: e.sets.filter(s => s.id !== setId) }
      }
      return e
    }).filter(e => e.sets.length > 0)
    updateSession({ ...session, exercises: updatedExercises })
    setDeleteConfirmId(null)
    if (editingSetId === setId) clearSetInputs()
  }

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

  const finishWorkout = () => {
    if (totalSets === 0) return
    const now = new Date()
    onSaveSession({ ...session, endTime: now.toTimeString().slice(0, 5), rating, memo: finishMemo })
    clearDraft()
    setShowFinishModal(false)
    setShowSuccess(true)
    setTimeout(() => {
      setShowSuccess(false)
      setSession(newSession())
      setFinishMemo('')
      setRating(7)
    }, 2500)
  }

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

      <div className="flex-1 overflow-y-auto pb-4">
        {/* Category + Memo selector (3×3 grid) */}
        <div className="px-4 pt-4">
          <div className="grid grid-cols-3 gap-2">
            {CATEGORIES.map(cat => (
              <button
                key={cat}
                onClick={() => handleCategoryClick(cat)}
                className={`flex flex-col items-center justify-center py-3 px-1 rounded-xl text-xs font-medium transition-all ${
                  selectedCategory === cat && !isMemoMode
                    ? 'bg-accent text-bg font-bold shadow-lg shadow-accent/30'
                    : 'bg-card text-muted border border-border'
                }`}
              >
                <span className="text-lg mb-0.5">{CATEGORY_ICONS[cat]}</span>
                <span>{cat}</span>
              </button>
            ))}
            {/* Memo button — 9th cell */}
            <button
              onClick={() => setIsMemoMode(true)}
              className={`flex flex-col items-center justify-center py-3 px-1 rounded-xl text-xs font-medium transition-all ${
                isMemoMode
                  ? 'bg-accentGreen text-bg font-bold shadow-lg shadow-accentGreen/30'
                  : 'bg-card text-muted border border-border'
              }`}
            >
              <span className="text-lg mb-0.5">📝</span>
              <span>メモ</span>
            </button>
          </div>
        </div>

        {isMemoMode ? (
          /* ── Memo (note) mode ── */
          <div className="px-4 mt-4">
            <div className="bg-card border border-border rounded-2xl p-4">
              <div className="text-xs text-muted mb-3 font-medium uppercase tracking-wider">セッションメモを追加</div>

              <div className="mb-3">
                <label className="text-xs text-muted block mb-1">スコア</label>
                <select
                  value={noteScore}
                  onChange={e => setNoteScore(Number(e.target.value))}
                  className="w-full bg-surface border border-border rounded-xl px-3 py-3 text-white text-sm appearance-none"
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
                  className="w-full bg-surface border border-border rounded-xl px-3 py-3 text-white text-sm resize-none"
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

            {/* Existing notes */}
            {(session.notes?.length ?? 0) > 0 && (
              <div className="mt-4">
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
          /* ── Exercise recording mode ── */
          <>
            {/* Exercise selector */}
            <div className="px-4 mt-4 flex gap-2">
              <select
                value={selectedExercise}
                onChange={e => handleExerciseChange(e.target.value)}
                className="flex-1 bg-card border border-border rounded-xl px-3 py-3 text-sm text-white appearance-none"
              >
                {allExercises(selectedCategory).map(ex => (
                  <option key={ex} value={ex}>{ex}</option>
                ))}
              </select>
              <button
                onClick={() => setShowCustomModal(true)}
                className="bg-card border border-border rounded-xl px-3 py-3 text-accent text-sm font-medium whitespace-nowrap"
              >
                ＋ カスタム
              </button>
            </div>

            {/* Set input area */}
            <div className="px-4 mt-4">
              <div className="bg-card border border-border rounded-2xl p-4">
                <div className="text-xs text-muted mb-3 font-medium uppercase tracking-wider">
                  {editingSetId ? 'セットを編集' : `新しいセット — ${currentExerciseLabel}`}
                </div>

                {isCardio ? (
                  <div className="flex gap-3 mb-3">
                    <div className="flex-1">
                      <label className="text-xs text-muted block mb-1">時間 (分)</label>
                      <input
                        type="number" inputMode="decimal" placeholder="30"
                        value={durationInput} onChange={e => setDurationInput(e.target.value)}
                        className="w-full bg-surface border border-border rounded-xl px-3 py-3 text-white text-center text-lg font-bold"
                      />
                    </div>
                    <div className="flex-1">
                      <label className="text-xs text-muted block mb-1">距離 (km) 任意</label>
                      <input
                        type="number" inputMode="decimal" placeholder="5.0"
                        value={distanceInput} onChange={e => setDistanceInput(e.target.value)}
                        className="w-full bg-surface border border-border rounded-xl px-3 py-3 text-white text-center text-lg font-bold"
                      />
                    </div>
                  </div>
                ) : (
                  <div className="flex gap-3 mb-3">
                    <div className="flex-1">
                      <label className="text-xs text-muted block mb-1">重量 (kg)</label>
                      <input
                        type="number" inputMode="decimal" placeholder="60"
                        value={weightInput} onChange={e => setWeightInput(e.target.value)}
                        className="w-full bg-surface border border-border rounded-xl px-3 py-3 text-white text-center text-lg font-bold"
                      />
                    </div>
                    <div className="flex items-end pb-3 text-muted font-bold">×</div>
                    <div className="flex-1">
                      <label className="text-xs text-muted block mb-1">回数 (reps)</label>
                      <input
                        type="number" inputMode="numeric" placeholder="10"
                        value={repsInput} onChange={e => setRepsInput(e.target.value)}
                        className="w-full bg-surface border border-border rounded-xl px-3 py-3 text-white text-center text-lg font-bold"
                      />
                    </div>
                  </div>
                )}

                {/* Per-set memo */}
                <input
                  type="text"
                  placeholder="メモ（任意）"
                  value={setMemoInput}
                  onChange={e => setSetMemoInput(e.target.value)}
                  className="w-full bg-surface border border-border rounded-xl px-3 py-2 text-white text-sm mb-3"
                />

                <button
                  onClick={addOrUpdateSet}
                  disabled={isCardio ? !durationInput : !weightInput || !repsInput}
                  className="w-full bg-accent disabled:opacity-40 text-bg font-bold rounded-xl py-3 text-sm transition-all active:scale-95"
                >
                  {editingSetId ? '✓ セットを更新' : '＋ セットを追加'}
                </button>
                {editingSetId && (
                  <button onClick={clearSetInputs} className="mt-2 w-full text-muted text-sm py-2">
                    キャンセル
                  </button>
                )}
              </div>
            </div>

            {/* Sets list for current instance */}
            {currentSets.length > 0 && (
              <div className="px-4 mt-4">
                <div className="text-xs text-muted mb-2 font-medium uppercase tracking-wider">
                  {currentExerciseLabel} — {currentSets.length}セット
                </div>
                <div className="space-y-2">
                  {currentSets.map((set, idx) => (
                    <div key={set.id}>
                      <button
                        onClick={() => {
                          if (deleteConfirmId === set.id) { setDeleteConfirmId(null); return }
                          if (editingSetId === set.id) { clearSetInputs(); return }
                          startEditSet(set)
                        }}
                        className={`w-full flex items-center justify-between px-4 py-3 rounded-xl border transition-all ${
                          editingSetId === set.id ? 'bg-accent/10 border-accent' : 'bg-card border-border'
                        }`}
                      >
                        <span className="text-muted text-sm">セット {idx + 1}</span>
                        <div className="flex-1 text-right mr-2">
                          <span className="font-bold text-white">
                            {isCardio
                              ? `${set.durationMinutes}分${set.distanceKm ? ` · ${set.distanceKm}km` : ''}`
                              : `${set.weight}kg × ${set.reps}回`}
                          </span>
                          {set.memo && (
                            <div className="text-xs text-muted mt-0.5 truncate">{set.memo}</div>
                          )}
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

        {/* All exercises summary */}
        {(session.exercises.length > 0 || (session.notes?.length ?? 0) > 0) && (
          <div className="px-4 mt-4">
            <div className="text-xs text-muted mb-2 font-medium uppercase tracking-wider">
              今日の記録 — {totalSets}セット
            </div>
            <div className="bg-card border border-border rounded-2xl divide-y divide-border">
              {session.exercises.map((ex, i) => (
                <div key={i} className="flex items-center justify-between px-4 py-3">
                  <div>
                    <div className="text-sm font-medium text-white">
                      {getExerciseEntryLabel(session.exercises, ex)}
                    </div>
                    <div className="text-xs text-muted">{ex.category}</div>
                  </div>
                  <div className="text-accent font-bold text-sm">{ex.sets.length}セット</div>
                </div>
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

        <div ref={setsEndRef} />
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
                    key={n}
                    onClick={() => setRating(n)}
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
                value={finishMemo}
                onChange={e => setFinishMemo(e.target.value)}
                placeholder="今日のワークアウトについて..."
                rows={3}
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
