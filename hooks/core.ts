// Pure helpers: numbers, prices, formatting. No engine calls here.
import type { ModelUsage } from 'claude-code'

import type { Bucket, Gate, Row, Scan, Task, Usage } from '../types'

export const empty = (): Usage => ({ input: 0, cacheWrite: 0, cacheWrite1h: 0, cacheRead: 0, output: 0, calls: 0, usd: 0 })
export const mainRow = (): Row => ({ id: 'main', who: 'main thread', type: 'main', models: [], usage: empty() })
export const newTask = (label: string, now: number): Task => ({ label, startedAt: now, main: mainRow(), agents: [] })

// List prices per million tokens, [input, output]. Only their ratios matter: the pane
// scales every estimate so the session's total equals the engine's own cost.
const PRICES: Record<string, [number, number]> = {
  fable: [5, 25], // not published here; priced as Opus until known
  mythos: [5, 25],
  opus: [5, 25],
  sonnet: [3, 15],
  haiku: [1, 5],
}
export const familyOf = (model: string) => /(fable|mythos|opus|sonnet|haiku)/i.exec(model)?.[1]?.toLowerCase() ?? 'other'
export const priceOf = (model: string): [number, number] => PRICES[familyOf(model)] ?? [3, 15]

// A cache write costs by how long the cache keeps it: five minutes at 1.25x input, one hour at 2x.
// Counted in input-token units; usage stored before the split was kept has no cacheWrite1h and prices at 1.25x.
type Tokens = { input: number; cacheWrite: number; cacheWrite1h?: number; cacheRead: number; output: number }
export const writeCost = (u: Tokens) => {
  const long = Math.min(u.cacheWrite1h ?? 0, u.cacheWrite)
  return (u.cacheWrite - long) * 1.25 + long * 2
}

export const usdOf = (model: string, u: Tokens) => {
  const [i, o] = priceOf(model)
  return (u.input * i + writeCost(u) * i + u.cacheRead * i * 0.1 + u.output * o) / 1e6
}

// The response's split by cache length when it carries one; else the main thread's writes go to the
// one-hour cache and a sub-agent's to the five-minute one (Claude Code's defaults on a subscription).
export const fromModel = (model: string, m: ModelUsage, isMain: boolean): Usage => {
  const split = (m as { cache_creation?: { ephemeral_1h_input_tokens?: number } }).cache_creation
  const cacheWrite = m.cache_creation_input_tokens ?? 0
  const u = {
    input: m.input_tokens ?? 0,
    cacheWrite,
    cacheWrite1h: Math.min(split ? (split.ephemeral_1h_input_tokens ?? 0) : isMain ? cacheWrite : 0, cacheWrite),
    cacheRead: m.cache_read_input_tokens ?? 0,
    output: m.output_tokens ?? 0,
  }
  return { ...u, calls: 1, usd: usdOf(model, u) }
}

export const sum = (a: Usage, b: Usage): Usage => ({
  input: a.input + b.input,
  cacheWrite: a.cacheWrite + b.cacheWrite,
  cacheWrite1h: (a.cacheWrite1h ?? 0) + (b.cacheWrite1h ?? 0),
  cacheRead: a.cacheRead + b.cacheRead,
  output: a.output + b.output,
  calls: a.calls + b.calls,
  usd: a.usd + b.usd,
})

// "Fresh" is what was paid full price: uncached input, cache writes and output.
export const fresh = (u: Usage) => u.input + u.cacheWrite + u.output
// Weighted: each kind by its price ratio to uncached input, so it compares cost, not volume.
export const weighted = (u: Usage) => u.input + writeCost(u) + u.cacheRead * 0.1 + u.output * 5

export const rowUse = (r: Row, model: string, u: Usage): Row => ({
  ...r,
  models: r.models.includes(model) ? r.models : [...r.models, model],
  usage: sum(r.usage, u),
})
export const taskTotal = (t: Task): Usage => t.agents.reduce((acc, a) => sum(acc, a.usage), t.main.usage)

/** The scan with each model's list-price estimate filled in. */
export const priceScan = (s: Scan): Scan => ({
  ...s,
  byModel: Object.fromEntries(
    Object.entries(s.byModel).map(([m, v]) => [m, { main: { ...v.main, usd: usdOf(m, v.main) }, agents: { ...v.agents, usd: usdOf(m, v.agents) } }]),
  ),
})
export const scanTotal = (s: Scan) => Object.values(s.byModel).reduce((acc, v) => sum(sum(acc, v.main), v.agents), empty())

/** What one list-price dollar is really worth this session: the engine's cost over the scan's estimate, both read together. */
export const factorOf = (s: Scan) => {
  const est = scanTotal(s).usd
  const f = s.costUsd != null && est > 0 ? s.costUsd / est : 1
  return Number.isFinite(f) && f > 0 ? f : 1
}

// "claude-opus-5-5" -> "Opus 5.5"
export const modelName = (id: string) => {
  const m = /(fable|mythos|opus|sonnet|haiku)-(\d+)(?:-(\d{1,2})(?!\d))?/i.exec(id)
  if (!m) return id.replace(/^claude-/, '')
  const [, family = '', major = '', minor] = m
  return `${family.charAt(0).toUpperCase()}${family.slice(1).toLowerCase()} ${major}${minor ? '.' + minor : ''}`
}

export const k = (n: number) =>
  n >= 1e9 ? (n / 1e9).toFixed(2) + 'B' : n >= 1e6 ? (n / 1e6).toFixed(2) + 'M' : n >= 1e4 ? Math.round(n / 1e3) + 'k' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'k' : String(Math.round(n))
export const usd = (n: number) => (n >= 100 ? `$${Math.round(n)}` : n >= 1 ? `$${n.toFixed(2)}` : n > 0 ? `$${n.toFixed(3)}` : '$0')

const pad = (n: number) => String(n).padStart(2, '0')
// 3:04:05, or 2d 03:04:05 past a day.
export const clock = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000))
  const d = Math.floor(s / 86400)
  const h = Math.floor((s % 86400) / 3600)
  const mmss = `${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`
  return d > 0 ? `${d}d ${pad(h)}:${mmss}` : `${h}:${mmss}`
}
// 850ms, 12s, 4m 05s, 2h 10m
export const dur = (ms: number) => {
  if (ms < 1000) return `${Math.round(ms)}ms`
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m ${pad(s % 60)}s`
  return `${Math.floor(s / 3600)}h ${pad(Math.floor((s % 3600) / 60))}m`
}
// Time to a reset, short enough for one column: 45m, 4h 27m, 6d 23h.
export const untilReset = (ms: number) => {
  const m = Math.round(ms / 60000)
  if (m < 60) return `${m}m`
  if (m < 1440) return `${Math.floor(m / 60)}h ${pad(m % 60)}m`
  return `${Math.floor(m / 1440)}d ${Math.floor((m % 1440) / 60)}h`
}
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
export const when = (ms: number) => {
  const d = new Date(ms)
  return `${MONTHS[d.getMonth()]} ${d.getDate()}, ${pad(d.getHours())}:${pad(d.getMinutes())}`
}
export const hhmm = (ms: number) => {
  const d = new Date(ms)
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export const bucketOf = (tool: string): Bucket =>
  /^(Read|Edit|Write|Glob|Grep|NotebookEdit|MultiEdit)$/.test(tool)
    ? 'file'
    : tool === 'Bash'
      ? 'shell'
      : /^(WebFetch|WebSearch)$|firecrawl|browser|chrome/i.test(tool)
        ? 'web'
        : /^(Agent|Task|Skill|SendMessage)$/.test(tool)
          ? 'agent'
          : 'other'
export const BUCKETS: Bucket[] = ['file', 'shell', 'web', 'agent', 'other']
export const emptyGate = (): Gate => ({
  totals: Object.fromEntries(BUCKETS.map(b => [b, { allowed: 0, asked: 0, denied: 0 }])) as Gate['totals'],
  recent: [],
})

export const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])

const mask = (s: string) => s.replace(/((?:key|token|secret|password|passwd|auth)[\w-]*\s*[=:]\s*)\S+/gi, '$1•••').replace(/\b(sk|pk|ghp|gho)[-_][A-Za-z0-9_-]{8,}/g, '$1-•••')
export const shorten = (s: string, n: number) => {
  const one = s.replace(/\s+/g, ' ').trim()
  return one.length > n ? one.slice(0, n - 1) + '…' : one
}
/** A tool call in a few words: the tool and its path, command, url or pattern, secrets masked. */
export const describe = (tool: string, input: unknown) => {
  const o = (input ?? {}) as Record<string, unknown>
  const pick = [o.file_path, o.command, o.url, o.pattern, o.query, o.description, o.skill].find(v => typeof v === 'string') as string | undefined
  const short = tool.replace(/^mcp__[^_]+(?:_[^_]+)*?__/, '')
  return pick ? `${short} ${mask(pick).replace(/^\/Users\/[^/]+/, '~')}` : short
}

const csvCell = (v: string | number) => {
  const s = String(v)
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}
export const csv = (rows: (string | number)[][]) => rows.map(r => r.map(csvCell).join(',')).join('\n')
