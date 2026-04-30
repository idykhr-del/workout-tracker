import { useState } from 'react'
import { useWorkoutData } from './hooks/useWorkoutData'
import RecordScreen from './pages/RecordScreen'
import GraphScreen from './pages/GraphScreen'
import CalendarScreen from './pages/CalendarScreen'
import RecommendScreen from './pages/RecommendScreen'
import SettingsScreen from './pages/SettingsScreen'
import { loadBodyWeight, saveBodyWeight } from './utils/storage'
import type { WorkoutSession } from './types'

type Tab = 'record' | 'graph' | 'calendar' | 'recommend' | 'settings'

const TABS: { key: Tab; icon: string; label: string }[] = [
  { key: 'record',    icon: '📝', label: '記録' },
  { key: 'graph',     icon: '📊', label: 'グラフ' },
  { key: 'calendar',  icon: '📅', label: 'カレンダー' },
  { key: 'recommend', icon: '💡', label: 'おすすめ' },
  { key: 'settings',  icon: '⚙️', label: '設定' },
]

const TAB_TITLES: Record<Tab, string> = {
  record:    'ワークアウト記録',
  graph:     '履歴・グラフ',
  calendar:  'カレンダー',
  recommend: 'おすすめ分析',
  settings:  '設定',
}

export default function App() {
  const [tab, setTab] = useState<Tab>('record')
  const [bodyWeight, setBodyWeight] = useState<number>(() => loadBodyWeight())

  const {
    data,
    saveSession,
    addCustomExercise,
    deleteCustomExercise,
    resetData,
  } = useWorkoutData()

  const handleSaveSession = (session: WorkoutSession) => {
    saveSession(session)
  }

  const handleBodyWeightChange = (kg: number) => {
    setBodyWeight(kg)
    saveBodyWeight(kg)
  }

  return (
    <div className="flex flex-col h-svh h-screen bg-bg text-white">
      {/* Header */}
      <header className="flex items-center justify-between px-4 pt-12 pb-3 border-b border-border bg-surface shrink-0">
        <h1 className="text-base font-bold text-white">{TAB_TITLES[tab]}</h1>
        <div className="text-accent text-lg">🏋️</div>
      </header>

      {/* Page content */}
      <main className="flex-1 overflow-hidden relative">
        <div className={`absolute inset-0 transition-opacity duration-150 ${tab === 'record' ? 'opacity-100 z-10' : 'opacity-0 z-0 pointer-events-none'}`}>
          <RecordScreen
            onSaveSession={handleSaveSession}
            customExercises={data.customExercises}
            onAddCustomExercise={addCustomExercise}
            sessions={data.sessions}
            bodyWeight={bodyWeight}
          />
        </div>
        <div className={`absolute inset-0 transition-opacity duration-150 ${tab === 'graph' ? 'opacity-100 z-10' : 'opacity-0 z-0 pointer-events-none'}`}>
          <GraphScreen data={data} />
        </div>
        <div className={`absolute inset-0 transition-opacity duration-150 ${tab === 'calendar' ? 'opacity-100 z-10' : 'opacity-0 z-0 pointer-events-none'}`}>
          <CalendarScreen data={data} onUpdateSession={saveSession} />
        </div>
        <div className={`absolute inset-0 transition-opacity duration-150 ${tab === 'recommend' ? 'opacity-100 z-10' : 'opacity-0 z-0 pointer-events-none'}`}>
          <RecommendScreen data={data} />
        </div>
        <div className={`absolute inset-0 transition-opacity duration-150 ${tab === 'settings' ? 'opacity-100 z-10' : 'opacity-0 z-0 pointer-events-none'}`}>
          <SettingsScreen
            data={data}
            onDeleteCustomExercise={deleteCustomExercise}
            onResetData={resetData}
            bodyWeight={bodyWeight}
            onBodyWeightChange={handleBodyWeightChange}
          />
        </div>
      </main>

      {/* Bottom nav — 5 tabs */}
      <nav className="shrink-0 border-t border-border bg-surface pb-safe pb-4">
        <div className="flex">
          {TABS.map(t => (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={`flex-1 flex flex-col items-center justify-center pt-3 pb-1 gap-0.5 transition-all ${
                tab === t.key ? 'text-accent' : 'text-muted'
              }`}
            >
              <span className="text-lg leading-none">{t.icon}</span>
              <span className={`text-[9px] font-medium leading-tight ${tab === t.key ? 'text-accent' : 'text-muted'}`}>
                {t.label}
              </span>
              {tab === t.key && (
                <div className="w-1 h-1 rounded-full bg-accent mt-0.5" />
              )}
            </button>
          ))}
        </div>
      </nav>
    </div>
  )
}
