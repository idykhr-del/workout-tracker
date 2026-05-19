/**
 * fixBenchPress — ブラウザコンソール用データ修正スクリプト
 *
 * 使い方:
 *   workout-tracker-ivory-three.vercel.app を Safari / Chrome で開き、
 *   開発者ツールのコンソールに下記コードを貼り付けて実行する。
 *
 * 処理内容:
 *   - localStorage の workout_data から全セッションを取得
 *   - exercise.name === 'ベンチプレス' のセット全件の weight に +20 する
 *   - localStorage を上書き保存
 *   - IndexedDB (workout_db / workout_data) も同様に更新
 *   - 修正したセット数を console.log で表示
 */

// ─── コンソール貼り付け用コード（TypeScript ではなく純粋な JS） ───────────────
// ↓↓↓ 以下を丸ごとコピーしてブラウザのコンソールに貼り付ける ↓↓↓

/*
(async () => {
  const KEY = 'workout_data';
  let fixedCount = 0;

  // ── 1. localStorage を修正 ──────────────────────────────────────────────
  const raw = localStorage.getItem(KEY);
  if (!raw) { console.error('workout_data が localStorage に見つかりません'); return; }

  const data = JSON.parse(raw);

  data.sessions = data.sessions.map(session => ({
    ...session,
    exercises: session.exercises.map(ex => {
      if (ex.name !== 'ベンチプレス') return ex;
      return {
        ...ex,
        sets: ex.sets.map(set => {
          fixedCount++;
          return {
            ...set,
            weight: (set.weight ?? 0) + 20,
          };
        }),
      };
    }),
  }));

  localStorage.setItem(KEY, JSON.stringify(data));
  console.log(`[localStorage] ベンチプレス ${fixedCount} セットに +20kg を適用しました`);

  // ── 2. IndexedDB を修正 ─────────────────────────────────────────────────
  try {
    const DB_NAME    = 'workout_db';
    const STORE_NAME = 'workout_data';
    const RECORD_KEY = 'data';

    const db = await new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME);
      req.onsuccess = () => resolve(req.result);
      req.onerror   = () => reject(req.error);
    });

    const tx    = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);

    const existing = await new Promise((resolve, reject) => {
      const req = store.get(RECORD_KEY);
      req.onsuccess = () => resolve(req.result);
      req.onerror   = () => reject(req.error);
    });

    if (!existing) {
      console.warn('[IndexedDB] レコードが見つかりませんでした（localStorage のみ更新済み）');
    } else {
      // existing は { key, value } 形式または直接 data 形式の可能性があるため両対応
      const idbData = existing.value ?? existing;

      idbData.sessions = idbData.sessions.map(session => ({
        ...session,
        exercises: session.exercises.map(ex => {
          if (ex.name !== 'ベンチプレス') return ex;
          return {
            ...ex,
            sets: ex.sets.map(set => ({ ...set, weight: (set.weight ?? 0) + 20 })),
          };
        }),
      }));

      const record = existing.value !== undefined
        ? { ...existing, value: idbData }
        : idbData;

      await new Promise((resolve, reject) => {
        const req = store.put(record, RECORD_KEY);
        req.onsuccess = () => resolve();
        req.onerror   = () => reject(req.error);
      });

      console.log('[IndexedDB] 更新完了');
    }

    db.close();
  } catch (e) {
    console.warn('[IndexedDB] 更新をスキップ（エラー）:', e.message ?? e);
  }

  console.log('✅ 修正完了 — ページをリロードして反映を確認してください。');
})();
*/
