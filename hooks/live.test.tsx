import { expect, mock, test } from 'claude-code/testing'

const usage = { model: 'claude-opus-5-5', input_tokens: 1000, output_tokens: 2000, cache_read_input_tokens: 100000, cache_creation_input_tokens: 4000 }
type Eng = Parameters<Extract<Parameters<typeof test>[1], (...a: never[]) => unknown>>[0]
type On = Parameters<Extract<Parameters<typeof test>[1], (...a: never[]) => unknown>>[1]

// The host's side: the engine's registrations, HOME, the page template, files written, the Artifact tool (list and
// publish) and the ArtifactData tool (the page's database). `saved` seeds the database's sessions/sid1 document.
const host = (on: On, saved?: unknown) => {
  const files = new Map<string, string>()
  const published: { file_path: string; icon?: string; url?: string; capabilities?: unknown }[] = []
  const writes: { collection: string; doc_id: string; data: Record<string, unknown> }[] = []
  on('command.register', async () => ({ value: { command: 'session-watcher' } }) as never)
  on('tool.register', async () => ({ value: { name: 'mark_task' } }) as never)
  on('ui.toast', async () => ({ value: undefined }) as never)
  on('session.id', async () => ({ value: 'sid1' }) as never)
  on('process.run', async () => ({ value: { exitCode: 0, stdout: '/home/me\n', stderr: '' } }) as never)
  on('fs.read', async (_, e) => {
    const path = (e as { path: string }).path
    return { value: files.get(path) ?? '<script id="state" type="application/json">__STATE__</script>' } as never
  })
  on('fs.write', async (_, e) => {
    files.set(e.path, e.text)
    return { value: undefined } as never
  })
  on('tool.call', { tool: 'Artifact' }, async (_, e) => {
    if ((e as { action?: string }).action === 'list') return { result: '1 published artifact:\n- (mine) Other page — https://claude.ai/artifact/Zz9 — updated 2026-11-01' } as never
    published.push(e as never)
    return { result: 'Published at https://claude.ai/artifact/AbC123', text: 'Published at https://claude.ai/artifact/AbC123' } as never
  })
  // As the real tool: a write to an existing document must carry its current version.
  const version = new Map<string, number>()
  on('tool.call', { tool: 'ArtifactData' }, async (_, e) => {
    const x = e as { action: string; collection: string; doc_id: string; data?: Record<string, unknown>; file_path?: string; out_dir?: string; if_version?: number }
    const key = `${x.collection}/${x.doc_id}`
    if (saved && !version.has('sessions/sid1')) version.set('sessions/sid1', 1)
    if (x.action === 'get') {
      if (!version.has(key)) return { result: 'Not found', isError: true } as never
      const body = JSON.stringify({ id: x.doc_id, data: key === 'sessions/sid1' && saved ? saved : {}, version: version.get(key) })
      return { result: `1 document from collection "${x.collection}":\n=== BEGIN ARTIFACT DB x ===\n${body}\n=== END ARTIFACT DB x ===` } as never
    }
    if (version.has(key) && x.if_version !== version.get(key)) return { result: `version_mismatch: current version ${version.get(key)}`, isError: true } as never
    version.set(key, (version.get(key) ?? 0) + 1)
    writes.push({ collection: x.collection, doc_id: x.doc_id, data: x.data ?? JSON.parse(files.get(x.file_path ?? '') ?? '{}') })
    return { result: `Wrote ${key}, version ${version.get(key)}` } as never
  })
  on('turn.step', async function* () {
    return { turnId: 't', index: 0, answer: '', toolUses: [], stopReason: 'end_turn', usage } as never
  })
  return { files, published, writes }
}
const start = ($: Eng) => ($.session.start as (e: unknown) => Promise<unknown>)({ source: 'startup', cwd: '/tmp' } as never).catch(() => undefined)
const step = async ($: Eng) => {
  for await (const _ of ($.turn.step as (e: unknown) => AsyncIterable<unknown>)({ turnId: 't', index: 0, model: usage.model, messageCount: 1 })) void _
}
const settle = async (clock: { advance: (ms: number) => Promise<void> }) => {
  for (let i = 0; i < 5; i++) await clock.advance(0)
}

test('live page: the page is published once, then each request writes the state, later ones wait for the interval', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  mock.store(on)
  const h = host(on)
  await start($)
  await step($)
  await settle(clock)
  // One shared page, made with its database, then this session's document and the shared limits.
  expect(h.published.length).toBe(1)
  expect(h.published[0]!.icon).toBe('gauge')
  expect(h.published[0]!.capabilities).toEqual({ db: {} })
  const docs = () => h.writes.filter(w => w.collection === 'sessions' && w.doc_id === 'sid1')
  expect(docs().length).toBe(1)
  expect((docs()[0]!.data.state as { calls: unknown[] }).calls.length).toBe(1)
  // Two more requests within 10 seconds: nothing yet; once the 10 seconds are up, one write with all three.
  await clock.advance(5_000)
  await step($)
  await step($)
  await settle(clock)
  expect(docs().length).toBe(1)
  await clock.advance(5_000)
  await settle(clock)
  expect(docs().length).toBe(2)
  expect((docs()[1]!.data.state as { calls: unknown[] }).calls.length).toBe(3)
  // The page's code did not change, so it is not published again.
  expect(h.published.length).toBe(1)
})

test('live page: after a restart the session’s saved requests and tasks come back from the page', async ($, on) => {
  const clock = mock.clock(on, { now: 2_000_000 })
  mock.store(on, { sharedPage: { url: 'https://claude.ai/artifact/AbC123', hash: 'old' } })
  const call = { at: 1_000_000, task: 'A1', who: 'main thread', model: 'claude-opus-5-5', effort: 'low', input: 1, cacheWrite: 2, cacheRead: 3, output: 4, usd: 0.5 }
  const h = host(on, { state: { calls: [call, call], tasks: [], log: [{ at: 1_000_000, who: 'you', text: 'hello', kind: 'info' }] } })
  await start($)
  await step($)
  await settle(clock)
  const doc = h.writes.filter(w => w.collection === 'sessions').at(-1)!
  expect((doc.data.state as { calls: unknown[] }).calls.length).toBe(3)
  expect((doc.data.state as { log: { text: string }[] }).log.some(l => l.text === 'hello')).toBe(true)
  // The kept page is updated in place: published again only because its code changed.
  expect(h.published[0]!.url).toBe('https://claude.ai/artifact/AbC123')
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
  expect(h.writes.length).toBe(0)
  await ($.command.run as (e: unknown) => Promise<unknown>)({ command: 'session-watcher', args: 'report' })
  await settle(clock)
  expect(h.published.length).toBe(1)
  expect(h.writes.filter(w => w.collection === 'sessions').length).toBe(1)
})
