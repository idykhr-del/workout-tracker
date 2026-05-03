/**
 * calorieCalc.ts — 消費カロリー計算ユーティリティ
 *
 * 筋トレ：METs × 体重(kg) × 時間(h) × 1.05
 *   時間 = (回数 × 3秒) + レスト秒数
 *
 * 有酸素：種目ごとの精度の高い計算式を使用
 */

import type { Category } from '../types'

// ── 筋トレ：複合種目（METs 6.0）────────────────────────────────────────────
const COMPOUND_EXERCISES = new Set([
  // 胸
  'ベンチプレス', 'インクラインプレス', 'インクラインベンチプレス', 'インクラインダンベルプレス',
  'ダンベルプレス', 'ワイドダンベルプレス', 'チェストプレス', 'ディップス', 'ナローグリップベンチプレス',
  // 背中
  'デッドリフト', 'ラットプルダウン', 'チンニング（懸垂）', 'ベントオーバーロー', 'シーテッドロウ',
  'ケーブルプルオーバー', 'ハイロー', 'Tバーロウ', 'ストレートプルオーバー', 'ワンハンドローイング',
  'ローロウ', 'ロー/リアデルトイド', 'バックエクステンション', 'シュラッグ',
  // 肩
  'ショルダープレス', 'ダンベルショルダープレス', 'アーノルドプレス', 'アップライトロウ', 'ケーブルフェイスプル',
  // 脚
  'スクワット', 'スミスマシン・バーベルスクワット', 'レッグプレス', 'シーテッドレッグプレス',
  'ブルガリアンスクワット', 'ルーマニアンデッドリフト', 'ランジ', 'レッグカール', 'シーテッドレッグカール',
  'レッグエクステンション', 'レッグアブダクション',
  // お尻
  'ヒップスラスト', 'グルートブリッジ', 'スモウスクワット',
])

// ── 筋トレ：体幹・腹筋種目（METs 3.8）────────────────────────────────────
const CORE_EXERCISES = new Set([
  'プランク', 'クランチ', 'シットアップ', 'レッグレイズ', 'ハンギングレッグレイズ',
  'ロシアンツイスト', 'アブローラー', 'ケーブルクランチ', 'バイシクルクランチ',
])

/** 筋トレ種目の METs 値を返す。単関節種目は 3.5、体幹は 3.8、複合種目は 6.0。 */
export function getStrengthMETs(name: string, _category?: Category): number {
  if (CORE_EXERCISES.has(name)) return 3.8
  if (COMPOUND_EXERCISES.has(name)) return 6.0
  return 3.5
}

/**
 * 筋トレ 1 セットの推定消費カロリー (kcal)
 * time = reps × 3秒 + restSeconds
 * kcal = METs × bodyWeight × (time / 3600) × 1.05
 */
export function calcStrengthSetCalories(
  name: string,
  category: Category | undefined,
  reps: number,
  restSeconds: number,
  bodyWeight: number,
): number {
  if (reps <= 0 || bodyWeight <= 0) return 0
  const mets = getStrengthMETs(name, category)
  const seconds = reps * 3 + restSeconds
  return Math.max(1, Math.round(mets * bodyWeight * (seconds / 3600) * 1.05))
}

// ── 有酸素：種目別 METs（時間ベース計算に使用）──────────────────────────
const CARDIO_METS_MAP: Record<string, number> = {
  'ランニング':       9.8,
  'ウォーキング':     3.5,
  'サイクリング':     7.5,
  '縄跳び':          11.8,
  '水泳':            7.0,
  'エリプティカル':   5.0,
  'ローイングマシン': 8.5,
  'HIIT':            12.0,
  'ステアクライマー': 9.0,
}

/**
 * 有酸素 1 セットの推定消費カロリー (kcal)
 *
 * ランニング:  距離あり → 体重 × km × 1.04、なし → METs法
 * ウォーキング: 距離あり → 体重 × km × (0.5 + 傾斜% × 0.01)、なし → METs法
 * HIIT:        アフターバーン込み × 1.15
 * その他:       METs × 体重 × 時間(h) × 1.05
 */
export function calcCardioSetCalories(
  name: string,
  durationMinutes: number,
  distanceKm?: number,
  incline?: number,
  bodyWeight?: number,
): number {
  const bw = bodyWeight ?? 63
  if (bw <= 0 || durationMinutes <= 0) return 0
  const hours = durationMinutes / 60
  const dist  = distanceKm && distanceKm > 0 ? distanceKm : null
  const inc   = incline ?? 0

  if (name === 'ランニング') {
    if (dist) return Math.round(bw * dist * 1.04)
    return Math.round(9.8 * bw * hours * 1.05)
  }

  if (name === 'ウォーキング') {
    if (dist) return Math.round(bw * dist * (0.5 + inc * 0.01))
    const mets = 3.5 + inc * 0.2
    return Math.round(mets * bw * hours * 1.05)
  }

  if (name === 'HIIT') return Math.round(12.0 * bw * hours * 1.15)

  const mets = CARDIO_METS_MAP[name] ?? 5.0
  return Math.round(mets * bw * hours * 1.05)
}

/**
 * セッション全体の消費カロリーを計算する。
 * set.calories が保存済みの場合はそれを優先し、
 * 未保存の場合は set データから遡及計算する。
 */
export function getSessionCaloriesData(
  session: import('../types').WorkoutSession,
  bodyWeight: number,
  defaultRestSeconds = 90,
): { strength: number; cardio: number; total: number } {
  let strength = 0, cardio = 0

  for (const ex of session.exercises) {
    for (const set of ex.sets) {
      let cal = set.calories ?? 0
      if (!cal) {
        if (ex.category === '有酸素' && set.durationMinutes) {
          cal = calcCardioSetCalories(ex.name, set.durationMinutes, set.distanceKm, set.incline, bodyWeight)
        } else if (ex.category !== '有酸素' && set.reps) {
          cal = calcStrengthSetCalories(ex.name, ex.category, set.reps, defaultRestSeconds, bodyWeight)
        }
      }
      if (ex.category === '有酸素') cardio += cal
      else strength += cal
    }
  }

  return { strength: Math.round(strength), cardio: Math.round(cardio), total: Math.round(strength + cardio) }
}
