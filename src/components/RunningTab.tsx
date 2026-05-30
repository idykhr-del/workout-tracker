/**
 * src/components/RunningTab.tsx
 * Running / Walking record tab with Strava integration.
 */

import { useState, useMemo } from 'react'
import {
  BarChart, Bar, LineChart, Line,
  XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend,
} from 'recharts'
import type { RunningRecord, RunningActivityType } from '../types'
import { useRunningData } from '../hooks/useRunningData'

// ─── Constants ────────────────────────────────────────────────────────────────

const STRAVA_AUTH_URL =
  'https://www.strava.com/oauth/authorize' +
  '?client_id=252383' +
  '&response_type=code' +
  '&redirect_uri=https://workout-tracker-ivory-three.vercel.app/api/strava/callback' +
  '&approval_prompt=auto' +
  '&scope=activity:read_all'

const ACTIVITY_ICONS: Record<RunningActivityType, string> = {
  running:  '🏃',
  walking:  '🚶',
  treadmill:'🏃',
  hike:     '🥾',
}

const ACTIVITY_LABELS: Record<RunningActivityType, string> = {
  running:  'ランニング',
  walking:  'ウォーキング',
  treadmill:'トレッドミル',
  hike:     'ハイキング',
}

const ACTIVITY_COLORS: Record<RunningActivityType, string> = {
  running:   '#e85d04',
  walking:   '#40b66b',
  treadmill: '#f59e0b',
  hike:      '#8b5cf6',
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatDuration(sec: number): string {
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  const s = sec % 60
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
  return `${m}:${String(s).padStart(2, '0')}`
}

function formatPace(secPerKm: number): string {
  const m = Math.floor(secPerKm / 60)
  const s = Math.round(secPerKm % 60)
  return `${m}'${String(s).padStart(2, '0')}"/km`
}

function formatSpeed(secPerKm: number): string {
  const kmh = 3600 / secPerKm
  return `${kmh.toFixed(1)} km/h`
}

/** "2026-05-28" → "5月28日" */
function fmtMD(dateStr: string): string {
  const [, m, d] = dateStr.split('-')
  return `${parseInt(m)}月${parseInt(d)}日`
}

/** "2026-05-28" → "2026-05" */
function toYM(dateStr: string): string { return dateStr.slice(0, 7) }

function currentYM(): string { return new Date().toISOString().slice(0, 7) }

/** ISO week label "5/21週" */
function isoWeekLabel(dateStr: string): string {
  const d  = new Date(dateStr + 'T00:00:00')
  // Move to Monday of this week
  const day  = (d.getDay() + 6) % 7
  const mon  = new Date(d)
  mon.setDate(d.getDate() - day)
  return `${mon.getMonth() + 1}/${mon.getDate()}週`
}

function isoWeekKey(dateStr: string): string {
  const d   = new Date(dateStr + 'T00:00:00')
  const day = (d.getDay() + 6) % 7
  const mon = new Date(d)
  mon.setDate(d.getDate() - day)
  return mon.toISOString().slice(0, 10)
}

function lastNWeekKeys(n: number): string[] {
  const result: string[] = []
  const today  = new Date()
  const day    = (today.getDay() + 6) % 7
  const thisMon = new Date(today)
  thisMon.setDate(today.getDate() - day)
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(thisMon)
    d.setDate(thisMon.getDate() - i * 7)
    result.push(d.toISOString().slice(0, 10))
  }
  return result
}

// ─── Sub-components ───────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function ChartTooltip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null
  return (
    <div className="bg-surface border border-border rounded-xl px-3 py-2 text-xs shadow-xl">
      <div className="text-muted mb-1">{label}</div>
      {payload.map((p: { name: string; value: number; color: string }, i: number) => (
        <div key={i} style={{ color: p.color }} className="font-bold">
          {p.name}: {p.value}
        </div>
      ))}
    </div>
  )
}

function RecordCard({
  record,
  onDelete,
}: {
  record: RunningRecord
  onDelete: (id: string) => void
}) {
  const [confirmDelete, setConfirmDelete] = useState(false)
  const isWalkLike = record.activityType === 'walking' || record.activityType === 'treadmill'

  return (
    <div className="bg-card border border-border rounded-2xl px-4 py-3">
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-lg shrink-0">
            {ACTIVITY_ICONS[record.activityType]}
          </span>
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span
                className="text-xs font-bold px-1.5 py-0.5 rounded-md"
                style={{
                  background: ACTIVITY_COLORS[record.activityType] + '22',
                  color:      ACTIVITY_COLORS[record.activityType],
                }}
              >
                {ACTIVITY_LABELS[record.activityType]}
              </span>
              <span className="text-xs text-muted">{fmtMD(record.date)}</span>
              {record.source === 'strava' && (
                <span className="text-[10px] text-orange-400 font-semibold">Strava</span>
              )}
            </div>

            <div className="flex items-center gap-3 mt-1.5 flex-wrap">
              {record.distanceKm != null && (
                <span className="text-white font-bold text-base">
                  {record.distanceKm.toFixed(2)} km
                </span>
              )}
              {record.durationSec != null && (
                <span className="text-sm text-muted">{formatDuration(record.durationSec)}</span>
              )}
              {record.avgPaceSec != null && record.avgPaceSec > 0 && (
                <span className="text-sm text-accent font-semibold">
                  {isWalkLike ? formatSpeed(record.avgPaceSec) : formatPace(record.avgPaceSec)}
                </span>
              )}
            </div>

            <div className="flex items-center gap-3 mt-1 flex-wrap">
              {record.avgHeartRate != null && (
                <span className="text-xs text-red-400">
                  ❤️ {record.avgHeartRate}
                  {record.maxHeartRate != null && `/${record.maxHeartRate}`} bpm
                </span>
              )}
              {record.calories != null && (
                <span className="text-xs text-accentGreen">🔥 {record.calories} kcal</span>
              )}
              {record.memo && (
                <span className="text-[11px] text-muted/70 truncate max-w-[160px]">
                  {record.memo}
                </span>
              )}
            </div>
          </div>
        </div>

        <button
          onClick={() => setConfirmDelete(true)}
          className="shrink-0 text-muted/50 text-lg w-8 h-8 flex items-center justify-center"
        >×</button>
      </div>

      {confirmDelete && (
        <div className="flex gap-2 mt-2 slide-in">
          <button
            onClick={() => { onDelete(record.id); setConfirmDelete(false) }}
            className="flex-1 bg-red-500/20 text-red-400 border border-red-500/30 rounded-xl py-2 text-xs font-medium"
          >削除する</button>
          <button
            onClick={() => setConfirmDelete(false)}
            className="flex-1 bg-surface text-muted border border-border rounded-xl py-2 text-xs"
          >キャンセル</button>
        </div>
      )}
    </div>
  )
}

// ─── Manual entry form ────────────────────────────────────────────────────────

interface FormState {
  date: string
  activityType: RunningActivityType
  distanceKm: string
  durationH: string
  durationM: string
  durationS: string
  avgHeartRate: string
  calories: string
  memo: string
}

function todayStr() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function ManualForm({
  onAdd,
  onClose,
}: {
  onAdd: (r: Omit<RunningRecord, 'id' | 'source'>) => void
  onClose: () => void
}) {
  const [form, setForm] = useState<FormState>({
    date: todayStr(),
    activityType: 'running',
    distanceKm: '',
    durationH: '', durationM: '', durationS: '',
    avgHeartRate: '', calories: '', memo: '',
  })

  const set = (k: keyof FormState) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
    setForm(prev => ({ ...prev, [k]: e.target.value }))

  const handleSubmit = () => {
    const distKm = form.distanceKm ? parseFloat(form.distanceKm) : undefined
    const h = parseInt(form.durationH  || '0')
    const m = parseInt(form.durationM  || '0')
    const s = parseInt(form.durationS  || '0')
    const totalSec = h * 3600 + m * 60 + s || undefined
    const avgPaceSec = (distKm && totalSec && distKm > 0)
      ? Math.round(totalSec / distKm) : undefined

    onAdd({
      date: form.date,
      activityType: form.activityType,
      distanceKm: distKm,
      durationSec: totalSec,
      avgPaceSec,
      avgHeartRate: form.avgHeartRate ? parseInt(form.avgHeartRate) : undefined,
      calories: form.calories ? parseInt(form.calories) : undefined,
      memo: form.memo.trim() || undefined,
    })
    onClose()
  }

  const canSubmit = form.date && form.activityType

  return (
    <div className="bg-card border border-border rounded-2xl p-4 mt-3 slide-in">
      <div className="text-xs text-muted font-medium uppercase tracking-wider mb-3">手動で記録を追加</div>

      <div className="space-y-3">
        <div className="flex gap-2">
          <div className="flex-1">
            <label className="text-xs text-muted block mb-1">日付</label>
            <input type="date" value={form.date} onChange={set('date')} max={todayStr()}
              className="w-full bg-surface border border-border rounded-xl px-3 py-2 text-white text-sm" />
          </div>
          <div className="flex-1">
            <label className="text-xs text-muted block mb-1">種別</label>
            <select value={form.activityType} onChange={set('activityType')}
              className="w-full bg-surface border border-border rounded-xl px-3 py-2 text-white text-sm appearance-none">
              {(Object.keys(ACTIVITY_LABELS) as RunningActivityType[]).map(t => (
                <option key={t} value={t}>{ACTIVITY_ICONS[t]} {ACTIVITY_LABELS[t]}</option>
              ))}
            </select>
          </div>
        </div>

        <div className="flex gap-2">
          <div className="flex-1">
            <label className="text-xs text-muted block mb-1">距離 (km)</label>
            <input type="number" inputMode="decimal" placeholder="5.0"
              value={form.distanceKm} onChange={set('distanceKm')}
              className="w-full bg-surface border border-border rounded-xl px-3 py-2 text-white text-center text-base font-bold" />
          </div>
        </div>

        <div>
          <label className="text-xs text-muted block mb-1">タイム（時間 / 分 / 秒）</label>
          <div className="flex gap-2">
            {[
              { key: 'durationH' as const, label: '時', max: 23 },
              { key: 'durationM' as const, label: '分', max: 59 },
              { key: 'durationS' as const, label: '秒', max: 59 },
            ].map(({ key, label, max }) => (
              <div key={key} className="flex-1 relative">
                <input type="number" inputMode="numeric" placeholder="0" min={0} max={max}
                  value={form[key]} onChange={set(key)}
                  className="w-full bg-surface border border-border rounded-xl px-2 py-2 text-white text-center text-base font-bold" />
                <span className="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-muted">{label}</span>
              </div>
            ))}
          </div>
        </div>

        <div className="flex gap-2">
          <div className="flex-1">
            <label className="text-xs text-muted block mb-1">平均心拍数</label>
            <input type="number" inputMode="numeric" placeholder="145"
              value={form.avgHeartRate} onChange={set('avgHeartRate')}
              className="w-full bg-surface border border-border rounded-xl px-3 py-2 text-white text-center text-base font-bold" />
          </div>
          <div className="flex-1">
            <label className="text-xs text-muted block mb-1">消費kcal</label>
            <input type="number" inputMode="numeric" placeholder="350"
              value={form.calories} onChange={set('calories')}
              className="w-full bg-surface border border-border rounded-xl px-3 py-2 text-white text-center text-base font-bold" />
          </div>
        </div>

        <div>
          <label className="text-xs text-muted block mb-1">メモ（任意）</label>
          <textarea value={form.memo} onChange={set('memo')} rows={2} placeholder="朝ラン、坂道コースなど"
            className="w-full bg-surface border border-border rounded-xl px-3 py-2 text-white text-sm resize-none" />
        </div>

        <div className="flex gap-2">
          <button onClick={handleSubmit} disabled={!canSubmit}
            className="flex-1 bg-accent disabled:opacity-40 text-bg font-bold rounded-xl py-3 text-sm active:scale-95 transition-all">
            追加する
          </button>
          <button onClick={onClose}
            className="flex-1 bg-surface border border-border text-muted rounded-xl py-3 text-sm">
            キャンセル
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function RunningTab() {
  const {
    records, stravaConnected, lastSync, isLoading, syncing,
    addRecord, deleteRecord, syncStrava,
  } = useRunningData()

  const [syncResult,     setSyncResult]     = useState<{ synced: number; error?: string } | null>(null)
  const [showManualForm, setShowManualForm] = useState(false)
  const [selectedYM,     setSelectedYM]     = useState(currentYM())

  // ── Monthly navigation ────────────────────────────────────────────────────
  const allMonths = useMemo(() => {
    const set = new Set<string>([currentYM()])
    records.forEach(r => set.add(toYM(r.date)))
    return Array.from(set).sort().reverse()
  }, [records])

  const monthlyRecords = useMemo(
    () => records.filter(r => toYM(r.date) === selectedYM),
    [records, selectedYM],
  )

  // ── Monthly summary ───────────────────────────────────────────────────────
  const summary = useMemo(() => {
    const byType = {} as Record<RunningActivityType, { count: number; km: number; sec: number }>
    for (const r of monthlyRecords) {
      const t = r.activityType
      if (!byType[t]) byType[t] = { count: 0, km: 0, sec: 0 }
      byType[t].count++
      byType[t].km  += r.distanceKm ?? 0
      byType[t].sec += r.durationSec ?? 0
    }
    return byType
  }, [monthlyRecords])

  // ── Weekly distance chart (last 8 weeks) ──────────────────────────────────
  const weeklyData = useMemo(() => {
    const weeks = lastNWeekKeys(8)
    return weeks.map(wk => {
      const label = isoWeekLabel(wk)
      const row: Record<string, unknown> = { week: label }
      for (const r of records) {
        if (isoWeekKey(r.date) !== wk) continue
        const key = r.activityType
        row[key] = ((row[key] as number) ?? 0) + (r.distanceKm ?? 0)
      }
      // Round to 2 decimals
      for (const t of ['running', 'walking', 'treadmill', 'hike'] as RunningActivityType[]) {
        if (typeof row[t] === 'number') row[t] = +((row[t] as number).toFixed(2))
      }
      return row
    })
  }, [records])

  // ── Running pace chart (last 20 runs) ────────────────────────────────────
  const paceData = useMemo(() =>
    records
      .filter(r => r.activityType === 'running' && r.avgPaceSec && r.avgPaceSec > 0)
      .slice(0, 20)
      .reverse()
      .map(r => ({
        date:     fmtMD(r.date),
        pace:     r.avgPaceSec ? +(r.avgPaceSec / 60).toFixed(2) : null,   // min/km float
        paceStr:  r.avgPaceSec ? formatPace(r.avgPaceSec) : '',
      })),
  [records])

  // ── Sync handler ──────────────────────────────────────────────────────────
  const handleSync = async () => {
    setSyncResult(null)
    const result = await syncStrava()
    setSyncResult(result)
    setTimeout(() => setSyncResult(null), 6000)
  }

  // ── Last sync display ─────────────────────────────────────────────────────
  const lastSyncLabel = useMemo(() => {
    if (!lastSync) return null
    const d = new Date(lastSync)
    return `最終同期：${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`
  }, [lastSync])

  // ── Month selector label ──────────────────────────────────────────────────
  const monthLabel = (ym: string) => {
    const [y, m] = ym.split('-')
    return `${y}年${parseInt(m)}月`
  }

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div className="flex flex-col h-full overflow-y-auto pb-8">

      {/* Loading skeleton */}
      {isLoading && (
        <div className="flex flex-col items-center justify-center flex-1 gap-3 py-16">
          <div className="text-3xl animate-pulse">🏃</div>
          <div className="text-sm text-muted animate-pulse">データを読み込み中…</div>
        </div>
      )}

      {!isLoading && (
        <>
          {/* ── Strava section ── */}
          <div className="px-4 pt-4">
            <div className="bg-card border border-border rounded-2xl p-4">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <div className="text-sm font-bold text-white flex items-center gap-2">
                    <img
                      src="https://www.strava.com/favicon.ico"
                      alt="Strava"
                      className="w-4 h-4"
                      onError={e => { (e.target as HTMLImageElement).style.display = 'none' }}
                    />
                    Strava連携
                  </div>
                  {stravaConnected ? (
                    <div className="flex items-center gap-1.5 mt-0.5">
                      <span className="w-1.5 h-1.5 rounded-full bg-accentGreen" />
                      <span className="text-xs text-accentGreen">連携中</span>
                      {lastSyncLabel && <span className="text-xs text-muted ml-1">{lastSyncLabel}</span>}
                    </div>
                  ) : (
                    <div className="flex items-center gap-1.5 mt-0.5">
                      <span className="w-1.5 h-1.5 rounded-full bg-muted" />
                      <span className="text-xs text-muted">未連携</span>
                    </div>
                  )}
                </div>

                {stravaConnected ? (
                  <button
                    onClick={handleSync}
                    disabled={syncing}
                    className="bg-orange-500 disabled:opacity-50 text-white font-bold text-sm rounded-xl px-4 py-2.5 active:scale-95 transition-all"
                  >
                    {syncing ? '同期中…' : '同期する'}
                  </button>
                ) : (
                  <button
                    onClick={() => { window.location.href = STRAVA_AUTH_URL }}
                    className="bg-orange-500 text-white font-bold text-sm rounded-xl px-4 py-2.5 active:scale-95 transition-all"
                  >
                    連携する
                  </button>
                )}
              </div>

              {/* Sync result toast */}
              {syncResult && (
                <div className={`mt-2.5 px-3 py-2 rounded-xl text-xs font-semibold text-center slide-in ${
                  syncResult.error
                    ? 'bg-red-500/10 text-red-400 border border-red-500/20'
                    : 'bg-accentGreen/10 text-accentGreen border border-accentGreen/20'
                }`}>
                  {syncResult.error
                    ? `❌ 同期エラー：${syncResult.error}`
                    : syncResult.synced === 0
                      ? '✅ 新しいアクティビティはありません'
                      : `✅ ${syncResult.synced}件のアクティビティを取り込みました`}
                </div>
              )}

              {!stravaConnected && (
                <p className="text-xs text-muted mt-2 leading-relaxed">
                  Stravaと連携すると、ランニング・ウォーキングの記録が自動で取り込まれます。
                </p>
              )}
            </div>
          </div>

          {/* ── Month selector ── */}
          <div className="px-4 mt-3 flex items-center gap-2 overflow-x-auto" style={{ scrollbarWidth: 'none' }}>
            {allMonths.map(ym => (
              <button
                key={ym}
                onClick={() => setSelectedYM(ym)}
                className={`shrink-0 px-3 py-1.5 rounded-xl text-xs font-medium transition-all ${
                  selectedYM === ym
                    ? 'bg-accent text-bg font-bold shadow-md shadow-accent/30'
                    : 'bg-card text-muted border border-border'
                }`}
              >{monthLabel(ym)}</button>
            ))}
          </div>

          {/* ── Monthly summary ── */}
          {Object.keys(summary).length > 0 && (
            <div className="px-4 mt-3">
              <div className="grid grid-cols-2 gap-2">
                {(Object.entries(summary) as [RunningActivityType, { count: number; km: number; sec: number }][])
                  .map(([type, s]) => (
                    <div
                      key={type}
                      className="bg-card border border-border rounded-2xl p-3"
                      style={{ borderLeftColor: ACTIVITY_COLORS[type], borderLeftWidth: 3 }}
                    >
                      <div className="text-lg mb-1">{ACTIVITY_ICONS[type]}</div>
                      <div className="text-xs text-muted">{ACTIVITY_LABELS[type]}</div>
                      <div className="text-white font-bold text-base mt-0.5">
                        {s.km.toFixed(1)} km
                      </div>
                      <div className="text-xs text-muted">
                        {s.count}回 · {formatDuration(s.sec)}
                      </div>
                    </div>
                  ))}
              </div>
            </div>
          )}

          {/* ── Weekly distance chart ── */}
          {records.length > 0 && (
            <div className="px-4 mt-4">
              <div className="bg-card border border-border rounded-2xl p-4">
                <div className="text-xs text-muted font-medium uppercase tracking-wider mb-3">
                  週別距離（直近8週）
                </div>
                <ResponsiveContainer width="100%" height={160}>
                  <BarChart data={weeklyData} margin={{ top: 0, right: 0, left: -20, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#2a2a38" vertical={false} />
                    <XAxis dataKey="week" tick={{ fill: '#666', fontSize: 10 }} />
                    <YAxis tick={{ fill: '#666', fontSize: 10 }} unit=" km" />
                    <Tooltip content={<ChartTooltip />} />
                    <Legend wrapperStyle={{ fontSize: 11, color: '#888' }} />
                    <Bar dataKey="running"   name="ランニング"   fill={ACTIVITY_COLORS.running}   radius={[3,3,0,0]} maxBarSize={18} />
                    <Bar dataKey="walking"   name="ウォーキング" fill={ACTIVITY_COLORS.walking}   radius={[3,3,0,0]} maxBarSize={18} />
                    <Bar dataKey="treadmill" name="トレッドミル" fill={ACTIVITY_COLORS.treadmill} radius={[3,3,0,0]} maxBarSize={18} />
                    <Bar dataKey="hike"      name="ハイキング"   fill={ACTIVITY_COLORS.hike}      radius={[3,3,0,0]} maxBarSize={18} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>
          )}

          {/* ── Running pace chart ── */}
          {paceData.length >= 3 && (
            <div className="px-4 mt-3">
              <div className="bg-card border border-border rounded-2xl p-4">
                <div className="text-xs text-muted font-medium uppercase tracking-wider mb-3">
                  ペース推移（ランニング 直近{paceData.length}件）
                </div>
                <ResponsiveContainer width="100%" height={140}>
                  <LineChart data={paceData} margin={{ top: 0, right: 0, left: -20, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#2a2a38" vertical={false} />
                    <XAxis dataKey="date" tick={{ fill: '#666', fontSize: 10 }} />
                    <YAxis
                      tick={{ fill: '#666', fontSize: 10 }}
                      domain={['auto', 'auto']}
                      reversed
                      tickFormatter={(v: number) => `${Math.floor(v)}'${String(Math.round((v % 1) * 60)).padStart(2,'0')}"`}
                    />
                    <Tooltip
                      content={({ active, payload, label }: any) => {
                        if (!active || !payload?.length) return null
                        const paceStr = payload[0]?.payload?.paceStr ?? ''
                        return (
                          <div className="bg-surface border border-border rounded-xl px-3 py-2 text-xs shadow-xl">
                            <div className="text-muted mb-1">{label}</div>
                            <div style={{ color: ACTIVITY_COLORS.running }} className="font-bold">{paceStr}</div>
                          </div>
                        )
                      }}
                    />
                    <Line
                      type="monotone" dataKey="pace" name="ペース"
                      stroke={ACTIVITY_COLORS.running} strokeWidth={2} dot={{ r: 3, fill: ACTIVITY_COLORS.running }}
                      connectNulls
                    />
                  </LineChart>
                </ResponsiveContainer>
                <div className="text-[10px] text-muted/60 text-right mt-1">↑ 速いほど上</div>
              </div>
            </div>
          )}

          {/* ── Add button + manual form ── */}
          <div className="px-4 mt-4">
            {showManualForm ? (
              <ManualForm
                onAdd={r => { addRecord(r); setShowManualForm(false) }}
                onClose={() => setShowManualForm(false)}
              />
            ) : (
              <button
                onClick={() => setShowManualForm(true)}
                className="w-full bg-card border border-border border-dashed text-muted rounded-2xl py-3 text-sm active:scale-95 transition-all"
              >
                ＋ 手動で記録を追加
              </button>
            )}
          </div>

          {/* ── Record list ── */}
          <div className="px-4 mt-4">
            {monthlyRecords.length === 0 ? (
              <div className="text-center py-12 text-muted text-sm">
                <div className="text-3xl mb-3">🏃</div>
                <div>{monthLabel(selectedYM)}の記録はありません</div>
                {!stravaConnected && (
                  <div className="mt-2 text-xs">Stravaと連携するか、手動で記録を追加してください</div>
                )}
              </div>
            ) : (
              <>
                <div className="text-xs text-muted mb-2 font-medium uppercase tracking-wider">
                  {monthLabel(selectedYM)} — {monthlyRecords.length}件
                </div>
                <div className="space-y-2">
                  {monthlyRecords.map(r => (
                    <RecordCard key={r.id} record={r} onDelete={deleteRecord} />
                  ))}
                </div>
              </>
            )}
          </div>
        </>
      )}
    </div>
  )
}
