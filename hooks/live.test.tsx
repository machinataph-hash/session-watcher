import { expect, mock, test } from 'claude-code/testing'

const usage = { model: 'claude-opus-5-5', input_tokens: 1000, output_tokens: 2000, cache_read_input_tokens: 100000, cache_creation_input_tokens: 4000 }
type Eng = Parameters<Extract<Parameters<typeof test>[1], (...a: never[]) => unknown>>[0]
type On = Parameters<Extract<Parameters<typeof test>[1], (...a: never[]) => unknown>>[1]

// The host's side: the engine's registrations, HOME, the page template, files written, and the Artifact tool.
const host = (on: On) => {
  const files = new Map<string, string>()
  const published: { file_path: string; icon?: string }[] = []
  on('command.register', async () => ({ value: { command: 'session-watcher' } }) as never)
  on('tool.register', async () => ({ value: { name: 'mark_task' } }) as never)
  on('ui.toast', async () => ({ value: undefined }) as never)
  on('session.id', async () => ({ value: 'sid1' }) as never)
  on('process.run', async () => ({ value: { exitCode: 0, stdout: '/home/me\n', stderr: '' } }) as never)
  on('fs.read', async () => ({ value: '<script id="state" type="application/json">__STATE__</script>' }) as never)
  on('fs.write', async (_, e) => {
    files.set(e.path, e.text)
    return { value: undefined } as never
  })
  on('tool.call', { tool: 'Artifact' }, async (_, e) => {
    published.push(e as never)
    return { result: 'Published at https://claude.ai/artifact/AbC123', text: 'Published at https://claude.ai/artifact/AbC123' } as never
  })
  on('turn.step', async function* () {
    return { turnId: 't', index: 0, answer: '', toolUses: [], stopReason: 'end_turn', usage } as never
  })
  return { files, published }
}
const start = ($: Eng) => ($.session.start as (e: unknown) => Promise<unknown>)({ source: 'startup', cwd: '/tmp' } as never).catch(() => undefined)
const step = async ($: Eng) => {
  for await (const _ of ($.turn.step as (e: unknown) => AsyncIterable<unknown>)({ turnId: 't', index: 0, model: usage.model, messageCount: 1 })) void _
}
const settle = async (clock: { advance: (ms: number) => Promise<void> }) => {
  for (let i = 0; i < 5; i++) await clock.advance(0)
}

test('live page: a request publishes the state, later ones wait for the interval and the last is not lost', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  mock.store(on)
  const h = host(on)
  await start($)
  await step($)
  await settle(clock)
  expect(h.published.length).toBe(1)
  expect(h.published[0]!.icon).toBe('gauge')
  const path = h.published[0]!.file_path
  expect(path).toMatch(/^\/home\/me\/\.claude\/session-watcher\/live\/.+\/session-watcher\.html$/)
  // The page holds the state: the request just made.
  const state = JSON.parse(/>(.*)<\/script>/.exec(h.files.get(path) ?? '')![1]!)
  expect(state.calls.length).toBe(1)
  // Two more requests within 20 seconds: nothing yet; once the 20 seconds are up, one publish with both.
  await clock.advance(5_000)
  await step($)
  await step($)
  await settle(clock)
  expect(h.published.length).toBe(1)
  await clock.advance(15_000)
  await settle(clock)
  expect(h.published.length).toBe(2)
  expect(h.published[1]!.icon).toBeUndefined()
  expect(JSON.parse(/>(.*)<\/script>/.exec(h.files.get(path) ?? '')![1]!).calls.length).toBe(3)
})

test('live page: off stops it, report publishes once, and the setting is kept', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  mock.store(on)
  const h = host(on)
  await start($)
  const off = await ($.command.run as (e: unknown) => Promise<{ text?: string }>)({ command: 'session-watcher', args: 'live off' })
  expect(off.text).toMatch(/off/)
  await step($)
  await settle(clock)
  expect(h.published.length).toBe(0)
  await ($.command.run as (e: unknown) => Promise<unknown>)({ command: 'session-watcher', args: 'report' })
  await settle(clock)
  expect(h.published.length).toBe(1)
})
