import { useState } from 'react'
import { useWorkoutData } from './hooks/useWorkoutData'
import RecordScreen from './pages/RecordScreen'
import GraphScreen from './pages/GraphScreen'
import SettingsScreen from './pages/SettingsScreen'
import AIChatScreen from './pages/AIChatScreen'
import type { WorkoutSession } from './types'

type Tab = 'record' | 'graph' | 'ai' | 'settings'

const TABS: { key: Tab; icon: string; label: string }[] = [
  { key: 'record',   icon: '📝', label: '記録' },
  { key: 'graph',    icon: '📊', label: 'グラフ' },
  { key: 'ai',       icon: '🤖', label: 'AI' },
  { key: 'settings', icon: '⚙️', label: '設定' },
]

const TAB_TITLES: Record<Tab, string> = {
  record:   'ワークアウト記録',
  graph:    '履歴・グラフ',
  ai:       'AIトレーナー',
  settings: '設定',
}

export default function App() {
  const [tab, setTab] = useState<Tab>('record')
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
          />
        </div>
        <div className={`absolute inset-0 transition-opacity duration-150 ${tab === 'graph' ? 'opacity-100 z-10' : 'opacity-0 z-0 pointer-events-none'}`}>
          <GraphScreen data={data} />
        </div>
        <div className={`absolute inset-0 transition-opacity duration-150 ${tab === 'ai' ? 'opacity-100 z-10' : 'opacity-0 z-0 pointer-events-none'}`}>
          {/* Only mount AIChatScreen when visible to reset chat on tab switch */}
          {tab === 'ai' && <AIChatScreen data={data} />}
        </div>
        <div className={`absolute inset-0 transition-opacity duration-150 ${tab === 'settings' ? 'opacity-100 z-10' : 'opacity-0 z-0 pointer-events-none'}`}>
          <SettingsScreen
            data={data}
            onDeleteCustomExercise={deleteCustomExercise}
            onResetData={resetData}
          />
        </div>
      </main>

      {/* Bottom nav */}
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
              <span className="text-xl leading-none">{t.icon}</span>
              <span className={`text-[10px] font-medium ${tab === t.key ? 'text-accent' : 'text-muted'}`}>
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
