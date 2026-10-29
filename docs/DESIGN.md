# Session Watcher design rules

Every card, on every surface and in every theme, follows these rules. `hooks/design.test.tsx` checks them on the drawn
tree at desktop widths 30, 60, 120 and 200 and terminal widths 80 and 140, settings closed and open, sample data on and off.

## 1. Grid
1.1 All card content sits one cell in from the card border (`INSET = 1`), on every card.
1.2 Nested rows (tick lists, the Cards list) sit one indent step further in (`INDENT = 1`). No other indent exists.
1.3 Columns of a row are separated by one cell; groups and stat columns by two (`COL_GAP = 2`).

## 2. Card template
2.1 Title row: disclosure arrow and name on the left; dim summary, then the gear, on the right. The gear is one size on every card.
2.2 Closed: the title row only. Open: the title row, then the body.
2.3 Settings open: title row, one divider, the menu, one divider, the body.
2.4 A divider is one clean line edge to edge, never text cut with an ellipsis: a 1px SVG line on the desktop, exactly the card's inner width of `─` in the terminal.
2.5 No other horizontal or vertical rule is drawn anywhere.
2.6 All titles use one style: bold, body size. State is shown by colour, not size.

## 3. Vertical rhythm
3.1 One blank line between blocks in a card, and between cards.
3.2 No blank line between a heading and its content, or between the rows of one table or list.

## 4. Typography
4.1 Section headings: capitals, bold, dim, one size.
4.2 Values: bold, tabular figures.
4.3 Notes and sub-lines: footnote size, dim.
4.4 A stat reads label, value, sub-line, top to bottom, on every card.

## 5. Colour and contrast
5.1 All text meets WCAG AA: 4.5:1 against the background it sits on; glyphs and bars at least 3:1.
5.2 The Original theme uses only the app's named, adaptive colours, so it reads in the app's light and dark modes. No fixed white or black.
5.3 Themes repaint only where every control takes the theme's ink (the terminal). A desktop Button keeps the app's ink, so the desktop keeps the app's colours in every theme.
5.4 Every theme ink is at least 4.5:1 against the theme's card and page background.

## 6. Stat columns
6.1 Every stat column is 20 cells wide, packed from the left, and wraps to the next line; columns line up across rows and cards.
6.2 A pane narrower than one column gives each stat the full row.

## 7. Tables
7.1 Permissions, Cache lists, Recent Requests, Activity, Tasks, Sub-Agents and Session Totals tables use fixed column widths: time 5, count 6, tokens 7, percent 5, cost 8.
7.2 A header cell has the same width and alignment as its column's values.
7.3 Numbers are right-aligned with tabular figures; text is left-aligned.
7.4 Only free text (names, descriptions) truncates with an ellipsis, in the one flexible column. Numbers never truncate.
7.5 A table is one block: header and rows with no blank lines between them.

## 8. Bars
8.1 A bar fills the flexible column of its row; its value sits in a fixed numeric column on the right.

## 9. Label/value rows
9.1 Label (a heading) left; a dim note then the bold value right. One helper draws every such row (Context, Total, Memory index).

## 10. Controls
10.1 A tick is one glyph (`■`) at one size in both states: on is bold and accent, off is dim.
10.2 A tick and its label are separated by two spaces on every list.
10.3 The disclosure arrow is one glyph plus a space in both states (`▾ `, `▸ `). A list's arrow column is 3 cells, with a blank placeholder where no arrow shows.
10.4 Buttons have one style: the surface's own Button; under a terminal theme, an accent `[ label ]` in the theme's ink.

## 11. Settings
11.1 Main's settings groups are 30 cells wide, packed from the left, and wrap; their headings and controls align at every width.
11.2 A pane narrower than one group stacks the groups at full width.

## 12. Resizing
12.1 Narrow (under 40 columns): secondary columns (model, calls, cache read, who in Activity) and the task summary drop; stats and settings groups stack.
12.2 Medium (40 to 99): the core columns show; columns that need room (model, calls, input + write) appear from 54 columns.
12.3 Wide (100 and over): nothing new appears; the flexible text column and bars take the extra room, and stats and groups fit more per line.
12.4 Free text truncates; stats, groups and tick lists wrap. Nothing scrolls sideways.

## 13. Themes
13.1 All themes draw the same layout; only colours change.
