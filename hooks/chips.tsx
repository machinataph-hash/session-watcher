// The section chips in Vitals' settings: one row per section. Click anywhere on a row to show or
// hide it; press and drag it to another row to move it. Rows are one cell tall, so the row under
// the pointer is its y. The hooks module keeps the layout; this only draws and posts.
import type { ClientModule } from 'claude-code'

type Item = { id: string; title: string; isShown: boolean }
// isFixed: a plain tick list (themes, a flag): no drag and no handle; a click posts { pick: id }.
type Props = { items: Item[]; isFixed?: boolean; palette?: { bg: string; fg: string; muted: string; accent: string } }
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
  const pal = props.palette
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
      if (props.isFixed) {
        surface.post({ pick: item.id })
        return
      }
      // A click anywhere on the row ticks it; a drag to another row moves it. The release decides.
      set({ from: y, over: y, isHeld: true })
    } else if (p.type === 'move' && live?.isHeld) {
      const over = clamp(p.y)
      if (over !== live.over) set({ ...live, over })
    } else if (p.type === 'up' && live?.isHeld) {
      const item = items[live.from]
      if (item && live.over !== live.from) {
        surface.post({ move: { id: item.id, to: live.over } })
        set({ from: live.over, over: live.over, isHeld: false })
      } else {
        set(null)
        if (item) surface.post({ toggle: item.id })
      }
    }
  })
  // While dragging, the list is drawn in the order it will take when dropped.
  let shown = items
  if (drag && items[drag.from]) {
    const rest = items.filter((_, i) => i !== drag.from)
    shown = [...rest.slice(0, drag.over), items[drag.from] as Item, ...rest.slice(drag.over)]
  }
  // A Client draws on its own surface, which does not take the theme's card colour: set it here, or the
  // theme's ink lands on the app's own background.
  return (
    <Box flexDirection="column" backgroundColor={pal?.bg}>
      {shown.map(it => {
        const isDragged = drag !== null && drag.isHeld && items[drag.from]?.id === it.id
        return (
          <Box key={it.id} flexDirection="row" height={1}>
            <Text color={it.isShown ? (pal?.accent ?? 'claude') : pal?.muted} dimColor={!pal && !it.isShown}>
              {it.isShown ? '■' : '□'}
            </Text>
            <Text color={pal?.muted} dimColor={!pal}>{props.isFixed ? '  ' : '  ⠿ '}</Text>
            <Text bold={isDragged} color={isDragged ? (pal?.accent ?? 'claude') : pal ? (it.isShown ? pal.fg : pal.muted) : undefined} dimColor={!pal && !it.isShown && !isDragged} wrap="truncate-end">
              {it.title}
            </Text>
          </Box>
        )
      })}
    </Box>
  )
}
export default Chips
