import { expect, mock, test } from 'claude-code/testing'
// Regression: the pane with real stored state (the saved layout from the store, old fields, card extras), live
// vitals, tasks with calls, a sub-agent, a finished turn and the transcript read, drawn and every menu opened on
// desktop and terminal at 0, 30 and 120 columns. $.ui.mount rejects a tree the surface refuses.
const pane = { title: '', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} } as const
const usage = { model: 'claude-opus-5-5', input_tokens: 1000, output_tokens: 2000, cache_read_input_tokens: 100000, cache_creation_input_tokens: 4000 }
for (const theme of [undefined, 'frostwerk', 'reader'])
for (const cols of [0, 30, 120])
test(`desktop + terminal, real state, theme ${theme ?? "original"}, ${cols} columns`, async ($, on) => {
  mock.clock(on, { now: 5_000_000 })
  mock.store(on, { layout: theme ? { order: ['session', 'gate'], hidden: [], hideCacheBar: true, theme, targets: { memGood: 4400 }, cards: { vitals: { active: true, ttft: true }, session: { tokens: false } } } : { order: ['session', 'turn', 'tasks', 'requests', 'agents', 'cache', 'log', 'gate'], hidden: [], targets: { memGood: 8000, memFine: 12000, memBar: 20000 } } })
  on('command.register', async () => ({ value: { command: 'session-watcher' } }) as never)
  on('tool.register', async () => ({ value: { name: 'mark_task' } }) as never)
  on('session.id', async () => ({ value: 'sid' }) as never)
  on('session.usage', async () => ({ value: { startedAt: 1000, context: { window: 200000, tokens: 50000, percent: 25 }, rateLimits: [{ kind: 'five_hour', percentUsed: 30, resetsAt: '2026-10-30T10:00:00Z' }], cost: { usd: 3.2 } } }) as never)
  const cache = { first: 91525, rebuilds: [{ at: 1000, tokens: 91523, why: 'start' }], rebuildCount: 1, rebuildTokens: 91523, memoryChars: 5000, tools: [{ name: 'Read', chars: 3000, at: 1500 }] }
  const u = (calls: number, inp: number) => ({ input: inp, cacheWrite: 10, cacheRead: 1000, output: 50, calls, usd: 0 })
  on('process.run', async () => ({ value: { exitCode: 0, stdout: JSON.stringify({ ms: 10, byModel: { 'claude-opus-5-5': { main: u(2, 2e6), agents: u(1, 1e6) } }, cache }), stderr: '' } }) as never)
  on('turn.step', async function* () { return { turnId: 't', index: 0, answer: '', toolUses: [], stopReason: 'end_turn', usage } as never })
  await ($.session.start as any)({ source: 'startup', cwd: '/tmp' }).catch(() => undefined)
  await ($.turn.start as any)({ turnId: 't', text: 'go' }).catch(() => undefined)
  for await (const _ of ($.turn.step as any)({ turnId: 't', index: 0, model: usage.model, messageCount: 1 })) void _
  for await (const _ of ($.turn.step as any)({ turnId: 't', index: 0, model: usage.model, messageCount: 1, agentId: 'a1' })) void _
  await ($.turn.complete as any)({ turnId: 't', durationMs: 1000, reason: 'answer', answer: 'ok' }).catch(() => undefined)
  for (let i = 0; i < 200; i++) await Promise.resolve()
  for (const surface of ['desktop', 'terminal'] as const) {
    const ui = await $.ui.mount({ plugin: 'session-watcher', surface, component: 'Pane', requestId: 'session-watcher', props: { ...pane, bodyColumns: cols } })
    expect(await ui.find({ type: 'Text', text: /could not draw/ })).toBeUndefined()
    // A desktop Client that misses its 2000ms render answer tears the whole pane down, so desktop draws none.
    if (surface === 'desktop') expect(await ui.findAll({ type: 'Client' })).toHaveLength(0)
    for (const k of ['settings', 'cfg-session', 'cfg-cache', 'cfg-agents', 'sec-agents', 'sec-cache', 'sec-turn', 'sec-requests', 'sec-gate', 'sec-log', 'cfg-turn']) {
      if (await ui.find({ key: k })) await ui.press({ key: k })
      expect(await ui.find({ type: 'Text', text: /could not draw/ })).toBeUndefined()
    }
    await ui.unmount()
  }
})
