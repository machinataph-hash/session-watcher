// The section chips in Vitals' settings: one row per section. Press the box to show or hide it;
// press anywhere else on the row and drag to move it. Rows are one cell tall, so the row under
// the pointer is its y. The hooks module keeps the layout; this only draws and posts.
import type { ClientModule } from 'claude-code'

type Item = { id: string; title: string; isShown: boolean }
type Props = { items: Item[] }
// isHeld: the button is down. After the drop the row stays drawn where it was dropped, so the list
// does not jump back for the frames before the new order arrives; with it, from equals over again.
type Drag = { from: number; over: number; isHeld: boolean }
type State = Drag | null

// The drag as the pointer last left it, read by the next event even when a move and the release
// come in the same frame, before the state they set has been drawn.
let live: Drag | null = null

const Chips: ClientModule<Props, State> = (props, surface) => {
  const { Box, Text } = surface.elements
  const items = props.items
  const drag = surface.state ?? null
  const clamp = (y: number) => Math.max(0, Math.min(items.length - 1, Math.floor(y)))
  const set = (d: Drag | null) => {
    live = d
    surface.setState(d)
  }
  surface.onPointer(p => {
    if (p.type === 'down' && p.button === 'left') {
      const y = Math.floor(p.y)
      const item = items[y]
      if (!item) return
      if (p.x < 3) {
        set(null)
        surface.post({ toggle: item.id })
      } else set({ from: y, over: y, isHeld: true })
    } else if (p.type === 'move' && live?.isHeld) {
      const over = clamp(p.y)
      if (over !== live.over) set({ ...live, over })
    } else if (p.type === 'up' && live?.isHeld) {
      const item = items[live.from]
      if (item && live.over !== live.from) {
        surface.post({ move: { id: item.id, to: live.over } })
        set({ from: live.over, over: live.over, isHeld: false })
      } else set(null)
    }
  })
  // While dragging, the list is drawn in the order it will take when dropped.
  let shown = items
  if (drag && items[drag.from]) {
    const rest = items.filter((_, i) => i !== drag.from)
    shown = [...rest.slice(0, drag.over), items[drag.from] as Item, ...rest.slice(drag.over)]
  }
  return (
    <Box flexDirection="column">
      {shown.map(it => {
        const isDragged = drag !== null && drag.isHeld && items[drag.from]?.id === it.id
        return (
          <Box key={it.id} flexDirection="row" height={1}>
            <Text color={it.isShown ? 'claude' : undefined} dimColor={!it.isShown}>
              {it.isShown ? '☑' : '☐'}
            </Text>
            <Text dimColor>{'  ⠿ '}</Text>
            <Text bold={isDragged} color={isDragged ? 'claude' : undefined} dimColor={!it.isShown && !isDragged} wrap="truncate-end">
              {it.title}
            </Text>
          </Box>
        )
      })}
    </Box>
  )
}
export default Chips
