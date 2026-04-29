import { useState, useEffect, useRef } from 'react'
import type { WorkoutData, WorkoutSession } from '../types'

interface Props {
  data: WorkoutData
}

interface Message {
  role: 'user' | 'assistant'
  content: string
}

// ── Workout context builder ───────────────────────────────────────────
function buildWorkoutContext(sessions: WorkoutSession[]): string {
  const cutoff = new Date()
  cutoff.setDate(cutoff.getDate() - 30)

  const recent = sessions
    .filter(s => new Date(s.date) >= cutoff)
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, 30)

  if (recent.length === 0) return 'ワークアウト記録なし（まだデータがありません）'

  const summary = recent.map(s => {
    const exSummary = s.exercises.map(e => {
      const isCardio = e.category === '有酸素'
      if (isCardio) {
        const totalMin = e.sets.reduce((sum, set) => sum + (set.durationMinutes ?? 0), 0)
        return `  ${e.name}: ${e.sets.length}セット, 合計${totalMin}分`
      }
      const maxW = Math.max(...e.sets.map(set => set.weight ?? 0))
      const totalVol = e.sets.reduce((sum, set) => sum + (set.weight ?? 0) * (set.reps ?? 0), 0)
      return `  ${e.name}(${e.category}): ${e.sets.length}セット, 最大${maxW}kg, 総量${totalVol}kg`
    }).join('\n')
    return `【${s.date} 評価${s.rating ?? '-'}/10】\n${exSummary}${s.memo ? `\n  メモ: ${s.memo}` : ''}`
  }).join('\n\n')

  return `直近30日のワークアウト記録（${recent.length}回）:\n\n${summary}`
}

const SYSTEM_PROMPT = `あなたはプロのパーソナルトレーナーです。ユーザーの筋トレ記録データを参照し、進捗・オーバートレーニング・休養・種目バランスなどの観点からアドバイスをしてください。回答は日本語で、簡潔かつ具体的にしてください。箇条書きや改行を使って読みやすくしてください。`

const INITIAL_PROMPT_TYPES = [
  '直近の筋トレデータを見て、進捗のポジティブな点と改善点を1つずつ具体的に教えてください。',
  '直近のトレーニング記録から、今日トレーニングするのに最適な部位と種目を2〜3つおすすめしてください。理由も教えてください。',
  '直近の記録からオーバートレーニングや疲労蓄積の兆候がないか確認し、休養について具体的なアドバイスをください。',
  '私の種目バランス（胸・背中・脚・肩・腕など）を分析し、鍛えられていない部位や偏りがあれば教えてください。',
]

const API_KEY = import.meta.env.VITE_ANTHROPIC_API_KEY as string | undefined
const MODEL = 'claude-sonnet-4-20250514'

async function callAI(
  messages: Message[],
  systemContext: string,
  signal?: AbortSignal,
): Promise<string> {
  if (!API_KEY) {
    throw new Error('VITE_ANTHROPIC_API_KEY が設定されていません。.env.local ファイルまたは Vercel の環境変数に設定してください。')
  }

  const systemWithContext = `${SYSTEM_PROMPT}\n\n${systemContext}`

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    signal,
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': API_KEY,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 1024,
      system: systemWithContext,
      messages: messages.map(m => ({ role: m.role, content: m.content })),
    }),
  })

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: { message: res.statusText } }))
    throw new Error(err?.error?.message ?? `API エラー: ${res.status}`)
  }

  const data = await res.json()
  return (data.content?.[0]?.text as string) ?? ''
}

// ── Component ─────────────────────────────────────────────────────────
export default function AIChatScreen({ data }: Props) {
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [initialized, setInitialized] = useState(false)
  const bottomRef = useRef<HTMLDivElement>(null)
  const abortRef = useRef<AbortController | null>(null)

  const context = buildWorkoutContext(data.sessions)

  // Auto-scroll to bottom when messages change
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, isLoading])

  // Generate initial message on first mount
  useEffect(() => {
    if (initialized) return
    setInitialized(true)

    if (!API_KEY) {
      setMessages([{
        role: 'assistant',
        content: '⚠️ APIキーが設定されていません。\n\n`.env.local` に `VITE_ANTHROPIC_API_KEY=sk-ant-...` を追加するか、Vercel の環境変数に設定してください。',
      }])
      return
    }

    const randomPrompt = INITIAL_PROMPT_TYPES[Math.floor(Math.random() * INITIAL_PROMPT_TYPES.length)]
    const initMessages: Message[] = [{ role: 'user', content: randomPrompt }]

    setIsLoading(true)
    const ac = new AbortController()
    abortRef.current = ac

    callAI(initMessages, context, ac.signal)
      .then(reply => {
        setMessages([{ role: 'assistant', content: reply }])
      })
      .catch(e => {
        if (e.name === 'AbortError') return
        setMessages([{ role: 'assistant', content: `エラーが発生しました: ${e.message}` }])
      })
      .finally(() => setIsLoading(false))

    return () => ac.abort()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const sendMessage = async () => {
    const text = input.trim()
    if (!text || isLoading) return
    setInput('')
    setError(null)

    const newMessages: Message[] = [...messages, { role: 'user', content: text }]
    setMessages(newMessages)
    setIsLoading(true)

    const ac = new AbortController()
    abortRef.current = ac

    try {
      const reply = await callAI(newMessages, context, ac.signal)
      setMessages(prev => [...prev, { role: 'assistant', content: reply }])
    } catch (e: unknown) {
      if (e instanceof Error && e.name === 'AbortError') return
      const msg = e instanceof Error ? e.message : '不明なエラー'
      setError(msg)
    } finally {
      setIsLoading(false)
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      sendMessage()
    }
  }

  return (
    <div className="flex flex-col h-full">

      {/* Chat messages */}
      <div className="flex-1 overflow-y-auto px-4 pt-4 pb-2 space-y-3">

        {/* Header info */}
        <div className="flex items-center gap-2 mb-1">
          <div className="w-8 h-8 rounded-full bg-accent/20 border border-accent/40 flex items-center justify-center text-sm">🤖</div>
          <div>
            <div className="text-xs font-bold text-white">AIパーソナルトレーナー</div>
            <div className="text-[10px] text-muted">直近30日のデータを参照中</div>
          </div>
          <div className="ml-auto text-[10px] text-muted bg-card border border-border px-2 py-0.5 rounded-full">
            {data.sessions.length}回分
          </div>
        </div>

        {/* Initial loading */}
        {isLoading && messages.length === 0 && (
          <div className="flex gap-2">
            <div className="w-7 h-7 rounded-full bg-accent/20 border border-accent/40 flex items-center justify-center text-xs shrink-0 mt-0.5">🤖</div>
            <div className="bg-card border border-border rounded-2xl rounded-tl-sm px-4 py-3 max-w-[85%]">
              <div className="flex gap-1 items-center h-5">
                <div className="w-2 h-2 bg-accent rounded-full animate-bounce [animation-delay:0ms]" />
                <div className="w-2 h-2 bg-accent rounded-full animate-bounce [animation-delay:150ms]" />
                <div className="w-2 h-2 bg-accent rounded-full animate-bounce [animation-delay:300ms]" />
              </div>
            </div>
          </div>
        )}

        {/* Message list */}
        {messages.map((msg, i) => (
          <div key={i} className={`flex gap-2 ${msg.role === 'user' ? 'flex-row-reverse' : 'flex-row'}`}>
            <div className={`w-7 h-7 rounded-full flex items-center justify-center text-xs shrink-0 mt-0.5 border ${
              msg.role === 'user'
                ? 'bg-accent text-bg border-accent font-bold'
                : 'bg-accent/20 border-accent/40'
            }`}>
              {msg.role === 'user' ? '自' : '🤖'}
            </div>
            <div className={`px-4 py-3 rounded-2xl max-w-[85%] text-sm leading-relaxed whitespace-pre-wrap ${
              msg.role === 'user'
                ? 'bg-accent text-bg rounded-tr-sm font-medium'
                : 'bg-card border border-border text-white rounded-tl-sm'
            }`}>
              {msg.content}
            </div>
          </div>
        ))}

        {/* Loading indicator (after first message) */}
        {isLoading && messages.length > 0 && (
          <div className="flex gap-2">
            <div className="w-7 h-7 rounded-full bg-accent/20 border border-accent/40 flex items-center justify-center text-xs shrink-0 mt-0.5">🤖</div>
            <div className="bg-card border border-border rounded-2xl rounded-tl-sm px-4 py-3">
              <div className="flex gap-1 items-center h-5">
                <div className="w-2 h-2 bg-accent rounded-full animate-bounce [animation-delay:0ms]" />
                <div className="w-2 h-2 bg-accent rounded-full animate-bounce [animation-delay:150ms]" />
                <div className="w-2 h-2 bg-accent rounded-full animate-bounce [animation-delay:300ms]" />
              </div>
            </div>
          </div>
        )}

        {/* Error */}
        {error && (
          <div className="bg-red-500/10 border border-red-500/30 text-red-400 text-xs px-3 py-2 rounded-xl">
            ⚠️ {error}
          </div>
        )}

        <div ref={bottomRef} />
      </div>

      {/* Input area */}
      <div className="px-4 py-3 border-t border-border bg-bg">
        <div className="flex gap-2 items-end">
          <textarea
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="質問を入力… (例: 胸のトレーニングを増やすべき?)"
            rows={2}
            disabled={isLoading}
            className="flex-1 bg-card border border-border rounded-2xl px-4 py-3 text-white text-sm resize-none disabled:opacity-50 placeholder:text-muted"
          />
          <button
            onClick={sendMessage}
            disabled={!input.trim() || isLoading}
            className="shrink-0 w-12 h-12 bg-accent disabled:opacity-40 text-bg rounded-2xl flex items-center justify-center text-xl font-bold active:scale-95 transition-all"
          >
            ↑
          </button>
        </div>
        <p className="text-[10px] text-muted mt-1.5 text-center">
          Shift+Enter で改行 · Enter で送信
        </p>
      </div>
    </div>
  )
}
