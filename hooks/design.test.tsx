import { expect, mock, test } from 'claude-code/testing'
import { THEMES } from './core'

// docs/DESIGN.md, asserted on the drawn tree: every card, at the widths the spec names, settings closed and open,
// sample data on and off, in every theme. Each rule names its spec number.
type El = { type?: string; key?: string; props?: Record<string, any>; children?: unknown[] }
const pane = { title: '', isFocused: false, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} } as const
const kids = (n: El): El[] => {
  const c = [...(n.children ?? []), ...(Array.isArray(n.props?.children) ? n.props!.children : n.props?.children ? [n.props.children] : [])]
  return c.flat(Infinity as 1).filter(x => x && typeof x === 'object') as El[]
}
const walk = (n: El, f: (n: El, parent?: El) => void, parent?: El) => {
  f(n, parent)
  for (const c of kids(n)) walk(c, f, n)
}
const all = (root: El) => {
  const out: El[] = []
  walk(root, n => out.push(n))
  return out
}
const keyOf = (n: El) => n.key ?? n.props?.key
const textOf = (n: El): string => (n.type === 'Text' ? '' : '') + [...(n.children ?? []), ...(n.props?.children !== undefined ? [n.props.children] : [])].flat(Infinity as 1).map(c => (typeof c === 'string' || typeof c === 'number' ? String(c) : c && typeof c === 'object' ? textOf(c as El) : '')).join('')

const CASES = [
  ...[30, 60, 120, 200].map(cols => ({ surface: 'desktop' as const, cols })),
  ...[80, 140].map(cols => ({ surface: 'terminal' as const, cols })),
]
const ORDER = ['session', 'turn', 'tasks', 'requests', 'agents', 'cache', 'gate', 'log']

const setup = async ($: any, on: any, store: Record<string, unknown>) => {
  mock.clock(on, { now: 5_000_000 })
  mock.store(on, { layout: { order: ORDER, hidden: [], ...store } })
  on('command.register', async () => ({ value: { command: 'session-watcher' } }) as never)
  on('tool.register', async () => ({ value: { name: 'mark_task' } }) as never)
  await ($.session.start as any)({ source: 'startup', cwd: '/tmp' }).catch(() => undefined)
}
const mountAt = ($: any, surface: string, cols: number) =>
  $.ui.mount({ plugin: 'session-watcher', surface, component: 'Pane', requestId: 'session-watcher', props: { ...pane, bodyColumns: cols } })

// Rules that hold for any drawing.
const checkTree = (root: El, cols: number, surface: string) => {
  const els = all(root)
  // 1.1 one inset: every card has paddingX 1.
  const cards = els.filter(n => n.type === 'Box' && n.props?.borderStyle !== undefined)
  expect(cards.length).toBeGreaterThan(0)
  for (const c of cards) expect(c.props!.paddingX).toBe(1)
  // 1.2 one indent step for nested rows.
  for (const n of els) if (n.type === 'Box' && n.props?.paddingLeft !== undefined) expect(n.props.paddingLeft).toBe(1)
  // 2.4 dividers: only the two of an open menu, first and last in it; never an ellipsis, terminal exactly the card's inner width.
  const menus = els.filter(n => keyOf(n) === 'menu')
  const seps = els.filter(n => /^sep-(top|bottom)$/.test(String(keyOf(n))))
  expect(seps.length).toBe(2 * menus.length)
  for (const m of menus) {
    const k = kids(m)
    expect(keyOf(k[0]!)).toBe('sep-top')
    expect(keyOf(k.at(-1)!)).toBe('sep-bottom')
  }
  for (const s of seps) {
    const t = textOf(s)
    expect(t).not.toContain('…')
    expect(s.props?.wrap).toBeUndefined()
    if (surface === 'terminal') expect(t).toBe('─'.repeat(Math.max(28, cols) - 4))
    else expect(t).toBe('')
  }
  for (const n of els) if (n.type === 'Text' && /^─+…?$/.test(textOf(n))) expect(textOf(n)).not.toContain('…')
  // 7 tables: the header row and every value row share one column-width sequence; numeric cells right-aligned.
  for (const n of els) {
    const k = kids(n)
    const head = k.find(c => keyOf(c) === 'head' && c.props?.flexDirection === 'row')
    if (!head || n.props?.flexDirection !== 'column') continue
    const widths = (r: El) => kids(r).filter(c => c.type === 'Box').map(c => c.props?.width ?? (c.props?.flexGrow ? 'flex' : '?'))
    const hw = widths(head)
    for (const r of k) if (r !== head && r.type === 'Box' && r.props?.flexDirection === 'row' && keyOf(r) !== 'split') expect(widths(r)).toEqual(hw)
  }
  for (const n of els) {
    if (n.type !== 'Box' || typeof n.props?.width !== 'number' || n.props?.justifyContent === undefined) continue
    const t = textOf(n).trim()
    if (/^[$\d][\d.,]*[k%M]?$|^—$/.test(t)) expect(n.props.justifyContent).toBe('flex-end')
  }
  // 6 stat columns: one width (or the full row when the pane is narrower than one).
  const statRows = els.filter(n => n.type === 'Box' && n.props?.flexWrap === 'wrap' && n.props?.rowGap === 1 && kids(n).some(c => c.props?.flexDirection === 'column' && c.props?.flexShrink === 0 && keyOf(c) !== 'cards'))
  const statW = new Set(statRows.flatMap(r => kids(r).filter(c => c.props?.flexShrink === 0 && !['cards', 'main-extras', 'sample', 'themes'].includes(String(keyOf(c)))).map(c => c.props?.width)))
  if (statRows.length > 0) expect(statW.size).toBe(1)
  for (const r of statRows) expect(r.props!.justifyContent).toBe('flex-start')
  // 10.1 ticks: one glyph both ways; 10.2 the disclosure arrow is one width both ways.
  for (const n of els) {
    const t = n.type === 'Text' ? String((n.children ?? [])[0] ?? n.props?.children ?? '') : ''
    if (/^[☑☐□▣✓✔]$/.test(t)) throw new Error(`tick glyph ${t}`)
    if (/^[▾▸]/.test(t)) expect(t.length).toBe(2)
  }
}

for (const { surface, cols } of CASES)
  for (const sample of [true, false])
    test(`design: ${surface} ${cols} cols, sample ${sample ? 'on' : 'off'}: every card meets the spec, settings closed and open`, async ($, on) => {
      await setup($, on, { sample })
      const ui = await mountAt($, surface, cols)
      checkTree((await ui.drawn()) as El, cols, surface)
      expect(await ui.findAll({ key: 'menu' })).toHaveLength(0)
      await ui.press({ key: 'settings' })
      await ui.press({ key: 'toggle-all' })
      const open = (await ui.drawn()) as El
      checkTree(open, cols, surface)
      expect((await ui.findAll({ key: 'menu' })).length).toBeGreaterThan(5)
      expect(await ui.find({ type: 'Text', text: /could not draw/ })).toBeUndefined()
      await ui.press({ key: 'toggle-all' })
      await ui.press({ key: 'settings' })
      checkTree((await ui.drawn()) as El, cols, surface)
      expect(await ui.findAll({ key: 'menu' })).toHaveLength(0)
    })

// 12 themes: the same layout in every theme; only colours change.
const shape = (n: unknown): unknown => {
  if (Array.isArray(n)) return n.map(shape)
  if (!n || typeof n !== 'object') return n
  const x = n as El
  const p: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(x.props ?? {})) if (!/color|Color|palette|bg|runs/.test(k)) p[k] = k === 'children' ? shape(v) : v
  return { type: x.type, p, c: shape(x.children ?? []) }
}
const shapes: Record<string, string[]> = {}
for (const { surface, cols } of CASES) {
  for (const theme of [undefined, ...Object.keys(THEMES)])
    test(`design: ${surface} ${cols} cols, theme ${theme ?? 'app'}: drawn for the comparison`, async ($, on) => {
      await setup($, on, { sample: true, ...(theme ? { theme } : {}) })
      const ui = await mountAt($, surface, cols)
      ;(shapes[`${surface}${cols}`] ??= []).push(JSON.stringify(shape(await ui.drawn())))
    })
  test(`design: ${surface} ${cols} cols: the layout is the same in every theme`, () => {
    const s = shapes[`${surface}${cols}`]!
    expect(s.length).toBe(1 + Object.keys(THEMES).length)
    // A themed terminal draws each title as a one-line Client in the theme's ink; the cards around them match.
    const cardsOf = (x: string) => (x.match(/"borderStyle":"single"/g) ?? []).length
    expect(new Set(s.map(cardsOf)).size).toBe(1)
    if (surface === 'desktop') expect(new Set(s).size).toBe(1)
  })
}

// 13 contrast (WCAG AA): text 4.5:1 against the card it sits on, in every theme; the desktop keeps the app's adaptive
// named colours (a desktop Button cannot take a theme's ink), so no hex colour and no background reach it.
const lum = (h: string) => {
  const c = [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16) / 255).map(v => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
  return 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!
}
const ratio = (a: string, b: string) => {
  const [x, y] = [lum(a), lum(b)]
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05)
}
test('contrast: every theme ink is at least 4.5:1 against its card and its page background', () => {
  for (const t of Object.values(THEMES)) {
    for (const ink of [t.fg, t.muted, ...Object.values(t.keys)]) {
      expect(ratio(ink, t.card)).toBeGreaterThanOrEqual(4.5)
      expect(ratio(ink, t.bg)).toBeGreaterThanOrEqual(4.5)
    }
  }
})
for (const theme of [undefined, ...Object.keys(THEMES)])
  test(`contrast: terminal ${theme ?? 'app'}: every coloured text meets AA against its background`, async ($, on) => {
    await setup($, on, { sample: true, ...(theme ? { theme } : {}) })
    const ui = await mountAt($, 'terminal', 80)
    const root = (await ui.drawn()) as El
    const t = theme ? THEMES[theme]! : undefined
    let checked = 0
    const visit = (n: El, bg: string | undefined) => {
      const here = typeof n.props?.backgroundColor === 'string' && n.props.backgroundColor.startsWith('#') ? n.props.backgroundColor : bg
      const c = n.props?.color
      if (n.type === 'Text' && typeof c === 'string' && c.startsWith('#') && here) {
        expect(ratio(c, here)).toBeGreaterThanOrEqual(4.5)
        checked++
      }
      for (const k of kids(n)) visit(k, here)
    }
    visit(root, t?.bg)
    if (t) expect(checked).toBeGreaterThan(20)
    // Original: only the app's named, adaptive colours; never a fixed white or black.
    else for (const n of all(root)) for (const k of ['color', 'backgroundColor']) expect(String(n.props?.[k] ?? '')).not.toMatch(/^#|white|black/)
  })
for (const theme of [undefined, ...Object.keys(THEMES)])
  for (const sample of [true, false])
    test(`contrast: desktop ${theme ?? 'app'}, sample ${sample ? 'on' : 'off'}: only adaptive colours, light and dark mode alike`, async ($, on) => {
      await setup($, on, { sample, ...(theme ? { theme } : {}) })
      const ui = await mountAt($, 'desktop', 60)
      await ui.press({ key: 'settings' })
      await ui.press({ key: 'toggle-all' })
      for (const n of all((await ui.drawn()) as El)) {
        if (n.type === 'Svg') continue
        for (const k of ['color', 'backgroundColor', 'borderColor']) expect(String(n.props?.[k] ?? '')).not.toMatch(/^#|white|black/)
      }
      expect(await ui.findAll({ type: 'Client' })).toHaveLength(0)
    })
