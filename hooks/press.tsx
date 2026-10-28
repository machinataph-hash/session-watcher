// One pressable line drawn on its own surface: a desktop Button draws its contents in the app's own
// ink, which a theme cannot reach, so under a theme every clickable title is drawn here, in the
// theme's colours. A press anywhere on the line posts { press: true }; the hooks module acts on it.
import type { ClientModule } from 'claude-code'

export type Run = { text: string; color: string; bold?: boolean }
type Props = { runs: Run[]; bg: string }

const Press: ClientModule<Props, null> = (props, surface) => {
  const { Box, Text } = surface.elements
  surface.onPointer(p => {
    if (p.type === 'down' && p.button === 'left') surface.post({ press: true })
  })
  return (
    <Box flexDirection="row" height={1} backgroundColor={props.bg}>
      <Text wrap="truncate-end">
        {props.runs.map((r, i) => <Text key={`r${i}`} color={r.color} bold={r.bold}>{r.text}</Text>)}
      </Text>
    </Box>
  )
}
export default Press
