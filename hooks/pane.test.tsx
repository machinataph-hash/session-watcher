import { expect, mock, test } from 'claude-code/testing'
import Chips from './chips'
import { applyLayoutMessage, extrasOf, breakdownText, canStep, cleanLayout, defaultLayout, targetsOf, emptyLimitModel, estimateLimit, fromModel, paint, THEMES, stepLimitModel, usdOf, weighted } from './core'

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
    // Recent Requests starts closed; pressing it shows the request, pressing again hides it.
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
      expect(await ui.find({ type: 'Text', text: /None running/ })).toBeDefined()
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

// The Cache card shows the transcript's figures, and a limit passed shows as a warning in the Main card.
test('cache section and its Main line', async ($, on) => {
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
  expect(await ui.find({ type: 'Text', text: /memory index 18k chars \(target 4,200\)/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^STARTING LOAD$/ })).toBeUndefined()
  await ui.press({ key: 'sec-cache' })
  expect(await ui.find({ type: 'Text', text: /^STARTING LOAD$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^CACHE HIT RATE$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^92k$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^18,057 \/ 10,000 chars/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^  Bad$/ })).toBeDefined()
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
for (const surface of ['terminal', 'desktop'] as const)
test(`${surface}: the Vitals stats row folds away`, async ($, on) => {
  mock.clock(on)
  await start($, on)
  const ui = await mount($, surface)
  expect(await ui.find({ type: 'Text', text: /^RUNNING FOR$/ })).toBeDefined()
  await ui.press({ key: 'sec-vitals' })
  expect(await ui.find({ type: 'Text', text: /^RUNNING FOR$/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /^CONTEXT/ })).toBeDefined()
  await ui.press({ key: 'sec-vitals' })
  expect(await ui.find({ type: 'Text', text: /^RUNNING FOR$/ })).toBeDefined()
})

// Requests this turn are shown in Last Turn only; Vitals carries no turn-count warning.
test('requests this turn past 15 no longer warn in Vitals', async ($, on) => {
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
  expect(await ui.find({ type: 'Text', text: /requests this turn \(over/ })).toBeUndefined()
})

test('context_breakdown: categories largest first, MCP tokens summed per server, loaded and deferred apart', async () => {
  const text = breakdownText({
    categories: [
      { name: 'System prompt', tokens: 9000, color: '', isDeferred: false, kind: 'used' },
      { name: 'MCP tools', tokens: 30000, color: '', isDeferred: false, kind: 'used' },
      { name: 'MCP tools (deferred)', tokens: 50000, color: '', isDeferred: true, kind: 'deferred' },
    ],
    totalTokens: 39000, maxTokens: 300000, rawMaxTokens: 300000, autocompactSource: 'model' as never, percentage: 13, gridRows: [], model: 'opus',
    memoryFiles: [{ path: 'MEMORY.md', type: 'AutoMem', tokens: 4500 }],
    mcpTools: [
      { name: 'mcp__a__x', serverName: 'a', tokens: 100, isLoaded: true },
      { name: 'mcp__a__y', serverName: 'a', tokens: 50, isLoaded: false },
      { name: 'mcp__b__z', serverName: 'b', tokens: 1000, isLoaded: false },
    ],
    agents: [{ agentType: 'r', source: 'user', tokens: 70 }],
    skills: { totalSkills: 40, includedSkills: 38, tokens: 3000, skillFrontmatter: [] },
    isAutoCompactEnabled: true, apiUsage: null,
  } as never)
  const lines = text.split('\n')
  expect(lines[0]).toBe('Context 39,000 of 300,000 (opus)')
  expect(lines[2]).toBe('  MCP tools (deferred): 50,000 (deferred)')
  expect(lines[3]).toBe('  MCP tools: 30,000')
  expect(text).toContain('  b: 0, 1,000, 1\n  a: 100, 50, 2')
  expect(text).toContain('  MEMORY.md: 4,500')
  expect(text).toContain('Agents: 70 over 1')
  expect(text).toContain('Skills: 3,000, 38 of 40 listed')
})

// The limit estimator: $1 per percent, learned from two clean steps, shared across sessions.
const H = 3_600_000
const five = (pct: number, resetsAt = 5 * H) => [{ kind: 'five_hour', pct, resetsAt }]
const one = (pct: number) => ({ kind: 'five_hour', pct, resetsAt: 10 * H })
test('the limit estimate waits for two measured steps, then adds the spend since the last one', () => {
  let m = stepLimitModel(emptyLimitModel(), 'a', 0, five(10), 0)
  // The first reading falls somewhere inside 10%: no estimate, and its first step is not measured.
  m = stepLimitModel(m, 'a', 0.4, five(10), 1)
  expect(estimateLimit(m, one(10))).toBe(null)
  m = stepLimitModel(m, 'a', 0.7, five(11), 2)
  m = stepLimitModel(m, 'a', 1.7, five(12), 3)
  expect(m.samples.five_hour).toEqual([1])
  expect(estimateLimit(m, one(12))).toBe(null)
  // A second session's spend counts too.
  m = stepLimitModel(m, 'b', 0, five(12), 4)
  m = stepLimitModel(m, 'b', 1, five(13), 5)
  expect(m.samples.five_hour?.map(x => Math.round(x * 1e6) / 1e6)).toEqual([1, 1])
  m = stepLimitModel(m, 'a', 2.05, five(13), 6)
  expect(estimateLimit(m, one(13))).toBe(13.35)
  // Spend past a full step without the percent moving stays below the next percent.
  m = stepLimitModel(m, 'b', 3, five(13), 7)
  expect(estimateLimit(m, one(13))).toBe(13.99)
  // A bad cost is ignored, and a full limit shows no estimate.
  expect(stepLimitModel(m, 'b', Number.NaN, five(13), 8).seen.b?.cost).toBe(3)
  expect(estimateLimit({ ...m, tracks: { five_hour: { ...m.tracks.five_hour!, pct: 100 } } }, one(100))).toBe(null)
})

test('a new window at 0% starts clean, a shift of milliseconds is the same window, a lower cost adds nothing', () => {
  let m = emptyLimitModel()
  m = { ...m, samples: { five_hour: [2, 2] } }
  m = stepLimitModel(m, 'a', 5, five(40), 0)
  m = stepLimitModel(m, 'a', 5, five(0, 10 * H), 1)
  expect(m.tracks.five_hour?.isClean).toBe(true)
  m = stepLimitModel(m, 'a', 6, five(0, 10 * H + 346), 2)
  expect(estimateLimit(m, one(0))).toBe(0.5)
  // A cleared session reports a lower cost: nothing is subtracted, and its count starts again.
  m = stepLimitModel(m, 'a', 0.2, five(0, 10 * H), 3)
  expect(m.spent).toBe(1)
  m = stepLimitModel(m, 'a', 0.6, five(0, 10 * H), 4)
  expect(estimateLimit(m, one(0))).toBe(0.7)
})

// Settings under Vitals: the cog opens the section chips; a tick hides a section, a drag moves it, and both are kept.
for (const surface of ['terminal', 'desktop'] as const)
  test(`${surface}: the section chips hide and move sections, and the layout is saved`, async ($, on) => {
    mock.clock(on)
    mock.store(on)
    await start($, on)
    const ui = await mount($, surface)
    expect(await ui.find({ type: 'Text', text: /^CARDS$/ })).toBeUndefined()
    await ui.press({ key: 'settings' })
    expect(await ui.find({ type: 'Text', text: /^CARDS$/ })).toBeDefined()
    // Untick Tasks (row 1): its section goes, its chip stays.
    expect(await ui.find({ type: 'Text', text: /^Tasks$/ })).toBeDefined()
    await ui.pointer({ type: 'down', x: 0, y: 1, button: 'left', in: 'section-chips' })
    await ui.pointer({ type: 'up', x: 0, y: 1, button: 'left', in: 'section-chips' })
    expect(await ui.find({ key: 'sec-tasks' })).toBeUndefined()
    // A click on the title, not the box, ticks it too: it comes back, then goes again.
    await ui.pointer({ type: 'down', x: 12, y: 1, button: 'left', in: 'section-chips' })
    await ui.pointer({ type: 'up', x: 12, y: 1, button: 'left', in: 'section-chips' })
    expect(await ui.find({ key: 'sec-tasks' })).toBeDefined()
    await ui.pointer({ type: 'down', x: 12, y: 1, button: 'left', in: 'section-chips' })
    await ui.pointer({ type: 'up', x: 12, y: 1, button: 'left', in: 'section-chips' })
    expect(await ui.find({ key: 'sec-tasks' })).toBeUndefined()
    // Drag Activity (row 7) to the top.
    await ui.pointer({ type: 'down', x: 6, y: 7, button: 'left', in: 'section-chips' })
    await ui.pointer({ type: 'move', x: 6, y: 0, button: 'left', in: 'section-chips' })
    await ui.pointer({ type: 'up', x: 6, y: 0, button: 'left', in: 'section-chips' })
    const keys = (await ui.findAll({ type: 'Button' })).map(b => (b as { key?: string }).key).filter(x => x?.startsWith('sec-') && x !== 'sec-vitals')
    expect(keys[0]).toBe('sec-log')
    expect(keys).not.toContain('sec-tasks')
    // The sections themselves still open and close.
    await ui.press({ key: 'sec-log' })
    await ui.press({ key: 'settings' })
    expect(await ui.find({ type: 'Text', text: /^CARDS$/ })).toBeUndefined()
  })

// The theme and the Main card's extras are tick lists; both picks are saved.
test('desktop: a theme tick picks a theme, and a Main extra flips', async ($, on) => {
  mock.clock(on)
  mock.store(on)
  await start($, on)
  const ui = await mount($, 'desktop')
  await ui.press({ key: 'settings' })
  const items = async (key: string) => (((await ui.find({ key })) as any)?.props?.props?.items ?? []) as { id: string; isShown: boolean }[]
  const on1 = async (key: string) => (await items(key)).filter(i => i.isShown).map(i => i.id)
  const click = async (key: string, y: number) => {
    await ui.pointer({ type: 'down', x: 4, y, button: 'left', in: key })
    await ui.pointer({ type: 'up', x: 4, y, button: 'left', in: key })
  }
  expect(await on1('setting-ticks-theme')).toEqual(['theme:app'])
  await click('setting-ticks-theme', 2)
  expect(await on1('setting-ticks-theme')).toEqual(['theme:reader'])
  expect(await on1('setting-ticks-card:vitals')).toEqual([])
  expect(await ui.find({ type: 'Text', text: /^ACTIVE$/ })).toBeUndefined()
  await click('setting-ticks-card:vitals', 0)
  expect(await on1('setting-ticks-card:vitals')).toEqual(['active'])
  expect(await ui.find({ type: 'Text', text: /^ACTIVE$/ })).toBeDefined()
  await click('setting-ticks-theme', 0)
  expect(await on1('setting-ticks-theme')).toEqual(['theme:app'])
})

test('a stored layout is cleaned: unknown ids dropped, new sections added last', () => {
  expect(cleanLayout({ order: ['log', 'nope', 'log', 'tasks'], hidden: ['x', 'gate'] })).toEqual({
    order: ['log', 'tasks', 'session', 'requests', 'agents', 'gate', 'cache', 'turn'],
    hidden: ['gate'],
  })
  expect(cleanLayout(null)).toEqual(defaultLayout())
  expect(applyLayoutMessage(defaultLayout(), { move: { id: 'session', to: 99 } }).order.at(-1)).toBe('session')
  expect(applyLayoutMessage(defaultLayout(), { toggle: 'nope' })).toEqual(defaultLayout())
})

test('a layout saved by an earlier session is used at start', async ($, on) => {
  mock.clock(on)
  mock.store(on, { layout: { order: ['gate', 'session'], hidden: ['tasks'] } })
  await start($, on)
  const ui = await mount($, 'desktop')
  const keys = (await ui.findAll({ type: 'Button' })).map(b => (b as { key?: string }).key).filter(x => x?.startsWith('sec-') && x !== 'sec-vitals')
  expect(keys.slice(0, 2)).toEqual(['sec-gate', 'sec-session'])
  expect(keys).not.toContain('sec-tasks')
})

test('layout: card extras flip and only changes are stored; old fields dropped; theme kept, unknown themes dropped', () => {
  let l = cleanLayout({ order: [], hidden: [], hideCacheBar: true })
  expect('hideCacheBar' in l).toBe(false)
  expect(l.cards).toBeUndefined()
  expect(extrasOf(l, 'vitals')).toEqual({ active: false, ttft: false })
  l = applyLayoutMessage(l, { extra: { card: 'vitals', key: 'active' } })
  expect(l.cards).toEqual({ vitals: { active: true } })
  l = applyLayoutMessage(l, { extra: { card: 'vitals', key: 'active' } })
  expect(l.cards).toBeUndefined()
  // Unknown cards, keys and non-booleans are dropped.
  expect(cleanLayout({ cards: { vitals: { nope: true, ttft: 'yes' }, zz: { a: true }, cache: { tools: false } } }).cards).toEqual({ cache: { tools: false } })
  expect(applyLayoutMessage(l, { extra: { card: 'vitals', key: 'nope' } })).toBe(l)
  l = applyLayoutMessage(l, { theme: 'reader' })
  expect(cleanLayout(l).theme).toBe('reader')
  expect(cleanLayout({ ...l, theme: 'nope' }).theme).toBeUndefined()
  expect(applyLayoutMessage(l, { theme: null }).theme).toBeUndefined()
})

test('paint: root keeps the app background, plain text the theme ink', () => {
  const t = THEMES.frostwerk!
  const out = paint({ type: 'Box', props: {}, children: [{ type: 'Text', props: { dimColor: true }, children: ['x'] }] } as never, t) as any
  expect(out.props.backgroundColor).toBeUndefined()
  expect(out.children[0].props.color).toBe(t.muted)
})

test('paint: reaches children kept in props, nested lists included', () => {
  const t = THEMES.reader!
  const out = paint({ type: 'Box', props: { children: [[{ type: 'Text', props: { children: 'x' } }]] } } as never, t) as any
  expect(out.props.children[0][0].props.color).toBe(t.fg)
})

// Every theme: the chips sit on the Vitals card, so they take its colour; each Text they draw has a colour, and none equals the background they sit on.
test('chips: in every theme, text is drawn in a colour unlike its background', () => {
  const el = (type: string) => (props: Record<string, unknown>) => ({ type, props })
  const walk = (n: any, bg: string | undefined, out: { color: unknown; bg: unknown }[]) => {
    if (Array.isArray(n)) return n.forEach(c => walk(c, bg, out))
    if (!n || typeof n !== 'object') return
    const here = (n.props?.backgroundColor as string | undefined) ?? bg
    if (n.type === 'Text') out.push({ color: n.props?.color, bg: here })
    walk(n.props?.children, here, out)
  }
  for (const t of Object.values(THEMES)) {
    const surface = { elements: { Box: el('Box'), Text: el('Text') }, state: null, setState() {}, onPointer() {}, post() {} }
    const items = [{ id: 'a', title: 'A', isShown: true }, { id: 'b', title: 'B', isShown: false }]
    const tree = (Chips as any)({ items, palette: { bg: t.card, fg: t.fg, muted: t.muted, accent: t.keys.claude } }, surface)
    const texts: { color: unknown; bg: unknown }[] = []
    walk(tree, undefined, texts)
    expect(texts.length).toBe(6)
    for (const x of texts) {
      expect(typeof x.color).toBe('string')
      expect(x.bg).toBe(t.card)
      expect(x.color).not.toBe(x.bg)
    }
  }
})

// The theme rule: in every theme, no text is drawn in its background's colour, Button text included:
// every Button's text is the mod's own Text in a theme colour, with no strip behind it.
for (const id of Object.keys(THEMES))
  test(`desktop, ${id}: no text in the background's colour, and every Button reads`, async ($, on) => {
    const t = THEMES[id]!
    mock.clock(on)
    mock.store(on, { layout: { theme: id } })
    await start($, on)
    const ui = await mount($, 'desktop')
    await ui.pointer({ type: 'down', x: 0, y: 0, button: 'left', in: 'press:settings' })
    expect(await ui.find({ key: 'setting-ticks-theme' })).toBeDefined()
    for (const x of await ui.findAll({ type: 'Text' })) {
      const c = (x as any).props?.color
      expect(typeof c).toBe('string')
      expect([t.bg, t.card]).not.toContain(c)
    }
    // Every clickable title is its own one-line surface in theme colours; no Button holds text.
    const holding = (await ui.findAll({ type: 'Button' })).filter(b => ((b as any).children ?? []).length > 0)
    expect(holding).toHaveLength(0)
    const titles = (await ui.findAll({ type: 'Client' })).filter(c => String((c as any).key).startsWith('press:'))
    expect(titles.length).toBeGreaterThan(3)
    for (const c of titles) for (const r of (c as any).props.props.runs) expect([t.bg, t.card]).not.toContain(r.color)
    expect((await ui.findAll({ type: 'Box' })).filter(b => (b as any).props?.backgroundColor !== undefined && (b as any).props?.backgroundColor !== t.card)).toHaveLength(0)
    // A task header still opens and closes the task, and a section title still folds its section.
    const task = titles.map(c => String((c as any).key)).find(k => k.startsWith('press:open-'))
    expect(task).toBeDefined()
    await ui.pointer({ type: 'down', x: 2, y: 0, button: 'left', in: task! })
    expect(await ui.find({ key: 'press:sec-tasks' })).toBeDefined()
    await ui.pointer({ type: 'down', x: 2, y: 0, button: 'left', in: 'press:sec-tasks' })
    expect(await ui.find({ key: task! })).toBeUndefined()
  })

// Sections can be moved, so every card is drawn alike: one border style and colour, whatever its place.
for (const surface of ['terminal', 'desktop'] as const)
  for (const id of [null, ...Object.keys(THEMES)])
    test(`${surface}, ${id ?? 'original'}: every card has the same border`, async ($, on) => {
      mock.clock(on)
      mock.store(on, id ? { layout: { theme: id } } : {})
      await start($, on)
      const ui = await mount($, surface)
      const cards = (await ui.findAll({ type: 'Box' })).filter(b => (b as any).props?.borderStyle !== undefined)
      expect(cards.length).toBeGreaterThan(3)
      const look = (b: any) => JSON.stringify([b.props.borderStyle, b.props.borderColor ?? null, b.props.borderDimColor ?? null, b.props.backgroundColor ?? null, b.props.hover ?? null])
      expect(new Set(cards.map(look)).size).toBe(1)
    })

test('targets: no upper end, a raised limit carries the one above, defaults are not stored, reset clears', () => {
  const base = cleanLayout(undefined)
  expect(targetsOf(base).memGood).toBe(4200)
  let l = applyLayoutMessage(base, { target: { id: 'memGood', by: 1 } })
  expect(l.targets).toEqual({ memGood: 4400 })
  l = applyLayoutMessage(l, { target: { id: 'memGood', by: -1 } })
  expect(l.targets).toBeUndefined()
  // Good passes 10,000 and Fine is carried 200 above it, read not stored.
  for (let i = 0; i < 40; i++) l = applyLayoutMessage(l, { target: { id: 'memGood', by: 1 } })
  expect(l.targets).toEqual({ memGood: 12200 })
  expect(canStep(l, 'memGood', 1)).toBe(true)
  expect(targetsOf(l).memFine).toBe(12400)
  expect(targetsOf(l).memBar).toBe(12400)
  // The carried Fine cannot go below Good; Good coming back down brings Fine back to its default.
  expect(canStep(l, 'memFine', -1)).toBe(false)
  for (let i = 0; i < 40; i++) l = applyLayoutMessage(l, { target: { id: 'memGood', by: -1 } })
  expect(l.targets).toBeUndefined()
  expect(targetsOf(l).memFine).toBe(5800)
  // A stored value far past the old ranges is kept as it is.
  expect(targetsOf(cleanLayout({ targets: { memGood: 99999 } })).memFine).toBe(100199)
  // Percents and requests go past 100 and 200; each stops only at its floor.
  let c = base
  for (let i = 0; i < 30; i++) c = applyLayoutMessage(c, { target: { id: 'ctxBad', by: 1 } })
  expect(targetsOf(c).ctxBad).toBe(235)
  let r = base
  for (let i = 0; i < 30; i++) r = applyLayoutMessage(r, { target: { id: 'turnMax', by: -1 } })
  expect(targetsOf(r).turnMax).toBe(1)
  expect(canStep(r, 'turnMax', -1)).toBe(false)
  expect(applyLayoutMessage(base, { target: { id: 'nope', by: 1 } })).toEqual(base)
  expect(applyLayoutMessage(base, { target: { id: 'turnMax', by: 5 } })).toEqual(base)
  expect(applyLayoutMessage(l, { target: 'reset' }).targets).toBeUndefined()
  // A stored value is kept when valid, raised to its floor when below, dropped when not a number.
  expect(cleanLayout({ targets: { turnMax: 30 } }).targets).toEqual({ turnMax: 30 })
  expect(cleanLayout({ targets: { turnMax: 9999 } }).targets).toEqual({ turnMax: 9999 })
  expect(cleanLayout({ targets: { turnMax: -4 } }).targets).toEqual({ turnMax: 1 })
  expect(cleanLayout({ targets: { turnMax: 'x', nope: 3 } }).targets).toBeUndefined()
})

test('targets: the Cache card menu steps a limit and the bars use it', async ($, on) => {
  mock.clock(on)
  await start($, on)
  const ui = await mount($, 'desktop')
  const shown = async () => (await ui.findAll({ type: 'Text' })).some(x => (x as any).props?.children === '16' || (x as any).children?.[0] === '16')
  expect(await ui.find({ key: 'tg-reset' })).toBeUndefined()
  // The targets live in the Cache card's own menu now.
  await ui.press({ key: 'cfg-cache' })
  expect(await shown()).toBe(false)
  await ui.press({ key: 'tg-turnMax-up' })
  expect(await shown()).toBe(true)
  expect(await ui.find({ key: 'tg-reset' })).toBeDefined()
  await ui.press({ key: 'tg-reset' })
  expect(await ui.find({ key: 'tg-reset' })).toBeUndefined()
})

// The Vitals stats never land one to a line at a width they fit: on desktop the surface wraps them by its own
// width, whatever width the first draw reports; in the terminal two halves sit on one line with no gap between.
for (const bodyColumns of [24, 48, 120])
  test(`stats: desktop wraps by its own width at ${bodyColumns} columns`, async ($, on) => {
    mock.clock(on)
    await start($, on)
    const ui = await mount($, 'desktop', bodyColumns)
    const boxes = (await ui.findAll({ type: 'Box' })) as any[]
    const rows = boxes.filter(b => b.props?.flexDirection === 'row' && b.props?.rowGap === 1 && b.props?.columnGap !== undefined && b.props?.flexWrap !== undefined)
    expect(rows.length).toBeGreaterThan(0)
    for (const r of rows) expect([r.props.flexWrap, r.props.justifyContent]).toEqual(['wrap', 'space-between'])
    expect(boxes.filter(b => b.props?.width === '50%' || (b.props?.width === '100%' && b.props?.flexDirection === 'column' && b.props?.flexShrink === 0))).toHaveLength(0)
  })

test('stats: terminal halves have no gap between them', async ($, on) => {
  mock.clock(on)
  await start($, on)
  const ui = await mount($, 'terminal', 48)
  const boxes = (await ui.findAll({ type: 'Box' })) as any[]
  const halves = boxes.filter(b => b.props?.width === '50%')
  expect(halves.length).toBeGreaterThan(0)
  const rows = boxes.filter(b => b.props?.flexWrap === 'wrap' && b.props?.columnGap === 0)
  expect(rows.length).toBeGreaterThan(0)
})

// The Main card's settings reflow: at a narrow terminal width each group takes the full row, nothing is wider than the pane.
test('settings: groups stack at a narrow width and fit', async ($, on) => {
  mock.clock(on)
  await start($, on)
  const ui = await mount($, 'terminal', 30)
  await ui.press({ key: 'settings' })
  for (const key of ['cards', 'main-extras', 'themes']) expect(((await ui.find({ key })) as any)?.props?.width).toBe('100%')
  expect(await ui.find({ type: 'Text', text: /^THEME$/ })).toBeDefined()
  const wide = await mount($, 'desktop', 120)
  await wide.press({ key: 'settings' }).catch(() => undefined)
  expect(((await wide.find({ key: 'themes' })) as any)?.props?.width).toBeUndefined()
})

// Session Totals: no weighted figure in Main; the snapshot total and main/agent rows from one read add up.
test('session totals: parts from one snapshot add up to the shown total; Main has cost per request and no weighted', async ($, on) => {
  mock.clock(on)
  const u = (calls: number, inp: number) => ({ input: inp, cacheWrite: 0, cacheRead: 0, output: 0, calls, usd: 0 })
  on('session.id', async () => ({ value: 'sid' }) as never)
  on('session.usage', async () => ({ value: { startedAt: 0, context: { window: 1000 }, rateLimits: [], cost: { usd: 3 } } }) as never)
  on('process.run', async () => ({ value: { exitCode: 0, stdout: JSON.stringify({ ms: 0, byModel: { 'claude-opus-5-5': { main: u(2, 2e6), agents: u(1, 1e6) } } }), stderr: '' } }) as never)
  await start($, on)
  for (let i = 0; i < 200; i++) await Promise.resolve()
  const ui = await mount($, 'terminal', 80)
  expect(await ui.find({ type: 'Text', text: /^COST \/ REQUEST$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^\$1\.00$/ })).toBeDefined()
  // Weighted lives in Session Totals (with the token figures), never in Main.
  expect(await ui.find({ type: 'Text', text: /^WEIGHTED$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^67%$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /main \$2\.00 · agents \$1\.00/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^\$3\.00$/ })).toBeDefined()
})
