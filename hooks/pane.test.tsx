import { expect, mock, test } from 'claude-code/testing'
import { fromModel, usdOf, weighted } from './core'

const pane = { title: '', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} } as const
const usage = { model: 'claude-opus-5-5', input_tokens: 1000, output_tokens: 2000, cache_read_input_tokens: 100000, cache_creation_input_tokens: 4000 }
type Eng = Parameters<Extract<Parameters<typeof test>[1], (...a: never[]) => unknown>>[0]
const mount = ($: Eng, surface: 'terminal' | 'desktop', bodyColumns = 60) =>
  $.ui.mount({ plugin: 'session-watcher', surface, component: 'Pane', requestId: 'session-watcher', props: { ...pane, bodyColumns } })

// The engine's own registrations are answered here, as a host would.
const start = async ($: Eng, on: Parameters<Extract<Parameters<typeof test>[1], (...a: never[]) => unknown>>[1]) => {
  on('command.register', async () => ({ value: { command: 'session-watcher' } }) as never)
  on('tool.register', async () => ({ value: { name: 'mark_task' } }) as never)
  await ($.session.start as (e: unknown) => Promise<unknown>)({ source: 'startup', cwd: '/tmp' } as never).catch(() => undefined)
}

for (const surface of ['terminal', 'desktop'] as const) {
  test(`${surface}: vitals show, two sections open, the rest closed until pressed`, async ($, on) => {
    mock.clock(on)
    on('turn.step', async function* () {
      return { turnId: 't', index: 0, answer: '', toolUses: [], stopReason: 'end_turn', usage } as never
    })
    await start($, on)
    await $.tool.call({ tool: 'mcp__session-watcher__mark_task', label: 'A1 build' } as never)
    for await (const _ of ($.turn.step as (e: unknown) => AsyncIterable<unknown>)({ turnId: 't', index: 0, model: usage.model, messageCount: 1 })) void _
    const ui = await mount($, surface)
    expect(await ui.find({ type: 'Text', text: /Opus 5\.5/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^CONTEXT/ })).toBeDefined()
    // Tasks is open by default: the task and its main-thread row show.
    expect(await ui.find({ type: 'Text', text: /A1 build/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^Main thread$/ })).toBeDefined()
    // Recent requests starts closed; pressing it shows the request, pressing again hides it.
    expect(await ui.find({ type: 'Text', text: /^Main( ·|$)/ })).toBeUndefined()
    await ui.press({ key: 'sec-requests' })
    expect(await ui.find({ type: 'Text', text: /^Main( ·|$)/ })).toBeDefined()
    await ui.press({ key: 'sec-requests' })
    expect(await ui.find({ type: 'Text', text: /^Main( ·|$)/ })).toBeUndefined()
    // Closing Tasks hides its cards.
    await ui.press({ key: 'sec-tasks' })
    expect(await ui.find({ type: 'Text', text: /^Main thread$/ })).toBeUndefined()
  })
}

test('a permission check is tallied under its kind', async ($, on) => {
  mock.clock(on)
  on('tool.check', async () => ({ decision: 'deny' }) as never)
  await start($, on)
  await ($.tool.check as (e: unknown) => Promise<unknown>)({ tool: 'Bash', input: { command: 'rm -rf x' }, tool_use_id: 'u1' }).catch(() => undefined)
  const ui = await mount($, 'terminal')
  expect(await ui.find({ type: 'Text', text: /1 denied/ })).toBeDefined()
  await ui.press({ key: 'sec-gate' })
  expect(await ui.find({ type: 'Text', text: /^shell$/ })).toBeDefined()
})

// Nothing breaks from a surface that reports no width (drawn at 60) down to the narrowest.
for (const surface of ['terminal', 'desktop'] as const)
  for (const bodyColumns of [0, 24, 34, 48, 120]) {
    test(`${surface}: an empty session draws at ${bodyColumns} columns with every section open`, async ($, on) => {
      mock.clock(on)
      await start($, on)
      const ui = await mount($, surface, bodyColumns)
      for (const id of ['session', 'requests', 'agents', 'gate', 'cache', 'turn', 'log']) {
        if (id !== 'session') await ui.press({ key: `sec-${id}` })
      }
      expect(await ui.find({ type: 'Text', text: /No calls yet/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /No sub-agents/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /No finished turn yet/ })).toBeDefined()
    })
  }

// The context bar measures against the window the session compacts at (autoCompactWindow), not the model's window.
test('the context bar uses the compaction window from settings', async ($, on) => {
  mock.clock(on)
  on('session.usage', async (_$, e) =>
    ({ value: {
      startedAt: 0,
      rateLimits: [],
      context: {
        window: 1_000_000,
        ...((e as { breakdown?: string }).breakdown ? { breakdown: { categories: [], totalTokens: 150_000, maxTokens: 300_000, rawMaxTokens: 300_000, autocompactSource: 'settings', percentage: 50, gridRows: [], model: 'claude-opus-5-5', memoryFiles: [], mcpTools: [], agents: [], isAutoCompactEnabled: true, apiUsage: null } } : {}),
      },
    } }) as never)
  await start($, on)
  await ($.session.measure as (e: unknown) => Promise<unknown>)({ context: { tokens: 150_000, window: 1_000_000, percent: 15 }, rateLimits: [], changed: ['context'] }).catch(() => undefined)
  const ui = await mount($, 'terminal')
  expect(await ui.find({ type: 'Text', text: /150k \/ 300k/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /50%/ })).toBeDefined()
})

// A cache write costs by cache length: one hour at 2x input, five minutes at 1.25x.
test('cache writes are priced by cache length', async () => {
  const m = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 1000 }
  // no split on the response: the main thread's writes are one-hour, a sub-agent's five-minute
  expect(weighted(fromModel('claude-opus-5-5', m, true))).toBe(2000)
  expect(weighted(fromModel('claude-opus-5-5', m, false))).toBe(1250)
  // a split on the response wins: 400 one-hour + 600 five-minute
  const split = { ...m, cache_creation: { ephemeral_1h_input_tokens: 400, ephemeral_5m_input_tokens: 600 } }
  expect(weighted(fromModel('claude-opus-5-5', split as never, false))).toBe(1550)
  // dollars use the same ratio: a one-hour write costs 2 / 1.25 = 1.6 times a five-minute one
  const w = { input: 0, cacheWrite: 1000, cacheRead: 0, output: 0 }
  expect(Math.round(usdOf('claude-opus-5-5', { ...w, cacheWrite1h: 1000 }) / usdOf('claude-opus-5-5', w) * 1000)).toBe(1600)
  // a split larger than the write is capped at the write
  expect(weighted(fromModel('claude-opus-5-5', { ...m, cache_creation: { ephemeral_1h_input_tokens: 5000 } } as never, false))).toBe(2000)
  // usage stored before the split was kept prices every write at 1.25x
  expect(weighted({ input: 0, cacheWrite: 1000, cacheRead: 0, output: 0, calls: 1, usd: 0 })).toBe(1250)
})

// Cache health shows the transcript's figures, and a limit passed shows in the always-shown Vitals card.
test('cache health section and its Vitals line', async ($, on) => {
  mock.clock(on)
  const cache = {
    first: 91525,
    rebuilds: [
      { at: 1000, tokens: 91523, why: 'start' },
      { at: 2000, tokens: 193388, why: 'idle' },
    ],
    rebuildCount: 2,
    rebuildTokens: 284911,
    memoryChars: 18057,
    tools: [{ name: 'mcp__blueprint__resolve_references', chars: 31463, at: 1500 }],
  }
  on('session.id', async () => ({ value: 'sid' }) as never)
  on('process.run', async () => ({ value: { exitCode: 0, stdout: JSON.stringify({ ms: 0, byModel: {}, cache }), stderr: '' } }) as never)
  await start($, on)
  for (let i = 0; i < 200; i++) await Promise.resolve()
  const ui = await mount($, 'terminal')
  expect(await ui.find({ type: 'Text', text: /memory index 18k chars \(over 4,200\)/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^STARTING LOAD$/ })).toBeUndefined()
  await ui.press({ key: 'sec-cache' })
  expect(await ui.find({ type: 'Text', text: /^STARTING LOAD$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^92k$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^idle over 1 hour$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^resolve_references$/ })).toBeDefined()
})

// Below both limits, no Vitals line.
test('no cache line when every figure is inside its limit', async ($, on) => {
  mock.clock(on)
  const cache = { first: 50000, rebuilds: [], rebuildCount: 0, rebuildTokens: 0, memoryChars: 3000, tools: [] }
  on('session.id', async () => ({ value: 'sid' }) as never)
  on('process.run', async () => ({ value: { exitCode: 0, stdout: JSON.stringify({ ms: 0, byModel: {}, cache }), stderr: '' } }) as never)
  await start($, on)
  for (let i = 0; i < 200; i++) await Promise.resolve()
  const ui = await mount($, 'terminal')
  expect(await ui.find({ type: 'Text', text: /Cache:/ })).toBeUndefined()
  await ui.press({ key: 'sec-cache' })
  expect(await ui.find({ type: 'Text', text: /^50k$/ })).toBeDefined()
})

// Pressing the Vitals title folds away its stats row and keeps the context bar; pressing again brings it back.
test('the Vitals stats row folds away', async ($, on) => {
  mock.clock(on)
  await start($, on)
  const ui = await mount($, 'terminal')
  expect(await ui.find({ type: 'Text', text: /^RUNNING FOR$/ })).toBeDefined()
  await ui.press({ key: 'sec-vitals' })
  expect(await ui.find({ type: 'Text', text: /^RUNNING FOR$/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /^CONTEXT/ })).toBeDefined()
  await ui.press({ key: 'sec-vitals' })
  expect(await ui.find({ type: 'Text', text: /^RUNNING FOR$/ })).toBeDefined()
})

// More than 15 main-thread requests in one turn shows the Vitals line; sub-agent requests do not count.
test('requests this turn past 15 show in Vitals', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  on('turn.step', async function* () {
    return { turnId: 't', index: 0, answer: '', toolUses: [], stopReason: 'tool_use', usage } as never
  })
  await start($, on)
  await ($.turn.start as (e: unknown) => Promise<unknown>)({ turnId: 't', text: 'go' }).catch(() => undefined)
  const step = async (agentId?: string) => {
    for await (const _ of ($.turn.step as (e: unknown) => AsyncIterable<unknown>)({ turnId: 't', index: 0, model: usage.model, messageCount: 1, agentId })) void _
  }
  for (let i = 0; i < 15; i++) await step()
  for (let i = 0; i < 5; i++) await step('a1')
  const ui = await mount($, 'terminal')
  expect(await ui.find({ type: 'Text', text: /requests this turn/ })).toBeUndefined()
  await step()
  expect(await ui.find({ type: 'Text', text: /16 requests this turn \(over 15\)/ })).toBeDefined()
})
