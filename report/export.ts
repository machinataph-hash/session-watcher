// Session Watcher export: the pane's state, rebuilt from the transcripts with the mod's own scan.py and core.ts.
import { execFileSync } from 'node:child_process'
import { globSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { bucketOf, describe, dur, EDIT_TOOLS, empty, emptyGate, fromModel, newTask, priceScan, shorten, sum, usdOf } from '../hooks/core.ts'

const [sid, out, repo = new URL('..', import.meta.url).pathname] = process.argv.slice(2)
const home = process.env.HOME + '/.claude'
const files = globSync(`${home}/projects/*/${sid}.jsonl`)
const agentFiles = globSync(`${home}/projects/*/${sid}/subagents/*.jsonl`)
// The session can span several project folders (the working directory moved): merge them, each line once.
const seen = new Set<string>(); const lines: any[] = []
for (const f of files) for (const l of readFileSync(f, 'utf8').split('\n')) {
  if (!l.trim()) continue
  let o: any; try { o = JSON.parse(l) } catch { continue }
  const id = o.uuid ?? l
  if (seen.has(id)) continue
  seen.add(id); lines.push(o)
}
lines.sort((a, b) => (a.timestamp ?? '').localeCompare(b.timestamp ?? ''))
const tmp = `${out}/.cfg`; rmSync(tmp, { recursive: true, force: true })
mkdirSync(`${tmp}/projects/merged/${sid}/subagents`, { recursive: true })
writeFileSync(`${tmp}/projects/merged/${sid}.jsonl`, lines.map(o => JSON.stringify(o)).join('\n') + '\n')
for (const f of agentFiles) writeFileSync(`${tmp}/projects/merged/${sid}/subagents/${f.split('/').pop()}`, readFileSync(f))
const raw = JSON.parse(execFileSync('python3', ['-I', `${repo}/hooks/scan.py`, sid], { env: { ...process.env, CLAUDE_CONFIG_DIR: tmp } }).toString())
rmSync(tmp, { recursive: true, force: true })
const now = Date.now()
const t = (o: any) => Date.parse(o.timestamp)
const scan = priceScan({ at: now, byModel: raw.byModel, costUsd: null, cache: raw.cache })

// Requests, tasks (mark_task), activity, permissions and the last turn, read from the main transcript.
const calls: any[] = []; const byMsg = new Map<string, any>()
const first = lines.find(o => o.timestamp)
const tasks = [newTask('Unlabelled', t(first))]
const toolUse = new Map<string, { name: string; input: any; at: number }>()
const log: any[] = []; const gate = emptyGate()
let model = '', ctx: number | null = null
const turns: { start: number; end?: number; tools: number; edits: number; errors: number; reqs: string[] }[] = []
for (const o of lines) {
  const m = o.message ?? {}
  if (o.type === 'user' && !o.isMeta && !o.isSidechain) {
    const text = typeof m.content === 'string' ? m.content : Array.isArray(m.content) ? m.content.filter((b: any) => b.type === 'text').map((b: any) => b.text).join(' ') : ''
    const isPrompt = text && !/^<(system-reminder|task-notification|local-command|command-)/.test(text.trim())
    if (isPrompt) { log.push({ at: t(o), who: 'you', text: shorten(text, 70), kind: 'info' }); turns.push({ start: t(o), tools: 0, edits: 0, errors: 0, reqs: [] }) }
    for (const b of Array.isArray(m.content) ? m.content : []) {
      if (b.type !== 'tool_result') continue
      const u = toolUse.get(b.tool_use_id); if (!u) continue
      const res = typeof b.content === 'string' ? b.content : (b.content ?? []).map((x: any) => x.text ?? '').join(' ')
      const denied = b.is_error && /doesn't want to proceed|denied|declined|rejected/i.test(res)
      const bucket = bucketOf(u.name)
      gate.totals[bucket][denied ? 'denied' : 'allowed']++
      const detail = describe(u.name, u.input)
      gate.recent.push({ at: t(o), tool: u.name, bucket, verdict: denied ? 'denied' : 'allowed', detail })
      const turn = turns.at(-1)
      if (turn) { turn.tools++; if (EDIT_TOOLS.has(u.name)) turn.edits++; if (b.is_error) turn.errors++ }
      if (denied) log.push({ at: t(o), who: 'gate', text: `denied · ${detail}`, kind: 'error' })
      else if (b.is_error) log.push({ at: t(o), who: 'main', text: `${detail}  ✗`, kind: 'error' })
      else if (EDIT_TOOLS.has(u.name)) log.push({ at: t(o), who: 'main', text: detail, kind: 'info' })
    }
  }
  if (o.type === 'assistant' && m.usage && m.model !== '<synthetic>') {
    model = m.model
    const u = fromModel(m.model, m.usage, true)
    let c = byMsg.get(m.id)
    if (!c) {
      c = { at: t(o), task: tasks.at(-1)!.label, who: 'main thread', model: m.model, effort: '', input: 0, cacheWrite: 0, cacheWrite1h: 0, cacheRead: 0, output: 0, usd: 0 }
      byMsg.set(m.id, c); calls.push(c); turns.at(-1)?.reqs.push(m.id)
    }
    for (const f of ['input', 'cacheWrite', 'cacheWrite1h', 'cacheRead', 'output'] as const) c[f] = Math.max(c[f], (u as any)[f] ?? 0)
    c.usd = usdOf(c.model, c)
    ctx = c.input + c.cacheWrite + c.cacheRead
    for (const b of m.content ?? []) if (b.type === 'tool_use') {
      toolUse.set(b.id, { name: b.name, input: b.input, at: t(o) })
      if (/mark_task$/.test(b.name) && b.input?.label) { tasks.at(-1)!.endedAt = t(o); tasks.push(newTask(String(b.input.label), t(o))) }
    }
    if (m.stop_reason === 'end_turn' && turns.at(-1)) turns.at(-1)!.end = t(o)
  }
  if (o.subtype === 'compact_boundary') log.push({ at: t(o), who: 'main', text: 'context compacted', kind: 'info' })
}
// Each task's main-thread usage: its requests.
for (const c of calls) {
  const task = tasks.findLast(x => x.startedAt <= c.at) ?? tasks[0]
  c.task = task.label
  task.main.usage = sum(task.main.usage, { ...c, calls: 1 })
  if (!task.main.models.includes(c.model)) task.main.models.push(c.model)
}
const done = turns.filter(x => x.end)
const lt = done.at(-1)
let receipt = null
if (lt) {
  const rs = calls.filter(c => c.at >= lt.start && c.at <= lt.end!)
  const seenIn = rs.reduce((a, c) => a + c.input + c.cacheWrite + c.cacheRead, 0)
  receipt = { durationMs: lt.end! - lt.start, agents: 0, edits: lt.edits, errors: lt.errors, tools: lt.tools, costDelta: rs.reduce((a, c) => a + c.usd, 0), reason: 'answer', requests: rs.length, cacheHit: seenIn > 0 ? rs.reduce((a, c) => a + c.cacheRead, 0) / seenIn : null }
  log.push({ at: lt.end, who: 'main', text: `turn done · ${dur(lt.end! - lt.start)}`, kind: 'done' })
}
log.sort((a, b) => a.at - b.at)
gate.recent = gate.recent.slice(-30)
const active = { hist: raw.ms ?? 0, ms: 0, since: null, turns: [] }
const vitals = { model, effort: '', mode: '', ctxTokens: ctx, ctxWindow: 0, ctxLimit: 0, ctxPct: null, costUsd: null, limits: [], compactions: log.filter(l => l.text === 'context compacted').length, ttftMs: null, isRunning: false }
const state = { exportedAt: now, sessionStart: t(first), tasks, calls, active, scan, vitals, agents: [], gate, turn: { startedAt: 0, edits: 0, errors: 0, tools: 0, costAtStart: null }, receipt, log: log.slice(-200) }
writeFileSync(`${out}/state.json`, JSON.stringify(state))
console.log(`${calls.length} requests · ${tasks.length} task(s) · ctx ${ctx} · ${log.length} log lines · list price $${calls.reduce((a, c) => a + c.usd, 0).toFixed(2)}`)
