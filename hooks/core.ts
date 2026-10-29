// Pure helpers: numbers, prices, formatting. No engine calls here.
import type { ModelUsage, SessionContextBreakdown } from 'claude-code'

import type { Bucket, Gate, Layout, Row, Scan, Targets, Task, Usage } from '../types'

export const empty = (): Usage => ({ input: 0, cacheWrite: 0, cacheWrite1h: 0, cacheRead: 0, output: 0, calls: 0, usd: 0 })
export const newTask = (label: string, now: number): Task => ({
  label,
  startedAt: now,
  main: { id: 'main', who: 'main thread', type: 'main', models: [], usage: empty() },
  agents: [],
})

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
const priceOf = (model: string): [number, number] => PRICES[familyOf(model)] ?? [3, 15]

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

// The context_breakdown tool's answer: /context's categories, then per-server MCP tool tokens,
// memory files, agents, skills and slash commands, largest first.
export const breakdownText = (b: SessionContextBreakdown) => {
  const n = (x: number) => Math.round(x).toLocaleString('en-US')
  const servers = new Map<string, { loaded: number; deferred: number; tools: number }>()
  for (const t of b.mcpTools) {
    const s = servers.get(t.serverName) ?? { loaded: 0, deferred: 0, tools: 0 }
    if (t.isLoaded) s.loaded += t.tokens
    else s.deferred += t.tokens
    s.tools += 1
    servers.set(t.serverName, s)
  }
  const out = [`Context ${n(b.totalTokens)} of ${n(b.rawMaxTokens)} (${b.model})`, 'Categories (deferred ones do not count toward the total):']
  for (const c of [...b.categories].sort((x, y) => y.tokens - x.tokens)) out.push(`  ${c.name}: ${n(c.tokens)}${c.isDeferred ? ' (deferred)' : ''}`)
  out.push('MCP servers (loaded tokens, deferred tokens, tools):')
  for (const [name, s] of [...servers].sort((x, y) => y[1].loaded + y[1].deferred - (x[1].loaded + x[1].deferred)))
    out.push(`  ${name}: ${n(s.loaded)}, ${n(s.deferred)}, ${s.tools}`)
  out.push('Memory files:')
  for (const m of b.memoryFiles) out.push(`  ${m.path}: ${n(m.tokens)}`)
  out.push(`Agents: ${n(b.agents.reduce((a, x) => a + x.tokens, 0))} over ${b.agents.length}`)
  if (b.skills) out.push(`Skills: ${n(b.skills.tokens)}, ${b.skills.includedSkills} of ${b.skills.totalSkills} listed`)
  if (b.slashCommands) out.push(`Slash commands: ${n(b.slashCommands.tokens)}, ${b.slashCommands.includedCommands} of ${b.slashCommands.totalCommands} listed`)
  return out.join('\n')
}

// Plan-limit estimator. The engine gives each limit as a whole percent, so the pane learns how many
// dollars of spend one percent takes, from the spend counted between percent steps across sessions
// (kept in $.store), and adds the spend since the last step to the shown percent.
type LimitTrack = { pct: number; resetsAt: number | null; spent: number; isClean: boolean }
export type LimitModel = {
  /** dollars counted by every session since the model began */
  spent: number
  /** each session's last cost, so only its new spend is added */
  seen: Record<string, { cost: number; at: number }>
  tracks: Record<string, LimitTrack>
  /** dollars per one percent, the last few steps, per limit */
  samples: Record<string, number[]>
}
type LimitReading = { kind: string; pct: number; resetsAt: number | null }
const LIMIT_SAMPLES = 5
const SEEN_DAYS = 8
// The engine's reset time moves by milliseconds between readings; a new window moves it by hours.
const isSameWindow = (a: number | null, b: number | null) => (a === null || b === null ? a === b : Math.abs(a - b) <= 60_000)

export const emptyLimitModel = (): LimitModel => ({ spent: 0, seen: {}, tracks: {}, samples: {} })

export const stepLimitModel = (m: LimitModel, session: string, cost: number | null, limits: LimitReading[], now: number): LimitModel => {
  let spent = m.spent
  const seen = { ...m.seen }
  if (cost !== null && Number.isFinite(cost) && session) {
    const was = seen[session]?.cost
    // A session's cost only grows; a lower one (a cleared session) starts its count again.
    if (was !== undefined && cost > was) spent += cost - was
    seen[session] = { cost, at: now }
  }
  for (const [id, s] of Object.entries(seen)) if (now - s.at > SEEN_DAYS * 86_400_000) delete seen[id]
  const tracks = { ...m.tracks }
  const samples = { ...m.samples }
  for (const l of limits) {
    const t = tracks[l.kind]
    const isNewWindow = t !== undefined && !isSameWindow(t.resetsAt, l.resetsAt)
    if (!t || isNewWindow || l.pct < t.pct) {
      // A fresh window at 0% starts exactly at a step; anything else waits for the next step.
      tracks[l.kind] = { pct: l.pct, resetsAt: l.resetsAt, spent, isClean: isNewWindow && l.pct === 0 }
    } else if (l.pct > t.pct) {
      if (t.isClean && spent > t.spent) samples[l.kind] = [...(samples[l.kind] ?? []), (spent - t.spent) / (l.pct - t.pct)].slice(-LIMIT_SAMPLES)
      tracks[l.kind] = { pct: l.pct, resetsAt: l.resetsAt, spent, isClean: true }
    } else tracks[l.kind] = { ...t, resetsAt: l.resetsAt }
  }
  return { spent, seen, tracks, samples }
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b)
  const mid = s.length >> 1
  return s.length % 2 ? (s[mid] ?? 0) : ((s[mid - 1] ?? 0) + (s[mid] ?? 0)) / 2
}

/** The limit's percent to two decimals, or null until two steps have been measured. */
export const estimateLimit = (m: LimitModel, l: LimitReading): number | null => {
  const t = m.tracks[l.kind]
  const xs = m.samples[l.kind] ?? []
  if (!t || !t.isClean || t.pct !== l.pct || l.pct >= 100 || xs.length < 2) return null
  const perPct = median(xs)
  if (!(perPct > 0)) return null
  // The engine rounds down, so the true value sits between pct and pct + 1.
  return Math.round(100 * Math.min(l.pct + 0.99, l.pct + (m.spent - t.spent) / perPct)) / 100
}

// The pane's section layout: which sections show and in what order. Vitals is not in it; it always shows.
export const SECTIONS: { id: string; title: string }[] = [
  { id: 'session', title: 'Session totals' },
  { id: 'tasks', title: 'Tasks' },
  { id: 'requests', title: 'Recent requests' },
  { id: 'agents', title: 'Sub-agents' },
  { id: 'gate', title: 'Permissions' },
  { id: 'cache', title: 'Cache health' },
  { id: 'turn', title: 'Last turn' },
  { id: 'log', title: 'Activity' },
]
const SECTION_IDS = SECTIONS.map(s => s.id)
export const defaultLayout = (): Layout => ({ order: [...SECTION_IDS], hidden: [] })

// The limits set in settings: each moves by its step, with no upper end and nothing below one step. Memory is chars of the
// memory index (green to Good, orange to Fine, red past it, the bar Bar wide); context and plan limits
// are percents (orange from Warn, red from Bad); requests per turn turn red past the limit.
export const TARGETS: { id: keyof Targets; label: string; value: number; step: number; min: number }[] = [
  { id: 'memGood', label: 'Memory index: good to', value: 4200, step: 200, min: 200 },
  { id: 'memFine', label: 'Memory index: fine to', value: 5800, step: 200, min: 400 },
  { id: 'memBar', label: 'Memory index: bar width', value: 10000, step: 1000, min: 1000 },
  { id: 'ctxWarn', label: 'Context: orange from %', value: 65, step: 5, min: 5 },
  { id: 'ctxBad', label: 'Context: red from %', value: 85, step: 5, min: 10 },
  { id: 'limWarn', label: 'Plan limits: orange from %', value: 60, step: 5, min: 5 },
  { id: 'limBad', label: 'Plan limits: red from %', value: 85, step: 5, min: 10 },
  { id: 'turnMax', label: 'Requests per turn: limit', value: 15, step: 1, min: 1 },
]

// Each stored limit kept at or above its floor; anything else is dropped.
const savedTargets = (raw: unknown): Partial<Targets> => {
  const r = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
  const out: Partial<Targets> = {}
  for (const d of TARGETS) {
    const v = r[d.id]
    if (typeof v === 'number' && Number.isFinite(v)) out[d.id] = Math.max(d.min, Math.round(v))
  }
  return out
}

// The pairs that must stay apart: the lower limit, the upper one, and the least gap between them.
const ORDER: [keyof Targets, keyof Targets, number][] = [
  ['memGood', 'memFine', 200],
  ['memFine', 'memBar', 0],
  ['ctxWarn', 'ctxBad', 5],
  ['limWarn', 'limBad', 5],
]

/** The limits in force: the saved ones over the defaults, then held in order (good < fine <= bar, warn < bad).
 * Only what the person set is stored; a limit carried up by another is worked out here, so it comes back down with it. */
export const targetsOf = (l: Layout): Targets => {
  const t = { ...(Object.fromEntries(TARGETS.map(d => [d.id, d.value])) as Targets), ...savedTargets(l.targets) }
  for (const [lo, hi, gap] of ORDER) t[hi] = Math.max(t[hi], t[lo] + gap)
  return t
}

/** Whether one step of a limit is allowed: down stops at its floor and at the limit below it; up always goes,
 * carrying the limit above it along (see targetsOf). */
export const canStep = (l: Layout, id: keyof Targets, by: 1 | -1): boolean => {
  const d = TARGETS.find(x => x.id === id)
  if (!d) return false
  const t = targetsOf(l)
  const v = t[id] + by * d.step
  if (v < d.min) return false
  for (const [lo, hi, gap] of ORDER) if (hi === id && by === -1 && v < t[lo] + gap) return false
  return true
}

// Only the limits that differ from the defaults are kept, so a later change of a default reaches everyone who left it.
const changedTargets = (saved: Partial<Targets>) => {
  const out: Partial<Targets> = {}
  for (const d of TARGETS) if (saved[d.id] !== undefined && saved[d.id] !== d.value) out[d.id] = saved[d.id]
  return Object.keys(out).length > 0 ? { targets: out } : {}
}

/** Any stored value made a valid layout: known ids once each, in their saved order, new sections last. */
export const cleanLayout = (raw: unknown): Layout => {
  const r = (raw ?? {}) as { order?: unknown; hidden?: unknown; hideCacheBar?: unknown; theme?: unknown; targets?: unknown }
  const ids = (x: unknown) => (Array.isArray(x) ? x.filter((id): id is string => typeof id === 'string' && SECTION_IDS.includes(id)) : [])
  const order = [...new Set(ids(r.order))]
  return {
    order: [...order, ...SECTION_IDS.filter(id => !order.includes(id))],
    hidden: [...new Set(ids(r.hidden))],
    ...(r.hideCacheBar === true ? { hideCacheBar: true } : {}),
    ...(typeof r.theme === 'string' && r.theme in THEMES ? { theme: r.theme } : {}),
    ...changedTargets(savedTargets(r.targets)),
  }
}

/** A message from the section chips: tick one, or move one to a new place. Anything else leaves it as it was. */
export const applyLayoutMessage = (l: Layout, data: unknown): Layout => {
  const d = (data ?? {}) as { toggle?: unknown; move?: { id?: unknown; to?: unknown }; flag?: unknown; theme?: unknown; target?: unknown }
  // A limit one step up or down ({ target: { id, by: 1 | -1 } }), or all back to the defaults ({ target: 'reset' }).
  if (d.target === 'reset') {
    const { targets: _, ...rest } = l
    return rest
  }
  const tg = d.target as { id?: unknown; by?: unknown } | undefined
  const def = TARGETS.find(x => x.id === tg?.id)
  if (def && (tg?.by === 1 || tg?.by === -1)) {
    if (!canStep(l, def.id, tg.by)) return l
    const { targets: _, ...rest } = l
    return { ...rest, ...changedTargets({ ...savedTargets(l.targets), [def.id]: targetsOf(l)[def.id] + tg.by * def.step }) }
  }
  if (d.flag === 'cacheBar') {
    const { hideCacheBar, ...rest } = l
    return hideCacheBar ? rest : { ...rest, hideCacheBar: true }
  }
  // A theme id picks it; null goes back to the app's own colours.
  if (d.theme === null || (typeof d.theme === 'string' && d.theme in THEMES)) {
    const { theme: _, ...rest } = l
    return d.theme === null ? rest : { ...rest, theme: d.theme as string }
  }
  if (typeof d.toggle === 'string' && l.order.includes(d.toggle)) {
    const id = d.toggle
    return { ...l, hidden: l.hidden.includes(id) ? l.hidden.filter(x => x !== id) : [...l.hidden, id] }
  }
  const id = d.move?.id
  const to = d.move?.to
  if (typeof id === 'string' && typeof to === 'number' && Number.isInteger(to) && l.order.includes(id)) {
    const rest = l.order.filter(x => x !== id)
    const at = Math.max(0, Math.min(rest.length, to))
    return { ...l, order: [...rest.slice(0, at), id, ...rest.slice(at)] }
  }
  return l
}

// ---- themes: a palette laid over the drawn tree. Without one the pane keeps the app's own colours.
// Frostwerk: Blueprint's theme of that name (brand_tokens), its oklch values as hex.
// Reader: the Blueprint Reader page's paper, ink and slate.
type Theme = {
  name: string
  bg: string
  card: string
  fg: string
  muted: string
  border: string
  /** theme keys the pane names, and what each becomes */
  keys: Record<string, string>
}
export const THEMES: Record<string, Theme> = {
  frostwerk: {
    name: 'Frostwerk',
    bg: '#02060d', card: '#070e17', fg: '#e8ebef', muted: '#848d98', border: '#222933',
    keys: {
      claude: '#00c2e8', suggestion: '#00c2e8', success: '#4bc98f', warning: '#fb7c00', error: '#db4241',
      text: '#b9d3db', merged: '#9e91e4', bashBorder: '#fb7c00', planMode: '#5b748e', inactive: '#848d98', permission: '#9e91e4',
    },
  },
  reader: {
    name: 'Reader',
    bg: '#efe8db', card: '#f7f3ea', fg: '#2f2c28', muted: '#8b8375', border: '#d8cebc',
    keys: {
      claude: '#46545c', suggestion: '#46545c', success: '#5b7a4a', warning: '#8a5a1f', error: '#a1463a',
      text: '#5e584f', merged: '#7a5e86', bashBorder: '#a1463a', planMode: '#4f7470', inactive: '#b3aa9a', permission: '#6a6f94',
    },
  },
}

type Node = { type?: string; props?: Record<string, unknown>; children?: unknown[] } | string | null | undefined | false
/**
 * The tree drawn in a theme: every Text takes the theme's ink (dim text its muted ink), named colours
 * become the theme's, and a bordered Box becomes a card. Pure: returns a new tree.
 */
export const paint = <T>(node: T, t: Theme): T => {
  if (Array.isArray(node)) return node.map(c => paint(c, t)) as T
  const n = node as Node
  if (!n || typeof n !== 'object') return node
  const props = { ...(n.props ?? {}) }
  const map = (c: unknown) => (typeof c === 'string' ? (t.keys[c] ?? c) : c)
  if (n.type === 'Text') {
    if (props.color !== undefined) props.color = map(props.color)
    else props.color = props.dimColor ? t.muted : t.fg
    if (props.dimColor) {
      if (props.color === t.fg) props.color = t.muted
      delete props.dimColor
    }
    if (props.backgroundColor !== undefined) props.backgroundColor = map(props.backgroundColor)
  } else if (n.type === 'Box') {
    if (props.borderStyle !== undefined) {
      props.borderColor = props.borderColor !== undefined ? map(props.borderColor) : t.border
      delete props.borderDimColor
      props.backgroundColor = t.card
    } else if (props.backgroundColor !== undefined) props.backgroundColor = map(props.backgroundColor)
  }
  const hover = props.hover as Record<string, unknown> | undefined
  if (hover && typeof hover === 'object') {
    const h2 = { ...hover }
    delete h2.borderDimColor
    if (h2.color !== undefined) h2.color = map(h2.color)
    if (h2.borderColor !== undefined) h2.borderColor = map(h2.borderColor)
    props.hover = h2
  }
  const out: Record<string, unknown> = { ...n, props }
  if (n.children !== undefined) out.children = paint(n.children, t)
  if (props.children !== undefined) props.children = paint(props.children, t)
  return out as T
}
