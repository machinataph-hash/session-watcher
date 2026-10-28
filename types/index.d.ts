// `usd` is the list-price estimate of the tokens; the pane scales it to the engine's real cost.
// `cacheWrite` is every cache write; `cacheWrite1h` the part written to the one-hour cache (absent in usage stored before 0.2.0).
export type Usage = { input: number; cacheWrite: number; cacheWrite1h?: number; cacheRead: number; output: number; calls: number; usd: number }
export type Row = { id: string; who: string; type: string; models: string[]; usage: Usage }
export type Task = { label: string; startedAt: number; endedAt?: number; main: Row; agents: Row[] }
// Active time: `hist` is what the transcript held when last read; `ms` and `since` add the turns since.
export type Active = { hist: number; ms: number; since: number | null; turns: string[] }
export type Call = {
  at: number
  task: string
  who: string
  model: string
  effort: string
  input: number
  cacheWrite: number
  cacheRead: number
  output: number
  usd: number
}

/** The whole session as its transcripts hold it (main + every sub-agent), one entry per model. */
export type Scan = { at: number; byModel: Record<string, { main: Usage; agents: Usage }>; costUsd?: number | null; cache?: CacheHealth }

/** Where the cache cost comes from, read from the transcripts. A rebuild is a main-thread request writing over 50k tokens. */
export type Rebuild = { at: number; tokens: number; why: 'start' | 'idle' | 'summary' | 'other' }
export type CacheHealth = {
  /** the context of the session's first request */
  first: number
  /** the latest 20 rebuilds, oldest first */
  rebuilds: Rebuild[]
  rebuildCount: number
  rebuildTokens: number
  /** characters in the project's memory index (memory/MEMORY.md); null when there is none */
  memoryChars: number | null
  /** the 10 largest tool results so far, largest first */
  tools: { name: string; chars: number; at: number }[]
}

export type Limit = {
  kind: string
  pct: number
  resetsAt: number | null
  /** two-decimal estimate from the spend since the last percent step; null until learned */
  est?: number | null
}
export type Vitals = {
  model: string
  effort: string
  mode: string
  ctxTokens: number | null
  ctxWindow: number
  /** the window the session compacts at (settings' autoCompactWindow), 0 until read */
  ctxLimit: number
  ctxPct: number | null
  costUsd: number | null
  limits: Limit[]
  compactions: number
  ttftMs: number | null
  isRunning: boolean
}

export type AgentCard = {
  id: string
  type: string
  model: string
  description: string
  status: 'running' | 'done' | 'stopped' | 'failed'
  spawnedAt: number
  endedAt: number | null
  ctx: number
  out: number
  steps: number
  lastTool: string
}

export type Bucket = 'file' | 'shell' | 'web' | 'agent' | 'other'
export type Tally = { allowed: number; asked: number; denied: number }
export type Check = { at: number; tool: string; bucket: Bucket; verdict: 'allowed' | 'asked' | 'denied'; detail: string }
export type Gate = { totals: Record<Bucket, Tally>; recent: Check[] }

export type Turn = { startedAt: number; edits: number; errors: number; tools: number; costAtStart: number | null }
export type Receipt = { durationMs: number; agents: number; edits: number; errors: number; tools: number; costDelta: number | null; reason: string }

/** The pane's sections in order, and those ticked off; Vitals is always shown and not listed. */
export type Layout = { order: string[]; hidden: string[] }
export type LogLine = { at: number; who: string; text: string; kind: 'info' | 'error' | 'done' }

declare module 'claude-code' {
  interface PluginState {
    'session-watcher': {
      tasks: Task[]
      calls: Call[]
      active: Active
      scan: Scan
      vitals: Vitals
      agents: AgentCard[]
      gate: Gate
      turn: Turn
      receipt: Receipt | null
      log: LogLine[]
      sections: string[]
      layout: Layout
      taskToggles: number[]
      copied: string
    }
  }
}
