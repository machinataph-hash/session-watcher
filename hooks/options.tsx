// The Settings choices drawn on their own surface, as the section chips are: a desktop Button draws
// its contents in the app's own ink, which a light theme cannot show. One row per choice; a press
// anywhere on a row posts its id. The hooks module keeps the layout; this only draws and posts.
import type { ClientModule } from 'claude-code'

type Item = { id: string; mark: string; label: string; isOn: boolean }
type Props = { items: Item[]; palette?: { bg: string; fg: string; muted: string; accent: string } }

const Options: ClientModule<Props, null> = (props, surface) => {
  const { Box, Text } = surface.elements
  const { items, palette: pal } = props
  surface.onPointer(p => {
    if (p.type !== 'down' || p.button !== 'left') return
    const item = items[Math.floor(p.y)]
    if (item) surface.post({ pick: item.id })
  })
  return (
    <Box flexDirection="column" backgroundColor={pal?.bg}>
      {items.map(it => (
        <Box key={it.id} flexDirection="row" height={1}>
          <Text color={it.isOn ? (pal?.accent ?? 'claude') : pal?.muted} dimColor={!pal && !it.isOn}>{it.mark}</Text>
          <Text bold={it.isOn} color={pal ? (it.isOn ? pal.fg : pal.muted) : undefined} dimColor={!pal && !it.isOn} wrap="truncate-end">{`  ${it.label}`}</Text>
        </Box>
      ))}
    </Box>
  )
}
export default Options
