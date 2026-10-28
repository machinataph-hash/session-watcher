import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { LimitModel } from './core'
import type { Active, AgentCard, Bucket, CacheHealth, Call, Check, Gate, Layout, Limit, LogLine, Receipt, Row, Scan, Task, Turn, Usage, Vitals } from '../types'
import {
  BUCKETS,
  EDIT_TOOLS,
  breakdownText,
  bucketOf,
  clock,
  csv,
  describe,
  dur,
  empty,
  emptyGate,
  SECTIONS,
  THEMES,
  paint,
  applyLayoutMessage,
  cleanLayout,
  defaultLayout,
  emptyLimitModel,
  estimateLimit,
  factorOf,
  familyOf,
  stepLimitModel,
  fresh,
  fromModel,
  hhmm,
  k,
  modelName,
  newTask,
  priceScan,
  rowUse,
  scanTotal,
  shorten,
  sum,
  taskTotal,
  untilReset,
  usd,
  weighted,
  when,
  writeCost,
} from './core'

const NAME = 'session-watcher'
const PANE = 'session-watcher'
const TOOL = 'mark_task'
// token-use's tool: a mark made through it starts a task here too.
const OLD_TOOL = 'mcp__token-use__mark_task'
const BREAKDOWN_TOOL = 'context_breakdown'

const tasks = atom({ plugin: 'session-watcher', key: 'tasks' } as const, [] as Task[])
const calls = atom({ plugin: 'session-watcher', key: 'calls' } as const, [] as Call[])
const active = atom({ plugin: 'session-watcher', key: 'active' } as const, { hist: 0, ms: 0, since: null, turns: [] } as Active)
const scan = atom({ plugin: 'session-watcher', key: 'scan' } as const, { at: 0, byModel: {}, costUsd: null } as Scan)
const DEFAULT_VITALS: Vitals = {
  model: '',
  effort: '',
  mode: '',
  ctxTokens: null,
  ctxWindow: 0,
  ctxLimit: 0,
  ctxPct: null,
  costUsd: null,
  limits: [],
  compactions: 0,
  ttftMs: null,
  isRunning: false,
}
const vitals = atom({ plugin: 'session-watcher', key: 'vitals' } as const, DEFAULT_VITALS)
const agents = atom({ plugin: 'session-watcher', key: 'agents' } as const, [] as AgentCard[])
const gate = atom({ plugin: 'session-watcher', key: 'gate' } as const, emptyGate() as Gate)
const turn = atom({ plugin: 'session-watcher', key: 'turn' } as const, { startedAt: 0, edits: 0, errors: 0, tools: 0, costAtStart: null } as Turn)
const receipt = atom({ plugin: 'session-watcher', key: 'receipt' } as const, null as Receipt | null)
const log = atom({ plugin: 'session-watcher', key: 'log' } as const, [] as LogLine[])
// The sections that are open. Vitals always shows; the rest start as listed here.
const DEFAULT_OPEN = ['session', 'tasks']
// kept in the same list as the open sections: present means the Vitals stats row is folded away
const VITALS_FOLDED = 'vitals-folded'
// Cache health limits: past either, a line in the Vitals card says so.
const MEMORY_MAX = 4200
// The memory index bar: 10k wide, green to 4,200, orange to 5,800, red past it.
const MEMORY_BAR = 10000
const MEMORY_RED = 5800
const TURN_MAX = 15
const sections = atom({ plugin: 'session-watcher', key: 'sections' } as const, DEFAULT_OPEN)
// present in the same list: the settings under Vitals are open
const SETTINGS_OPEN = 'settings-open'
// Which sections show and in what order; kept in the store too, so every session starts with it.
const layout = atom({ plugin: 'session-watcher', key: 'layout' } as const, defaultLayout() as Layout)
const LAYOUT = 'layout'
const CHIPS = 'section-chips'
const OPTIONS = 'settings-options'
// A pressable title drawn on its own surface: press:sec:<section id> or press:task:<startedAt>.
const PRESS = 'press:'
// Tasks whose open state differs from their default (the current task starts open, earlier ones closed).
const taskToggles = atom({ plugin: 'session-watcher', key: 'taskToggles' } as const, [] as number[])
const copied = atom({ plugin: 'session-watcher', key: 'copied' } as const, '')

const activeMs = (a: Active, now: number) => (a.hist ?? 0) + a.ms + (a.since === null ? 0 : now - a.since)

const say = async ($: EngineInterface, who: string, text: string, kind: LogLine['kind'] = 'info') => {
  const at = await $.clock.now()
  await update($, log, l => [...l, { at, who, text, kind }].slice(-100))
}

const limitOf = (l: { kind: string; percentUsed: number; resetsAt?: string }): Limit => ({
  kind: l.kind,
  pct: l.percentUsed,
  resetsAt: l.resetsAt ? Date.parse(l.resetsAt) || null : null,
})

// Every reading feeds the shared limit model (all sessions' spend), one write at a time in this process,
// and comes back with each limit's two-decimal estimate.
const LIMIT_MODEL = 'limitModel'
let limitQueue: Promise<unknown> = Promise.resolve()
const withEstimates = ($: EngineInterface, cost: number | null, readings: Limit[]): Promise<Limit[]> => {
  // A store that never answers must not hold up the readings: past two seconds the plain limits show.
  const timeout = $.clock.sleep(2000).then(() => Promise.reject(new Error('store timed out')))
  const run = limitQueue.then(() => Promise.race([timeout, (async () => {
    const id = await $.session.id().catch(() => '')
    const now = await $.clock.now()
    const was = ((await $.store.get(LIMIT_MODEL)) as LimitModel | undefined) ?? emptyLimitModel()
    const m = stepLimitModel(was, id, cost, readings, now)
    await $.store.set(LIMIT_MODEL, m)
    return readings.map(l => ({ ...l, est: estimateLimit(m, l) }))
  })()]))
  limitQueue = run.catch(() => undefined)
  return run.catch(() => readings)
}

// The context limit is the compaction window when settings set one (autoCompactWindow), else the model's window.
// Only the breakdown carries it; `summary` estimates locally and sends no request, so it is read once a session.
const readUsage = async ($: EngineInterface, withLimit = false) => {
  const u = await $.session.usage(withLimit ? { breakdown: 'summary' } : undefined).catch(() => null)
  if (!u) return
  const limit = u.context.breakdown?.rawMaxTokens
  const limits = await withEstimates($, u.cost?.usd ?? null, u.rateLimits.map(limitOf))
  await update($, vitals, v => ({
    ...v,
    ...(limit ? { ctxLimit: limit } : {}),
    ctxTokens: u.context.tokens ?? null,
    ctxWindow: u.context.window,
    ctxPct: u.context.percent ?? null,
    costUsd: u.cost?.usd ?? null,
    limits,
  }))
}

// Reads the whole session (main and every sub-agent) from its transcripts: token use and active time.
const readTranscript = async ($: EngineInterface) => {
  const at = await $.clock.now()
  const id = await $.session.id().catch(() => '')
  if (!id) return
  const r = await $.process.run(['python3', '-I', `${$.plugin.root}/hooks/scan.py`, id], { timeoutMs: 120000 }).catch(() => null)
  if (!r || r.exitCode !== 0) return
  let got: { ms?: number; byModel?: Scan['byModel']; cache?: CacheHealth; missing?: boolean }
  try {
    got = JSON.parse(r.stdout)
  } catch {
    return
  }
  if (got.missing || !got.byModel) return
  const byModel = got.byModel
  const cost = await $.session.usage().then(u => u.cost?.usd ?? null).catch(() => null)
  await update($, scan, () => priceScan({ at, byModel, costUsd: cost, cache: got.cache }))
  await update($, active, a => ({ ...a, hist: got.ms ?? 0, ms: 0, since: a.turns.length > 0 ? at : null }))
}

const startTask = async ($: EngineInterface, raw: unknown) => {
  const label = String(raw ?? '').trim() || 'Unlabelled'
  const now = await $.clock.now()
  const ended = (await read($, tasks)).at(-1)
  await update($, tasks, l =>
    [...l.map((t, i) => (i === l.length - 1 ? { ...t, endedAt: now } : t)), newTask(label, Math.max(now, (l.at(-1)?.startedAt ?? -1) + 1))].slice(-50),
  )
  return { label, ended }
}

const line = (u: Usage) =>
  `${u.calls} calls · fresh ${k(fresh(u))} (in ${k(u.input)}, cache write ${k(u.cacheWrite)}, out ${k(u.output)}) · cache read ${k(u.cacheRead)}`

const iso = (ms: number) => new Date(ms).toISOString()

const summaryCsv = (list: Task[], factor: number) => {
  const rows: (string | number)[][] = [['task', 'started', 'who', 'type', 'models', 'calls', 'input', 'cache_write', 'cache_read', 'output', 'fresh', 'usd']]
  for (const t of list)
    for (const r of [t.main, ...t.agents]) {
      if (r.usage.calls === 0) continue
      const u = r.usage
      rows.push([t.label, iso(t.startedAt), r.who, r.type, r.models.join(' '), u.calls, u.input, u.cacheWrite, u.cacheRead, u.output, fresh(u), (u.usd * factor).toFixed(4)])
    }
  return csv(rows)
}
const callsCsv = (list: Call[], factor: number) =>
  csv([
    ['time', 'task', 'who', 'model', 'effort', 'input', 'cache_write', 'cache_read', 'output', 'usd'],
    ...list.map(c => [iso(c.at), c.task, c.who, c.model, c.effort, c.input, c.cacheWrite, c.cacheRead, c.output, (c.usd * factor).toFixed(4)]),
  ])

// Each observing hook ends in .catch: if its own bookkeeping fails, the event passes on unchanged.
export const register: Register = on => {
  // tool.check carries no agent id; the tool.call around it does.
  const callAgent = new Map<string, string | null>()
  let ticking = false

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: NAME, description: 'Session Watcher: session vitals, cost and token use', argumentHint: '[open|close|reset]' })
    await $.tool.register({
      name: TOOL,
      description:
        'Start counting tokens under a new task label (for example "A2 build"). Every later model call, main thread and sub-agents, counts toward it until the next mark_task. Returns the totals of the task that just ended.',
      inputSchema: { type: 'object', properties: { label: { type: 'string', description: 'Short task name' } }, required: ['label'] },
      isDeferred: false,
    })
    await $.tool.register({
      name: BREAKDOWN_TOOL,
      description: 'The context window broken down as /context shows it: categories, tokens per MCP server, memory files, agents, skills.',
      inputSchema: { type: 'object', properties: {} },
      isDeferred: true,
    })
    const now = await $.clock.now()
    await update($, tasks, l => (l.length === 0 ? [newTask('Unlabelled', now)] : l))
    const saved = await $.store.get(LAYOUT).catch(() => undefined)
    if (saved !== undefined) await update($, layout, () => cleanLayout(saved))
    await readUsage($, true)
    void readTranscript($)
    // The clocks move on their own, so the pane redraws each second.
    if (!ticking) {
      ticking = true
      $.clock.every(1000, () => $.ui.invalidate('ui.render'))
    }
    void $.ui.open({ id: PANE, title: 'Session Watcher' }).catch(() => undefined)
    return next(e)
  })

  // The section chips post a tick or a move, the Settings choices a pick; the new layout is saved for later sessions.
  on('ui.message', async ($, e, next) => {
    // The Settings choices post the id of the row pressed: the Cache health bar flag or a theme.
    const el = String(e.element)
    if (el.startsWith(PRESS)) {
      const [kind, id] = [el.slice(PRESS.length, el.indexOf(':', PRESS.length)), el.slice(el.indexOf(':', PRESS.length) + 1)]
      if (kind === 'sec') await update($, sections, l => (l.includes(id) ? l.filter(x => x !== id) : [...l, id]))
      else if (kind === 'task') {
        const at = Number(id)
        await update($, taskToggles, l => (l.includes(at) ? l.filter(x => x !== at) : [...l, at].slice(-60)))
      }
      return {}
    }
    const isOption = el.startsWith(OPTIONS)
    if (e.element !== CHIPS && !isOption) return next(e)
    const pick = (e.data as { pick?: unknown } | undefined)?.pick
    if (isOption && typeof pick !== 'string') return {}
    const msg = isOption ? (pick === 'cacheBar' ? { flag: 'cacheBar' } : { theme: pick === 'app' ? null : pick }) : e.data
    const l = await update($, layout, l0 => applyLayoutMessage(cleanLayout(l0), msg))
    await $.store.set(LAYOUT, l).catch(() => undefined)
    return {}
  })

  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') {
      const now = await $.clock.now()
      await update($, tasks, () => [newTask('Unlabelled', now)])
      await update($, calls, () => [])
      await update($, agents, () => [])
      await update($, gate, () => emptyGate())
      await update($, log, () => [])
      await update($, receipt, () => null)
      await update($, scan, () => ({ at: 0, byModel: {}, costUsd: null }))
      await update($, active, () => ({ hist: 0, ms: 0, since: null, turns: [] }))
    }
    return next(e)
  })

  on('command.run', { command: NAME }, async ($, e) => {
    const verb = e.args.trim().split(/\s+/)[0] || 'open'
    if (verb === 'close') {
      await $.ui.close({ id: PANE })
      return { text: 'Session Watcher closed.' }
    }
    if (verb === 'reset') {
      await update($, sections, () => DEFAULT_OPEN)
      await update($, taskToggles, () => [])
      await update($, layout, () => defaultLayout())
      await $.store.set(LAYOUT, defaultLayout()).catch(() => undefined)
      return { text: 'Session Watcher sections reset to their defaults.' }
    }
    const opened = await $.ui.open({ id: PANE, title: 'Session Watcher' })
    return { text: opened.isPlaced ? 'Session Watcher opened.' : `Session Watcher is not shown yet: ${opened.reason ?? 'no surface placed it'}` }
  })

  // A RegExp, since the tool's own name is in the generated types only once the mod has loaded.
  on('tool.call', { tool: /^mcp__session-watcher__mark_task$/ }, async ($, e) => {
    const { label, ended } = await startTask($, (e as { label?: unknown }).label)
    const f = factorOf(await read($, scan))
    const summary = ended ? `${ended.label}: ${line(taskTotal(ended))} · ${usd(taskTotal(ended).usd * f)}` : 'none'
    return { result: `Started: ${label}\nEnded: ${summary}` }
  })

  on('tool.call', { tool: /^mcp__session-watcher__context_breakdown$/ }, async $ => {
    const b = (await $.session.usage({ breakdown: 'full' })).context.breakdown
    return { result: b ? breakdownText(b) : 'No breakdown: no session is bound.' }
  })

  on('tool.call', { tool: OLD_TOOL }, async ($, e, next) => {
    const r = await next(e)
    await startTask($, (e as { label?: unknown }).label)
    return r
  }).catch(($, e, next) => next(e))

  on('classic.UserPromptSubmit', async ($, e, next) => {
    if (e.permission_mode) await update($, vitals, v => ({ ...v, mode: String(e.permission_mode) }))
    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.start', async ($, e, next) => {
    const now = await $.clock.now()
    await update($, active, a =>
      (a.turns ?? []).includes(e.turnId) ? a : { ...a, since: (a.turns ?? []).length === 0 ? now : a.since, turns: [...(a.turns ?? []), e.turnId].slice(-200) },
    )
    if (e.agentId === undefined) {
      const cost = await $.session.usage().then(u => u.cost?.usd ?? null).catch(() => null)
      await update($, turn, () => ({ startedAt: now, edits: 0, errors: 0, tools: 0, costAtStart: cost }))
      await update($, vitals, v => ({ ...v, isRunning: true }))
      if (e.text) await say($, 'you', shorten(e.text, 70))
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.step', async function* ($, e, next) {
    const agentId = e.agentId
    let ttft: number | null = null
    let result
    if (!agentId) {
      // Bookkeeping before next must never stop the request.
      await update($, vitals, v => ({ ...v, model: e.model, effort: e.effort === undefined ? v.effort : String(e.effort) })).catch(() => undefined)
      // Time to first token: the first piece of the response that is not the engine's envelope.
      const sentAt = await $.clock.now()
      const st = next(e)
      for await (const c of st) {
        if (ttft === null && c.kind !== 'engine' && c.kind !== 'stop') ttft = (await $.clock.now()) - sentAt
        yield c
      }
      result = await st.result
    } else {
      result = yield* next(e)
    }
    const usage = result?.usage
    if (!usage) return result
    if (ttft !== null) await update($, vitals, v => ({ ...v, ttftMs: ttft }))
    const u = fromModel(usage.model, usage, !agentId)
    const now = await $.clock.now()
    let who = 'main thread'
    let type = 'main'
    if (agentId) {
      const card = (await read($, agents)).find(a => a.id === agentId)
      const known = (await read($, tasks)).flatMap(t => t.agents).find(a => a.id === agentId)
      if (card) {
        who = card.description || card.type
        type = card.type
      } else if (known) {
        who = known.who
        type = known.type
      } else {
        const info = (await $.agent.list().catch(() => [])).find(a => a.id === agentId)
        who = info?.description ?? agentId.slice(0, 8)
        type = info?.type ?? 'agent'
      }
      await update($, agents, l =>
        l.map(c =>
          c.id === agentId
            ? { ...c, model: usage.model, steps: c.steps + 1, out: c.out + usage.output_tokens, ctx: usage.input_tokens + usage.cache_creation_input_tokens + usage.cache_read_input_tokens, status: 'running', endedAt: null }
            : c,
        ),
      )
    }
    const list = await read($, tasks)
    // A sub-agent stays with the task it started under, even after a new mark.
    const home = agentId ? list.findIndex(t => t.agents.some(a => a.id === agentId)) : -1
    const at = home >= 0 ? home : list.length - 1
    const label = list[at]?.label ?? 'Unlabelled'
    await update($, tasks, l =>
      l.map((t, i) => {
        if (i !== at) return t
        if (!agentId) return { ...t, main: rowUse(t.main, usage.model, u) }
        const has = t.agents.some(a => a.id === agentId)
        const rows = has
          ? t.agents.map(a => (a.id === agentId ? rowUse(a, usage.model, u) : a))
          : [...t.agents, rowUse({ id: agentId, who, type, models: [], usage: empty() }, usage.model, u)]
        return { ...t, agents: rows }
      }),
    )
    const call: Call = {
      at: now,
      task: label,
      who,
      model: usage.model,
      effort: e.effort === undefined ? '' : String(e.effort),
      input: u.input,
      cacheWrite: u.cacheWrite,
      cacheRead: u.cacheRead,
      output: u.output,
      usd: u.usd,
    }
    await update($, calls, l => [...l, call].slice(-5000))
    return result
  })

  on('session.measure', async ($, e, next) => {
    const limits = await withEstimates($, e.cost?.usd ?? null, e.rateLimits.map(limitOf))
    await update($, vitals, v => ({
      ...v,
      ctxTokens: e.context.tokens ?? null,
      ctxWindow: e.context.window,
      ctxPct: e.context.percent ?? null,
      costUsd: e.cost?.usd ?? null,
      limits,
    }))
    return next(e)
  }).catch(($, e, next) => next(e))

  on('session.compact', async ($, e, next) => {
    const done = await next(e)
    if (!e.agentId && e.trigger !== 'precompute') {
      await update($, vitals, v => ({ ...v, compactions: v.compactions + 1 }))
      await say($, 'main', `context compacted (${e.trigger})`)
    }
    return done
  }).catch(($, e, next) => next(e))

  on('tool.check', async ($, e, next) => {
    const verdict = await next(e)
    if (e.tool_use_id) {
      const check: Check = {
        at: await $.clock.now(),
        tool: e.tool,
        bucket: bucketOf(e.tool),
        verdict: verdict.decision === 'allow' ? 'allowed' : verdict.decision === 'deny' ? 'denied' : 'asked',
        detail: shorten(describe(e.tool, e.input), 80),
      }
      await update($, gate, g => {
        const t = g.totals[check.bucket] ?? { allowed: 0, asked: 0, denied: 0 }
        return { totals: { ...g.totals, [check.bucket]: { ...t, [check.verdict]: t[check.verdict] + 1 } }, recent: [...g.recent, check].slice(-20) }
      })
      if (check.verdict === 'denied') await say($, callAgent.get(e.tool_use_id) ? 'agent' : 'gate', `denied · ${check.detail}`, 'error')
    }
    return verdict
  }).catch(($, e, next) => next(e))

  on('tool.call', async ($, e, next) => {
    callAgent.set(e.tool_use_id, e.agentId ?? null)
    const ran = await next(e).finally(() => callAgent.delete(e.tool_use_id))
    const didRun = ran.deny === undefined
    const failed = didRun && ran.isError === true
    const isEdit = didRun && !failed && EDIT_TOOLS.has(e.tool)
    const text = shorten(describe(e.tool, e), 64)
    await update($, turn, t => ({ ...t, tools: t.tools + 1, edits: t.edits + (isEdit ? 1 : 0), errors: t.errors + (failed ? 1 : 0) }))
    if (e.agentId) {
      const id = e.agentId
      await update($, agents, l => l.map(c => (c.id === id ? { ...c, lastTool: text } : c)))
    }
    const who = e.agentId ? ((await read($, agents)).find(c => c.id === e.agentId)?.type ?? 'agent') : 'main'
    if (failed) await say($, who, `${text}  ✗`, 'error')
    else if (isEdit) await say($, who, text)
    return ran
  }).catch(($, e, next) => next(e))

  on('agent.spawn', async ($, e, next) => {
    const started = await next(e)
    if (started.deny !== undefined || !started.agentId) return started
    const id = started.agentId
    const now = await $.clock.now()
    const card: AgentCard = {
      id,
      type: e.name ?? e.subagentType,
      model: started.model,
      description: e.description,
      status: 'running',
      spawnedAt: now,
      endedAt: null,
      ctx: 0,
      out: 0,
      steps: 0,
      lastTool: '',
    }
    let isNew = true
    await update($, agents, l => {
      isNew = !l.some(c => c.id === id)
      return isNew ? [...l, card].slice(-40) : l.map(c => (c.id === id ? { ...c, status: 'running', endedAt: null } : c))
    })
    await say($, card.type, isNew ? `started · ${shorten(e.description, 50)}` : 'resumed')
    return started
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    const now = await $.clock.now()
    await update($, active, a => {
      if (!(a.turns ?? []).includes(e.turnId)) return a
      const turns = (a.turns ?? []).filter(id => id !== e.turnId)
      return turns.length > 0 || a.since === null ? { ...a, turns } : { ...a, turns, ms: a.ms + (now - a.since), since: null }
    })
    const id = e.agentId
    if (!id) {
      const [t, cards, cost] = await Promise.all([read($, turn), read($, agents), $.session.usage().then(u => u.cost?.usd ?? null).catch(() => null)])
      await update($, receipt, () => ({
        durationMs: e.durationMs,
        agents: cards.filter(c => c.spawnedAt >= t.startedAt).length,
        edits: t.edits,
        errors: t.errors,
        tools: t.tools,
        costDelta: cost !== null && t.costAtStart !== null ? cost - t.costAtStart : null,
        reason: e.reason,
      }))
      await update($, vitals, v => ({ ...v, isRunning: false }))
      await readUsage($)
      // The turn's end is in the transcript now, so the whole session is read again.
      void readTranscript($)
      return done
    }
    const card = (await read($, agents)).find(c => c.id === id)
    if (card) {
      const status: AgentCard['status'] = e.reason === 'answer' ? 'done' : e.reason === 'aborted' ? 'stopped' : 'failed'
      await update($, agents, l => l.map(c => (c.id === id ? { ...c, status, endedAt: now } : c)))
      await say($, card.type, status === 'done' ? `done · ${dur(e.durationMs)}` : status, status === 'done' ? 'done' : 'error')
    }
    return done
  }).catch(($, e, next) => next(e))

  // ---------------------------------------------------------------- drawing

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const ui = $.ui.resolve(e)
    const { Box, Text, Button } = ui
    // The terminal draws bars as characters; the other surfaces have a proportional font, so an SVG.
    const Svg = e.surface !== 'terminal' && 'Svg' in ui ? ui.Svg : undefined
    const [list0, log0, note, open, toggles, act, sc, v0, cards, g0, rc, lines, tn, lay0] = await Promise.all([
      read($, tasks),
      read($, calls),
      read($, copied),
      read($, sections),
      read($, taskToggles),
      read($, active),
      read($, scan),
      read($, vitals),
      read($, agents),
      read($, gate),
      read($, receipt),
      read($, log),
      read($, turn),
      read($, layout),
    ])
    const lay = cleanLayout(lay0)
    const now = await $.clock.now()
    // A session whose start was missed still has a current task to show.
    const list = list0.length > 0 ? list0 : [newTask('Unlabelled', now)]
    let g = g0
    let v = v0
    g = { totals: { ...emptyGate().totals, ...(g0?.totals ?? {}) }, recent: g0?.recent ?? [] }
    v = { ...DEFAULT_VITALS, ...v0, limits: v0?.limits ?? [] }
    const sessionStart = await $.session.usage().then(u => u.startedAt).catch(() => list[0]?.startedAt ?? now)
    // The factor comes from one snapshot: the transcript read and the engine's cost at that moment.
    const factor = factorOf(sc)
    const isCalibrated = (sc.costUsd ?? null) !== null && scanTotal(sc).usd > 0
    const cols = Math.max(28, e.props.bodyColumns || 60)
    // Inside a section: its border and one cell of padding on each side.
    const inner = cols - 4
    const isWide = inner >= 50
    const isNarrow = inner < 38

    const heading = (key: string, text: string) => (
      <Text key={key} bold dimColor wrap="truncate-end">
        {text}
      </Text>
    )
    const cell = (key: string, w: number, node: unknown, right = true) => (
      <Box key={key} width={w} flexShrink={0} justifyContent={right ? 'flex-end' : 'flex-start'}>
        {node as never}
      </Box>
    )
    const n = (value: string, opts: { bold?: boolean; dim?: boolean; color?: 'claude' | 'error' | 'success' | 'warning' } = {}) => (
      <Text tabular size="footnote" bold={opts.bold} weight={opts.bold ? 'semibold' : undefined} dimColor={opts.dim} color={opts.color}>
        {value}
      </Text>
    )

    type BarColor = 'claude' | 'suggestion' | 'success' | 'warning' | 'error' | 'text' | 'merged' | 'bashBorder' | 'planMode' | 'inactive' | 'permission'
    const theme = lay.theme ? THEMES[lay.theme] : undefined
    const HEX: Record<BarColor, string> = {
      claude: '#d4683f', suggestion: '#4f8fe0', success: '#2fa84f', warning: '#e09b2d', error: '#d64545',
      text: '#6b6b6b', merged: '#8e5bd6', bashBorder: '#e0569f', planMode: '#23968a', inactive: '#a8a8a8', permission: '#7c83f2',
      ...(theme?.keys ?? {}),
    }
    const KINDS = [
      { field: 'input', name: 'input', cost: (u: Usage) => u.input, color: 'success' },
      { field: 'cacheWrite', name: 'cache write', cost: writeCost, color: 'warning' },
      { field: 'cacheRead', name: 'cache read', cost: (u: Usage) => u.cacheRead * 0.1, color: 'error' },
      { field: 'output', name: 'output', cost: (u: Usage) => u.output * 5, color: 'claude' },
    ] as const
    const FAMILY: Record<string, BarColor> = { fable: 'merged', mythos: 'merged', opus: 'bashBorder', sonnet: 'planMode', haiku: 'inactive', other: 'permission' }
    const whoColor = (r: Row): BarColor => (r.type === 'main' ? 'text' : (FAMILY[familyOf(r.models[0] ?? '')] ?? 'permission'))

    // Whole cells per part by largest remainder, so they add up to exactly `cells`; with `track`, the rest is dim.
    const cellsOf = (values: number[], total: number, track: boolean) => {
      const sumv = track ? 1 : values.reduce((a, b) => a + b, 0)
      if (sumv <= 0) return values.map(() => 0)
      const exact = values.map(x => (total * x) / sumv)
      if (track) return exact.map(x => Math.min(total, x > 0 ? Math.max(1, Math.round(x)) : 0))
      const out = exact.map(x => (x > 0 ? Math.max(1, Math.floor(x)) : 0))
      let left = total - out.reduce((a, b) => a + b, 0)
      const order = exact.map((x, i) => ({ i, r: x - Math.floor(x) })).sort((a, b) => b.r - a.r)
      for (let j = 0; left > 0 && order.length > 0; j++, left--) out[order[j % order.length]!.i]! += 1
      while (left < 0) {
        out[out.indexOf(Math.max(...out))]! -= 1
        left++
      }
      return out
    }
    const strip = (key: string, parts: { value: number; color: BarColor }[], opts: { track?: boolean; cells: number; svgCells?: number }) => {
      const track = opts.track ?? false
      const cellsN = Math.max(1, opts.cells)
      if (!Svg) {
        const c = cellsOf(parts.map(p => p.value), cellsN, track)
        const used = c.reduce((a, b) => a + b, 0)
        return (
          <Text key={key} wrap="truncate-end">
            {parts.map((p, i) => (
              <Text key={String(i)} color={p.color}>
                {'█'.repeat(c[i] ?? 0)}
              </Text>
            ))}
            {track && <Text dimColor>{'░'.repeat(Math.max(0, cellsN - used))}</Text>}
          </Text>
        )
      }
      // A continuous bar: one rect per part, rounded track. The markup is wider than any pane
      // so the drawing stretches down to the row's own width.
      const W = 1000
      const tot = track ? 1 : parts.reduce((a, p) => a + p.value, 0) || 1
      let x = 0
      const rects = parts
        .map(p => {
          const w = Math.max(0, Math.min(W - x, (W * p.value) / tot))
          const r = `<rect x="${x.toFixed(1)}" y="0" width="${w.toFixed(1)}" height="8" fill="${HEX[p.color]}"/>`
          x += w
          return r
        })
        .join('')
      const source = `<svg xmlns="http://www.w3.org/2000/svg" width="4000" height="8" viewBox="0 0 ${W} 8" preserveAspectRatio="none"><clipPath id="c"><rect width="${W}" height="8" rx="4" ry="4"/></clipPath><g clip-path="url(#c)"><rect width="${W}" height="8" fill="#8a8a8a" fill-opacity="0.18"/>${rects}</g></svg>`
      return (
        <Box key={key} flexGrow={1} flexShrink={1} minWidth={0} overflow="hidden">
          <Svg source={source} alt={parts.map(p => `${p.color} ${Math.round(p.value * 100) / 100}`).join(', ')} height={8} />
        </Box>
      )
    }

    // A legend square in the bar's own color: on the desktop the bars use HEX, so the square does too.
    const swatch = (color: BarColor) =>
      Svg ? (
        <Box height={1} alignItems="center">
          <Svg source={`<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8" viewBox="0 0 8 8"><rect width="8" height="8" rx="2" fill="${HEX[color]}"/></svg>`} alt={color} height={8} />
        </Box>
      ) : (
        <Text color={color}>■</Text>
      )
    // The split bar in a row one line tall with the bar centered, as each KIND row draws its bar.
    const splitRow = (parts: { value: number; color: BarColor }[], cells: number) => (
      <Box key="split" flexDirection="row" alignItems="center">
        <Text> </Text>
        <Box flexGrow={1} flexShrink={1} minWidth={0}>
          {strip('split', parts, { cells: cells - 1 })}
        </Box>
      </Box>
    )

    const isOpen = (id: string) => open.includes(id)
    const flip = (id: string) => update($, sections, l => (l.includes(id) ? l.filter(x => x !== id) : [...l, id]))
    // A clickable title. Under a theme on a surface with Clients it is drawn on its own surface in
    // the theme's colours (a Button would keep the app's ink); otherwise it is a plain Button.
    type R = { text: string; color?: string; dim?: boolean; bold?: boolean; size?: string }
    // width: a fixed width for a short control (the cog); titles fill the row they sit in.
    const pressable = (key: string, runs: R[], onPress: () => void, width?: number) => {
      const Client = 'Client' in ui ? ui.Client : undefined
      if (theme && Client) {
        const ink = (r: R) => (r.color ? (theme.keys[r.color] ?? r.color) : r.dim ? theme.muted : theme.fg)
        return <Client key={key} {...(width ? { width } : {})} module="./press.tsx" props={{ bg: theme.card, runs: runs.map(r => ({ text: r.text, color: ink(r), ...(r.bold ? { bold: true } : {}) })) }} height={1} />
      }
      return (
        <Button key={key} plain onPress={onPress}>
          {runs.map((r, i) => <Text key={`r${i}`} color={r.color} dimColor={r.dim} bold={r.bold} size={r.size as never}>{r.text}</Text>)}
        </Button>
      )
    }

    // One collapsible section: a header row that opens and closes it, a one-line summary while closed.
    const section = (id: string, title: string, summary: string, body: () => unknown, accent = false) => {
      const o = isOpen(id)
      return (
        <Box key={id} flexDirection="column" borderStyle="round" borderColor={accent ? 'claude' : undefined} borderDimColor={!accent} paddingX={1} gap={o ? 1 : 0} hover={{ borderDimColor: false }}>
          <Box key="head" flexDirection="row" gap={1} alignItems="center">
            <Box flexGrow={1} flexShrink={1} minWidth={0}>
              {pressable(theme ? `${PRESS}sec:${id}` : `sec-${id}`, [{ text: o ? '▾ ' : '▸ ', dim: true }, { text: title, bold: true, color: accent ? 'claude' : undefined }], () => void flip(id))}
            </Box>
            {summary !== '' && (
              <Box flexShrink={1} minWidth={0}>
                <Text dimColor tabular wrap="truncate-end">
                  {summary}
                </Text>
              </Box>
            )}
          </Box>
          {o && (
            <Box key="body" flexDirection="column" gap={1}>
              {body() as never}
            </Box>
          )}
        </Box>
      )
    }

    // One row when wide: the columns spread edge to edge, the last one ending at the right edge.
    // Narrower, they wrap as halves or full rows.
    const statW = isWide ? undefined : isNarrow ? '100%' : '50%'
    const stat3 = isNarrow ? '100%' : undefined
    const stat = (key: string, label: string, value: string, opts: { color?: 'claude' | 'error' | 'warning' | 'success'; sub?: string; w?: string } = {}) => (
      <Box key={key} flexDirection="column" width={opts.w ?? statW} flexShrink={0}>
        {heading('l', label)}
        <Text size="heading" weight="semibold" bold tabular color={opts.color} wrap="truncate-end">
          {value}
        </Text>
        {opts.sub ? (
          <Text size="footnote" dimColor tabular wrap="truncate-end">
            {opts.sub}
          </Text>
        ) : null}
      </Box>
    )
    const stats = (key: string, items: unknown[]) => (
      <Box key={key} flexDirection="row" flexWrap={isWide ? 'nowrap' : 'wrap'} justifyContent={isWide ? 'space-between' : 'flex-start'} columnGap={2} rowGap={1}>
        {items as never}
      </Box>
    )

    // Until the first transcript read lands, the totals are what this mod counted live.
    const total = sc.at > 0 ? scanTotal(sc) : list.reduce((acc, t) => sum(acc, taskTotal(t)), empty())

    // ---- vitals: always shown
    // Measured against the limit the session actually compacts at; the engine's own percent is against the model's window.
    const ctxMax = v.ctxLimit > 0 ? v.ctxLimit : v.ctxWindow
    const ctxPct = v.ctxTokens !== null && ctxMax > 0 ? Math.round((100 * v.ctxTokens) / ctxMax) : v.ctxLimit > 0 ? null : v.ctxPct
    const ctxColor: BarColor = ctxPct === null ? 'inactive' : ctxPct >= 85 ? 'error' : ctxPct >= 65 ? 'warning' : 'success'
    const runFor = now - sessionStart
    const actMs = activeMs(act, now)
    // ---- cache health: read from the transcripts; requests this turn from the live log
    const ch = sc.cache
    const turnReqs = tn && tn.startedAt > 0 ? log0.filter(c => c.who === 'main thread' && c.at >= tn.startedAt).length : 0
    const memColor: BarColor = !ch || ch.memoryChars === null ? 'inactive' : ch.memoryChars > MEMORY_RED ? 'error' : ch.memoryChars > MEMORY_MAX ? 'warning' : 'success'
    const memWord = memColor === 'error' ? 'Bad' : memColor === 'warning' ? 'Fine' : 'Good'
    const cacheWarnings = [
      ...(ch && ch.memoryChars !== null && ch.memoryChars > MEMORY_MAX ? [`memory index ${k(ch.memoryChars)} chars (target ${MEMORY_MAX.toLocaleString('en-US')})`] : []),
    ]
    // The title folds away the stats row (cost, running for, active, requests); Session totals keeps cost and requests.
    const vitalsOpen = !isOpen(VITALS_FOLDED)
    const settingsOpen = isOpen(SETTINGS_OPEN)
    // The warning line takes the memory index's colour when that is what is over; else orange.
    const warnColor: BarColor = memColor === 'error' || memColor === 'warning' ? memColor : 'warning'
    const setLayout = (msg: unknown) => update($, layout, l => applyLayoutMessage(cleanLayout(l), msg)).then(l => $.store.set(LAYOUT, l)).catch(() => undefined)
    const titleOf = (id: string) => SECTIONS.find(x => x.id === id)?.title ?? id
    const chipItems = lay.order.map(id => ({ id, title: titleOf(id), isShown: !lay.hidden.includes(id) }))
    // Dragging needs a Client; a surface without one (mobile) moves a section up a place by its arrow.
    const Client = 'Client' in ui ? ui.Client : undefined
    const palette = theme ? { palette: { bg: theme.card, fg: theme.fg, muted: theme.muted, accent: theme.keys.claude ?? theme.fg } } : {}
    const themeChoices = [{ id: 'app', name: 'Original' }, ...Object.entries(THEMES).map(([id, t]) => ({ id, name: t.name }))]
    const options = (key: string, items: { id: string; mark: string; label: string; isOn: boolean }[]) =>
      Client ? <Client key={key} module="./options.tsx" props={{ items, ...palette }} height={items.length} /> : null
    const chips = Client ? (
      <Client key={CHIPS} module="./chips.tsx" props={{ items: chipItems, ...palette }} height={chipItems.length} />
    ) : (
      <Box key="chips" flexDirection="column">
        {chipItems.map((it, i) => (
          <Box key={it.id} flexDirection="row" gap={1}>
            <Button key={`chip-${it.id}`} plain onPress={() => void update($, layout, l => applyLayoutMessage(cleanLayout(l), { toggle: it.id })).then(l => $.store.set(LAYOUT, l)).catch(() => undefined)}>
              <Text dimColor={!it.isShown}>{`${it.isShown ? '☑' : '☐'} ${it.title}`}</Text>
            </Button>
            {i > 0 && (
              <Button key={`up-${it.id}`} plain onPress={() => void update($, layout, l => applyLayoutMessage(cleanLayout(l), { move: { id: it.id, to: i - 1 } })).then(l => $.store.set(LAYOUT, l)).catch(() => undefined)}>
                <Text dimColor>↑</Text>
              </Button>
            )}
          </Box>
        ))}
      </Box>
    )
    const vitalsCard = (
      <Box key="vitals" flexDirection="column" borderStyle="round" borderColor="claude" paddingX={1} gap={1}>
        <Box key="title" flexDirection="row" flexWrap="wrap" columnGap={2} justifyContent="space-between">
          <Box flexGrow={1} flexShrink={1} minWidth={0}>
          {pressable(theme ? `${PRESS}sec:${VITALS_FOLDED}` : 'sec-vitals', [
            { text: '● ', color: v.isRunning ? 'claude' : 'success', bold: true },
            { text: v.model ? modelName(v.model) : 'Session', bold: true },
            ...(v.effort ? [{ text: ` · ${v.effort}`, dim: true }] : []),
            ...(v.mode ? [{ text: ` · ${v.mode}`, dim: true }] : []),
          ], () => void flip(VITALS_FOLDED))}
          </Box>
          <Text dimColor tabular>
            {v.isRunning ? 'working' : 'idle'}
            {v.ttftMs !== null ? ` · first token ${dur(v.ttftMs)}` : ''}
          </Text>
        </Box>
        <Box key="ctx" flexDirection="column">
          <Box key="h" flexDirection="row" justifyContent="space-between">
            {heading('l', `CONTEXT${v.compactions > 0 ? ` · ⟲ ${v.compactions} compacted` : ''}`)}
            <Text tabular dimColor>
              {v.ctxTokens !== null ? `${k(v.ctxTokens)} / ${k(ctxMax)}` : '—'}
              {ctxPct !== null ? <Text color={ctxColor} bold>{`  ${ctxPct}%`}</Text> : ''}
            </Text>
          </Box>
          {strip('bar', [{ value: (ctxPct ?? 0) / 100, color: ctxColor }], { track: true, cells: inner })}
        </Box>
        {vitalsOpen && stats('s1', [
          stat('cost', v.costUsd !== null ? 'COST' : 'COST (EST.)', usd(v.costUsd ?? total.usd), { color: 'claude' }),
          stat('run', 'RUNNING FOR', clock(runFor), { sub: `since ${when(sessionStart)}` }),
          stat('act', 'ACTIVE', clock(actMs), { sub: `${runFor > 0 ? Math.round((100 * actMs) / runFor) : 0}% of the time` }),
          stat('calls', 'REQUESTS', String(total.calls), { sub: `${cards.length} sub-agent${cards.length === 1 ? '' : 's'}` }),
        ])}
        {v.limits.length > 0 && (
          <Box key="limits" flexDirection="column">
            {v.limits.slice(0, 3).map(l => {
              const c: BarColor = l.pct >= 85 ? 'error' : l.pct >= 60 ? 'warning' : 'suggestion'
              const name = l.kind === 'five_hour' ? '5-hour limit' : l.kind === 'seven_day' ? '7-day limit' : l.kind.replace(/_/g, ' ')
              return (
                <Box key={l.kind} flexDirection="row" gap={1} alignItems="center">
                  <Box width={isNarrow ? 8 : 13} flexShrink={0}>
                    <Text dimColor wrap="truncate-end">{name}</Text>
                  </Box>
                  <Box flexGrow={1} flexShrink={1} minWidth={0}>
                    {strip('b', [{ value: (l.est ?? l.pct) / 100, color: c }], { track: true, cells: Math.max(4, inner - (isNarrow ? 8 : 13) - 9 - (isNarrow ? 0 : 11) - 3) })}
                  </Box>
                  {cell('p', 8, n(l.est != null ? `${l.est.toFixed(2)}%` : `${Math.round(l.pct)}%`, { bold: true }))}
                  {!isNarrow && cell('r', 10, <Text dimColor tabular size="footnote" wrap="truncate-end">{l.resetsAt ? `↻ ${untilReset(Math.max(0, l.resetsAt - now))}` : ''}</Text>)}
                </Box>
              )
            })}
          </Box>
        )}
        {!lay.hideCacheBar && ch && ch.memoryChars !== null && (
          <Box key="cache-bar" flexDirection="column">
            <Box key="row" flexDirection="row" gap={1} alignItems="center">
              <Box width={isNarrow ? 8 : 13} flexShrink={0}>
                <Text dimColor wrap="truncate-end">Cache health</Text>
              </Box>
              <Box flexGrow={1} flexShrink={1} minWidth={0}>
                {strip('b', [{ value: Math.min(1, ch.memoryChars / MEMORY_BAR), color: memColor }], { track: true, cells: Math.max(4, inner - (isNarrow ? 8 : 13) - 9 - (isNarrow ? 0 : 11) - 3) })}
              </Box>
              {cell('p', 8, <Text tabular size="footnote" bold weight="semibold" color={memColor}>{memWord}</Text>)}
              {!isNarrow && cell('r', 10, <Text dimColor tabular size="footnote" wrap="truncate-end">{k(ch.memoryChars)} chars</Text>)}
            </Box>
            <Text key="why" size="footnote" dimColor wrap="wrap">
              {`Memory index loaded into every request: ${ch.memoryChars.toLocaleString('en-US')} of ${MEMORY_BAR.toLocaleString('en-US')} chars. Good to ${MEMORY_MAX.toLocaleString('en-US')} (target), Fine to ${MEMORY_RED.toLocaleString('en-US')}, Bad past it. Start ${k(ch.first)} · ${ch.rebuildCount} rebuild${ch.rebuildCount === 1 ? '' : 's'}.`}
            </Text>
          </Box>
        )}
        <Box key="foot" flexDirection="row" gap={1} alignItems="flex-end" justifyContent="flex-end">
          {cacheWarnings.length > 0 && (
            <Box flexGrow={1} flexShrink={1} minWidth={0}>
              <Text key="cache-warn" color={warnColor} size="footnote" wrap="wrap">
                <Text size="body">⚠</Text>
                {` Cache: ${cacheWarnings.join(' · ')}. See Cache health.`}
              </Text>
            </Box>
          )}
          {pressable(theme ? `${PRESS}sec:${SETTINGS_OPEN}` : 'settings', [{ text: '⚙', color: settingsOpen ? 'claude' : undefined, dim: !settingsOpen, size: 'title' }], () => void flip(SETTINGS_OPEN), 2)}
        </Box>
        {settingsOpen && (
          <Box key="settings-body" flexDirection="column" gap={1}>
            <Text key="sep" dimColor wrap="truncate-end">{'─'.repeat(inner)}</Text>
            <Box key="cols" flexDirection="row" flexWrap="wrap" columnGap={4} rowGap={1}>
              <Box key="secs" flexDirection="column" flexShrink={0} gap={1}>
                {heading('sh', 'SECTIONS · TICK TO SHOW · DRAG TO MOVE')}
                {chips}
                {/* A desktop Button draws its label in the app's own ink, not the theme's, so only the box is
                    the Button and the label is plain Text, as in the section list. */}
                {options(`${OPTIONS}-cache`, [{ id: 'cacheBar', mark: lay.hideCacheBar ? '☐' : '☑', label: 'Cache health bar in this card', isOn: !lay.hideCacheBar }]) ?? <Box key="cache-bar-row" flexDirection="row">
                  <Button key="cache-bar-flag" plain onPress={() => void setLayout({ flag: 'cacheBar' })}>
                    <Text color={lay.hideCacheBar ? undefined : 'claude'} dimColor={lay.hideCacheBar}>{lay.hideCacheBar ? '☐' : '☑'}</Text>
                  </Button>
                  <Text dimColor={lay.hideCacheBar}>  Cache health bar in this card</Text>
                </Box>}
              </Box>
              <Box key="themes" flexDirection="column" flexShrink={0}>
                {heading('th', 'THEME')}
                {options(`${OPTIONS}-theme`, themeChoices.map(o => {
                  const isOn = (lay.theme ?? 'app') === o.id
                  return { id: o.id, mark: isOn ? '◉' : '○', label: o.name, isOn }
                })) ?? [{ id: null as string | null, name: 'Original' }, ...Object.entries(THEMES).map(([id, t]) => ({ id: id as string | null, name: t.name }))].map(o => {
                  const isOn = (lay.theme ?? null) === o.id
                  return (
                    <Box key={`theme-row-${o.id ?? 'app'}`} flexDirection="row">
                      <Button key={`theme-${o.id ?? 'app'}`} plain onPress={() => void setLayout({ theme: o.id })}>
                        <Text color={isOn ? 'claude' : undefined} dimColor={!isOn}>{isOn ? '◉' : '○'}</Text>
                      </Button>
                      <Text bold={isOn} dimColor={!isOn}>{`  ${o.name}`}</Text>
                    </Box>
                  )
                })}
              </Box>
            </Box>
          </Box>
        )}
      </Box>
    )

    // ---- token kinds: one row per kind; the bar and COST are its share of the weighted cost, then its tokens and their share
    const KIND_W = 11
    const kinds = (key: string, u: Usage, room = inner) => {
      const tokens = u.input + u.cacheWrite + u.cacheRead + u.output
      const cost = weighted(u)
      // Cost leads: the bar and COST are the kind's share of the weighted cost; after a thin line, its tokens and their share.
      // The token side (line, TOKENS, %) shows whole or not at all, so the bar keeps at least 10 cells.
      const hasTokens = room >= 44
      const barW = room - KIND_W - 1 - 6 - (hasTokens ? 2 + 8 + 6 : 0)
      const line = (k: string) => (
        <Box key={k} width={1} flexShrink={0}>
          <Text dimColor>│</Text>
        </Box>
      )
      return (
        <Box key={key} flexDirection="column">
          <Box key="head" flexDirection="row" gap={1}>
            <Box width={KIND_W} flexShrink={0}>{heading('k', 'KIND')}</Box>
            <Box flexGrow={1} flexShrink={1} minWidth={0}>{heading('b', barW >= 16 ? 'SHARE OF COST' : 'SHARE')}</Box>
            {cell('c', 5, heading('c', 'COST'))}
            {hasTokens && line('l')}
            {hasTokens && cell('t', 7, heading('t', 'TOKENS'))}
            {hasTokens && cell('p', 5, heading('p', '%'))}
          </Box>
          {KINDS.map(kd => {
            const share = tokens > 0 ? u[kd.field] / tokens : 0
            const costShare = cost > 0 ? kd.cost(u) / cost : 0
            return (
              <Box key={kd.field} flexDirection="row" gap={1} alignItems="center">
                <Box width={KIND_W} flexShrink={0}>
                  <Text dimColor>{kd.name}</Text>
                </Box>
                <Box flexGrow={1} flexShrink={1} minWidth={0}>
                  {strip('bar', [{ value: costShare, color: kd.color }], { track: true, cells: barW })}
                </Box>
                {cell('c', 5, n(`${Math.round(100 * costShare)}%`, { bold: true }))}
                {hasTokens && line('l')}
                {hasTokens && cell('t', 7, n(k(u[kd.field]), { dim: true }))}
                {hasTokens && cell('p', 5, n(`${Math.round(100 * share)}%`, { dim: true }))}
              </Box>
            )
          })}
        </Box>
      )
    }

    // ---- session totals, from the transcripts
    const byModel = Object.entries(sc.byModel)
      .flatMap(([m, x]) => [
        { id: `${m}-main`, who: 'Main thread', model: m, u: x.main, color: 'text' as BarColor },
        { id: `${m}-agents`, who: 'Sub-agents', model: m, u: x.agents, color: FAMILY[familyOf(m)] ?? ('permission' as BarColor) },
      ])
      .filter(r => r.u.calls > 0)
      .sort((a, b) => b.u.usd - a.u.usd)
    const sessionBody = () => [
      stats('s', [
        stat('c', 'REQUESTS', String(total.calls)),
        stat('f', 'FRESH', k(fresh(total))),
        stat('r', 'CACHE READ', k(total.cacheRead)),
        stat('w', 'WEIGHTED', k(weighted(total)), { color: 'claude' }),
      ]),
      kinds('kinds', total),
      byModel.length > 0 && (
        <Box key="who" flexDirection="column">
          <Box key="head" flexDirection="row" gap={1}>
            <Box width={1} flexShrink={0} />
            <Box flexGrow={1} flexShrink={1} minWidth={0}>{heading('w', 'WHO · MODEL')}</Box>
            {isWide && cell('c', 6, heading('c', 'CALLS'))}
            {cell('o', 7, heading('o', 'OUTPUT'))}
            {cell('u', 8, heading('u', 'COST'))}
          </Box>
          {byModel.map(r => (
            <Box key={r.id} flexDirection="row" gap={1}>
              <Box width={1} flexShrink={0}>
                {swatch(r.color)}
              </Box>
              <Box flexGrow={1} flexShrink={1} minWidth={0}>
                <Text wrap="truncate-end">
                  {r.who}
                  <Text dimColor>{` · ${modelName(r.model)}`}</Text>
                </Text>
              </Box>
              {isWide && cell('c', 6, n(String(r.u.calls), { dim: true }))}
              {cell('o', 7, n(k(r.u.output)))}
              {cell('u', 8, n(usd(r.u.usd * factor), { bold: true }))}
            </Box>
          ))}
          {splitRow(byModel.map(r => ({ value: r.u.usd, color: r.color })), inner)}
        </Box>
      ),
      <Text key="src" size="footnote" dimColor>
        {sc.at > 0 ? `From the transcripts, main and every sub-agent, read at ${hhmm(sc.at)} (after each turn).` : 'Reading the transcripts…'}
      </Text>,
    ]

    // ---- tasks
    const last = list.at(-1) ?? newTask('Unlabelled', now)
    const shownTasks = list.filter(t => t === last || taskTotal(t).calls > 0).slice().reverse()
    const taskOpen = (t: Task) => (t === last) !== toggles.includes(t.startedAt)
    const toggleTask = (t: Task) => update($, taskToggles, l => (l.includes(t.startedAt) ? l.filter(x => x !== t.startedAt) : [...l, t.startedAt].slice(-60)))
    const mins = (t: Task) => Math.max(0, Math.round(((t.endedAt ?? now) - t.startedAt) / 60000))
    const taskTable = (t: Task) => {
      const tw = weighted(taskTotal(t)) || 1
      const rows = [t.main, ...t.agents].filter(r => r.usage.calls > 0).sort((a, b) => b.usage.usd - a.usage.usd)
      return (
        <Box key="table" flexDirection="column">
          <Box key="head" flexDirection="row" gap={1}>
            <Box width={1} flexShrink={0} />
            <Box flexGrow={1} flexShrink={1} minWidth={0} paddingRight={1}>{heading('who', 'WHO')}</Box>
            {isWide && cell('m', 12, heading('m', 'MODEL'), false)}
            {isWide && cell('c', 6, heading('c', 'CALLS'))}
            {cell('w', 7, heading('w', 'WEIGHT'))}
            {cell('u', 8, heading('u', 'COST'))}
          </Box>
          {rows.map(r => (
            <Box key={r.id} flexDirection="row" gap={1}>
              <Box width={1} flexShrink={0}>
                {swatch(whoColor(r))}
              </Box>
              <Box flexGrow={1} flexShrink={1} minWidth={0} paddingRight={1}>
                <Text wrap="truncate-end">{r.type === 'main' ? 'Main thread' : r.who}</Text>
              </Box>
              {isWide && cell('m', 12, <Text dimColor wrap="truncate-end">{r.models.map(modelName).join(', ')}</Text>, false)}
              {isWide && cell('c', 6, n(String(r.usage.calls), { dim: true }))}
              {cell('w', 7, n(`${Math.round((100 * weighted(r.usage)) / tw)}%`, { dim: true }))}
              {cell('u', 8, n(usd(r.usage.usd * factor), { bold: true }))}
            </Box>
          ))}
          {splitRow(rows.map(r => ({ value: r.usage.usd, color: whoColor(r) })), inner - 6)}
        </Box>
      )
    }
    const taskCard = (t: Task) => {
      const u = taskTotal(t)
      const isNow = t === last
      const o = taskOpen(t)
      return (
        <Box key={`task-${t.startedAt}`} flexDirection="column" borderStyle="round" borderColor={isNow ? 'claude' : undefined} borderDimColor={!isNow} paddingX={1} gap={o ? 1 : 0}>
          <Box key="head" flexDirection="row" gap={1} alignItems="center">
            <Box flexGrow={1} flexShrink={1} minWidth={0}>
              {pressable(theme ? `${PRESS}task:${t.startedAt}` : `open-${t.startedAt}`, [
                { text: o ? '▾ ' : '▸ ', dim: true },
                { text: t.label, bold: true, color: isNow ? 'claude' : undefined },
                ...(isNow ? [{ text: '  now', dim: true }] : []),
              ], () => void toggleTask(t))}
            </Box>
            {!isNarrow && (
              <Text dimColor tabular>
                {mins(t)} min · {u.calls} calls
              </Text>
            )}
            {cell('u', 8, n(usd(u.usd * factor), { bold: true, color: isNow ? 'claude' : undefined }))}
          </Box>
          {o &&
            (u.calls > 0 ? (
              <Box key="body" flexDirection="column" gap={1}>
                {kinds('kinds', u, inner - 4)}
                {taskTable(t)}
              </Box>
            ) : (
              <Text key="body" dimColor>
                No calls yet.
              </Text>
            ))}
        </Box>
      )
    }
    const tasksBody = () => [
      <Text key="hint" size="footnote" dimColor>
        A task runs from one mark_task to the next. Click a task to open or close it.
      </Text>,
      ...shownTasks.map(taskCard),
    ]

    // ---- recent requests
    const recentCalls = log0.slice(-15).reverse()
    const requestsBody = () =>
      recentCalls.length === 0
        ? [<Text key="none" dimColor>No requests yet.</Text>]
        : [
            <Box key="head" flexDirection="row" gap={1}>
              {cell('t', 5, heading('t', 'TIME'), false)}
              <Box flexGrow={1} flexShrink={1} minWidth={0}>{heading('w', 'WHO')}</Box>
              {isWide && cell('i', 7, heading('i', 'IN+CW'))}
              {!isNarrow && cell('r', 7, heading('r', 'C.READ'))}
              {cell('o', 6, heading('o', 'OUT'))}
              {cell('u', 7, heading('u', 'COST'))}
            </Box>,
            ...recentCalls.map((c, i) => (
              <Box key={`c${i}`} flexDirection="row" gap={1}>
                {cell('t', 5, <Text dimColor tabular>{hhmm(c.at)}</Text>, false)}
                <Box flexGrow={1} flexShrink={1} minWidth={0}>
                  <Text wrap="truncate-end">
                    {c.who === 'main thread' ? 'Main' : c.who}
                    <Text dimColor>{` · ${modelName(c.model)}`}</Text>
                  </Text>
                </Box>
                {isWide && cell('i', 7, n(k(c.input + c.cacheWrite)))}
                {!isNarrow && cell('r', 7, n(k(c.cacheRead), { dim: true }))}
                {cell('o', 6, n(k(c.output)))}
                {cell('u', 7, n(usd(c.usd * factor), { bold: true }))}
              </Box>
            )),
          ]

    // ---- sub-agents
    const running = cards.filter(c => c.status === 'running').length
    const agentsBody = () =>
      cards.length === 0
        ? [<Text key="none" dimColor>No sub-agents this session.</Text>]
        : cards
            .slice()
            .reverse()
            .slice(0, 12)
            .map(c => {
              const color = c.status === 'running' ? 'claude' : c.status === 'done' ? 'success' : 'error'
              const took = (c.endedAt ?? now) - c.spawnedAt
              return (
                <Box key={c.id} flexDirection="column" borderStyle="round" borderDimColor paddingX={1}>
                  <Box key="h" flexDirection="row" gap={1}>
                    <Box flexGrow={1} flexShrink={1} minWidth={0}>
                      <Text wrap="truncate-end">
                        <Text color={color}>{c.status === 'running' ? '● ' : c.status === 'done' ? '✓ ' : '✗ '}</Text>
                        <Text bold>{c.description || c.type}</Text>
                      </Text>
                    </Box>
                    <Text dimColor tabular>{clock(took)}</Text>
                  </Box>
                  <Text key="m" dimColor tabular wrap="truncate-end">
                    {c.type} · {modelName(c.model)} · {c.steps} steps · ctx {k(c.ctx)} · out {k(c.out)}
                  </Text>
                  {c.lastTool !== '' && (
                    <Text key="t" dimColor size="footnote" wrap="truncate-end">
                      ↳ {c.lastTool}
                    </Text>
                  )}
                </Box>
              )
            })

    // ---- permissions
    const gt = BUCKETS.reduce((a, b) => ({ allowed: a.allowed + g.totals[b].allowed, asked: a.asked + g.totals[b].asked, denied: a.denied + g.totals[b].denied }), { allowed: 0, asked: 0, denied: 0 })
    const gateBody = () => [
      <Box key="head" flexDirection="row" gap={1}>
        <Box flexGrow={1} flexShrink={1} minWidth={0}>{heading('k', 'KIND')}</Box>
        {cell('a', 8, heading('a', 'ALLOWED'))}
        {cell('q', 6, heading('q', 'ASKED'))}
        {cell('d', 7, heading('d', 'DENIED'))}
      </Box>,
      ...BUCKETS.filter(b => g.totals[b].allowed + g.totals[b].asked + g.totals[b].denied > 0).map(b => (
        <Box key={b} flexDirection="row" gap={1}>
          <Box flexGrow={1} flexShrink={1} minWidth={0}>
            <Text>{b}</Text>
          </Box>
          {cell('a', 8, n(String(g.totals[b].allowed), { color: 'success' }))}
          {cell('q', 6, n(String(g.totals[b].asked), { color: 'warning' }))}
          {cell('d', 7, n(String(g.totals[b].denied), { color: g.totals[b].denied > 0 ? 'error' : undefined, dim: g.totals[b].denied === 0 }))}
        </Box>
      )),
      gt.allowed + gt.asked + gt.denied > 0 &&
        strip('mix', [
          { value: gt.allowed, color: 'success' },
          { value: gt.asked, color: 'warning' },
          { value: gt.denied, color: 'error' },
        ], { cells: inner }),
      g.recent.length > 0 && (
        <Box key="recent" flexDirection="column">
          {heading('h', 'LATEST CHECKS')}
          {g.recent
            .slice(-6)
            .reverse()
            .map((c, i) => (
              <Text key={`r${i}`} wrap="truncate-end">
                <Text color={c.verdict === 'allowed' ? 'success' : c.verdict === 'asked' ? 'warning' : 'error'}>{c.verdict === 'denied' ? '✗ ' : '● '}</Text>
                <Text dimColor>{c.detail}</Text>
              </Text>
            ))}
        </Box>
      ),
    ]

    // ---- last turn
    const turnBody = () =>
      rc === null
        ? [<Text key="none" dimColor>No finished turn yet.</Text>]
        : [
            stats('t', [
              stat('d', 'TOOK', dur(rc.durationMs)),
              stat('c', 'COST ADDED', rc.costDelta !== null ? usd(rc.costDelta) : '—', { color: 'claude' }),
              stat('t', 'TOOL CALLS', String(rc.tools), { sub: `${rc.edits} edit${rc.edits === 1 ? '' : 's'}` }),
              stat('e', 'ERRORS', String(rc.errors), { color: rc.errors > 0 ? 'error' : undefined, sub: `${rc.agents} sub-agent${rc.agents === 1 ? '' : 's'}` }),
            ]),
          ]

    const WHY: Record<string, string> = { start: 'session start', idle: 'idle over 1 hour', summary: 'after a summary', other: 'other' }
    const toolName = (name: string) => {
      const parts = name.split('__')
      return parts[0] === 'mcp' && parts.length >= 3 ? parts.slice(2).join('__') : name
    }
    const cacheBody = () =>
      !ch
        ? [<Text key="none" dimColor>{sc.at > 0 ? 'No cache data in the transcripts.' : 'Reading the transcripts…'}</Text>]
        : [
            stats('c', [
              stat('f', 'STARTING LOAD', k(ch.first), { sub: 'first request', w: stat3 }),
              stat('t', 'REQUESTS THIS TURN', String(turnReqs), { color: turnReqs > TURN_MAX ? 'error' : undefined, sub: `limit ${TURN_MAX}`, w: stat3 }),
              stat('r', 'REBUILDS', String(ch.rebuildCount), { sub: `${k(ch.rebuildTokens)} written`, w: stat3 }),
            ]),
            ch.memoryChars !== null && (
              <Box key="mem" flexDirection="column">
                <Box key="h" flexDirection="row" justifyContent="space-between">
                  {heading('l', 'MEMORY INDEX')}
                  <Text tabular dimColor>
                    {`${ch.memoryChars.toLocaleString('en-US')} / ${MEMORY_BAR.toLocaleString('en-US')} chars`}
                    <Text color={memColor} bold>{`  ${memWord}`}</Text>
                  </Text>
                </Box>
                {strip('bar', [{ value: Math.min(1, ch.memoryChars / MEMORY_BAR), color: memColor }], { track: true, cells: inner })}
                <Text size="footnote" dimColor tabular wrap="truncate-end">
                  {`Good to ${MEMORY_MAX.toLocaleString('en-US')} (target) · Fine to ${MEMORY_RED.toLocaleString('en-US')} · Bad past it`}
                </Text>
              </Box>
            ),
            <Box key="rb" flexDirection="column">
              {heading('h', 'REBUILDS · REQUESTS WRITING OVER 50K')}
              {ch.rebuilds.length === 0 ? (
                <Text key="none" dimColor>None.</Text>
              ) : (
                ch.rebuilds
                  .slice(-5)
                  .reverse()
                  .map((r, i) => (
                    <Box key={`r${i}`} flexDirection="row" gap={1}>
                      {cell('t', 5, <Text dimColor tabular>{hhmm(r.at)}</Text>, false)}
                      <Box flexGrow={1} flexShrink={1} minWidth={0}>
                        <Text wrap="truncate-end">{WHY[r.why] ?? r.why}</Text>
                      </Box>
                      {cell('n', 7, n(k(r.tokens)))}
                    </Box>
                  ))
              )}
            </Box>,
            <Box key="tl" flexDirection="column">
              {heading('h', 'LARGEST TOOL RESULTS · CHARACTERS')}
              {ch.tools.length === 0 ? (
                <Text key="none" dimColor>None yet.</Text>
              ) : (
                ch.tools.map((t, i) => (
                  <Box key={`t${i}`} flexDirection="row" gap={1}>
                    <Box flexGrow={1} flexShrink={1} minWidth={0}>
                      <Text wrap="truncate-end">{toolName(t.name)}</Text>
                    </Box>
                    {cell('n', 7, n(k(t.chars)))}
                  </Box>
                ))
              )}
            </Box>,
          ]

    // ---- activity
    const logBody = () =>
      lines.length === 0
        ? [<Text key="none" dimColor>Nothing yet.</Text>]
        : lines
            .slice(-20)
            .reverse()
            .map((l, i) => (
              <Box key={`l${i}`} flexDirection="row" gap={1}>
                {cell('t', 5, <Text dimColor tabular>{hhmm(l.at)}</Text>, false)}
                {!isNarrow && cell('w', 10, <Text color={l.kind === 'error' ? 'error' : l.kind === 'done' ? 'success' : undefined} wrap="truncate-end">{l.who}</Text>, false)}
                <Box flexGrow={1} flexShrink={1} minWidth={0}>
                  <Text dimColor={l.kind === 'info'} color={l.kind === 'error' ? 'error' : undefined} wrap="truncate-end">
                    {l.text}
                  </Text>
                </Box>
              </Box>
            ))

    const copy = async (what: string, text: string, surface: Parameters<typeof $.ui.copy>[0]['surface']) => {
      const r = await $.ui.copy({ text, surface })
      await update($, copied, () => (r.isCopied ? `Copied ${what}.` : `Copy failed (${r.reason}).`))
    }
    const errorsNow = lines.filter(l => l.kind === 'error').length
    const byId: Record<string, () => ReturnType<typeof section>> = {
      session: () => section('session', 'Session totals', `${usd(v.costUsd ?? total.usd)} · ${k(weighted(total))} weighted`, sessionBody),
      tasks: () => section('tasks', 'Tasks', `${shownTasks.length} · now: ${last?.label ?? '—'}`, tasksBody),
      requests: () => section('requests', 'Recent requests', `${log0.length} seen`, requestsBody),
      agents: () => section('agents', 'Sub-agents', cards.length === 0 ? 'none' : `${running} running · ${cards.length} total`, agentsBody),
      gate: () => section('gate', 'Permissions', `${gt.allowed} ok · ${gt.asked} asked · ${gt.denied} denied`, gateBody),
      cache: () => section('cache', 'Cache health', ch ? `start ${k(ch.first)} · ${ch.rebuildCount} rebuild${ch.rebuildCount === 1 ? '' : 's'}` : '—', cacheBody),
      turn: () => section('turn', 'Last turn', rc ? `${dur(rc.durationMs)}${rc.costDelta !== null ? ` · +${usd(rc.costDelta)}` : ''}` : '—', turnBody),
      log: () => section('log', 'Activity', errorsNow > 0 ? `${lines.length} events · ${errorsNow} errors` : `${lines.length} events`, logBody),
    }

    const tree = (
      <Box flexDirection="column" gap={1}>
        {vitalsCard}
        {lay.order.filter(id => !lay.hidden.includes(id)).map(id => byId[id]?.())}
        <Box key="actions" flexDirection="row" flexWrap="wrap" gap={1} alignItems="center">
          <Button key="copy-summary" label="Copy tasks (CSV)" onPress={p => void copy('the task summary', summaryCsv(list, factor), p.surface)} />
          <Button key="copy-calls" label={`Copy ${log0.length} requests (CSV)`} onPress={p => void copy('the request log', callsCsv(log0, factor), p.surface)} />
          {note !== '' && (
            <Text dimColor size="footnote">
              {note}
            </Text>
          )}
        </Box>
        <Text key="foot" dimColor size="footnote">
          {isCalibrated
            ? 'Cost is Claude Code’s own total. Each row’s cost is its tokens at list price, scaled so the rows add up to that total.'
            : 'Cost is an estimate at list price until Claude Code reports the session cost.'}{' '}
          Weighted = input ×1 + cache write ×1.25 (five-minute cache) or ×2 (one-hour cache) + cache read ×0.1 + output ×5. Fresh = input + cache write + output.
        </Text>
      </Box>
    )
    return theme ? paint(tree, theme) : tree
  })
}
