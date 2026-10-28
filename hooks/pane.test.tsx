import { expect, mock, test } from 'claude-code/testing'
import Chips from './chips'
import Options from './options'
import { applyLayoutMessage, breakdownText, cleanLayout, defaultLayout, emptyLimitModel, estimateLimit, fromModel, paint, THEMES, stepLimitModel, usdOf, weighted } from './core'

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
  expect(await ui.find({ type: 'Text', text: /memory index 18k chars \(target 4,200\)/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^STARTING LOAD$/ })).toBeUndefined()
  await ui.press({ key: 'sec-cache' })
  expect(await ui.find({ type: 'Text', text: /^STARTING LOAD$/ })).toBeDefined()
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

// Requests this turn are shown in Cache health only; Vitals carries no turn-count warning.
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
    expect(await ui.find({ type: 'Text', text: /SECTIONS · TICK/ })).toBeUndefined()
    await ui.press({ key: 'settings' })
    expect(await ui.find({ type: 'Text', text: /SECTIONS · TICK/ })).toBeDefined()
    // Untick Tasks (row 1): its section goes, its chip stays.
    expect(await ui.find({ type: 'Text', text: /^Tasks$/ })).toBeDefined()
    await ui.pointer({ type: 'down', x: 0, y: 1, button: 'left', in: 'section-chips' })
    await ui.pointer({ type: 'up', x: 0, y: 1, button: 'left', in: 'section-chips' })
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
    expect(await ui.find({ type: 'Text', text: /SECTIONS · TICK/ })).toBeUndefined()
  })

// The theme choices and the Cache health bar flag are drawn on their own surface; a press on a row picks it.
test('desktop: a press on a theme row picks that theme, and it is saved', async ($, on) => {
  mock.clock(on)
  mock.store(on)
  await start($, on)
  const ui = await mount($, 'desktop')
  await ui.press({ key: 'settings' })
  // Rows: Original, Frostwerk, Reader.
  await ui.pointer({ type: 'down', x: 4, y: 2, button: 'left', in: 'settings-options-theme' })
  const on_ = async (key: string) => ((await ui.find({ key })) as any)?.props?.props?.items.filter((i: any) => i.isOn).map((i: any) => i.id)
  expect(await on_('settings-options-theme')).toEqual(['reader'])
  await ui.pointer({ type: 'down', x: 4, y: 0, button: 'left', in: 'settings-options-cache' })
  expect(await on_('settings-options-cache')).toEqual([])
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

test('layout: cache-bar flag and theme are kept, unknown themes dropped', () => {
  let l = applyLayoutMessage(cleanLayout(undefined), { flag: 'cacheBar' })
  expect(l.hideCacheBar).toBe(true)
  l = applyLayoutMessage(l, { flag: 'cacheBar' })
  expect(l.hideCacheBar).toBeFalsy()
  l = applyLayoutMessage(l, { theme: 'reader' })
  expect(cleanLayout(l).theme).toBe('reader')
  expect(cleanLayout({ ...l, theme: 'nope' }).theme).toBeUndefined()
  expect(applyLayoutMessage(l, { theme: null }).theme).toBeUndefined()
})

test('paint: root gets the theme background, plain text the theme ink', () => {
  const t = THEMES.frostwerk!
  const out = paint({ type: 'Box', props: {}, children: [{ type: 'Text', props: { dimColor: true }, children: ['x'] }] } as never, t) as any
  expect(out.props.backgroundColor).toBe(t.bg)
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
    const surface0 = { elements: { Box: el('Box'), Text: el('Text') }, state: null, setState() {}, onPointer() {}, post() {} }
    const choices = [{ id: 'app', mark: '○', label: 'Original', isOn: false }, { id: 'reader', mark: '◉', label: 'Reader', isOn: true }]
    const optTexts: { color: unknown; bg: unknown }[] = []
    walk((Options as any)({ items: choices, palette: { bg: t.card, fg: t.fg, muted: t.muted, accent: t.keys.claude } }, surface0), undefined, optTexts)
    expect(optTexts.length).toBe(4)
    for (const x of optTexts) {
      expect(typeof x.color).toBe('string')
      expect(x.bg).toBe(t.card)
      expect(x.color).not.toBe(x.bg)
    }
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

// The theme rule: in every theme, no text is drawn in its background's colour. A desktop Button keeps
// the app's ink, so under a theme no Button may hold text; clickable titles are drawn on their own surface.
for (const id of Object.keys(THEMES))
  test(`desktop, ${id}: no text in the background's colour, and no Button holds text`, async ($, on) => {
    const t = THEMES[id]!
    mock.clock(on)
    mock.store(on, { layout: { theme: id } })
    await start($, on)
    const ui = await mount($, 'desktop')
    await ui.pointer({ type: 'down', x: 0, y: 0, button: 'left', in: 'press:sec:settings-open' })
    expect(await ui.find({ key: 'settings-options-theme' })).toBeDefined()
    const bgs = [t.bg, t.card]
    // Only labelled chrome Buttons (Copy CSV) remain, and they draw no Text of ours.
    const buttons = await ui.findAll({ type: 'Button' })
    for (const b of buttons) {
      expect({ key: (b as any).key, label: typeof (b as any).props?.label, children: ((b as any).children ?? []).length })
        .toEqual({ key: (b as any).key, label: 'string', children: 0 })
    }
    // A task header is pressable too, and the press reaches its handler.
    const task = (await ui.findAll({ type: 'Client' })).map(c => String((c as any).key)).find(k => k.startsWith('press:task:'))
    expect(task).toBeDefined()
    await ui.pointer({ type: 'down', x: 0, y: 0, button: 'left', in: task! })
    for (const x of await ui.findAll({ type: 'Text' })) {
      const c = (x as any).props?.color
      expect(typeof c).toBe('string')
      expect(bgs).not.toContain(c)
    }
    for (const c of await ui.findAll({ type: 'Client' })) {
      const p = (c as any).props?.props
      const colours: string[] = [
        ...(p.runs ?? []).map((r: any) => r.color),
        ...(p.palette ? [p.palette.fg, p.palette.muted, p.palette.accent] : []),
      ]
      for (const col of colours) expect([p.bg ?? p.palette?.bg]).not.toContain(col)
      expect(p.bg ?? p.palette?.bg).toBe(t.card)
    }
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
