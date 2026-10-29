# Session Watcher design rules

Every card, on every surface and in every theme, follows these rules. `hooks/design.test.tsx` checks them on the drawn
tree at desktop widths 30, 60, 120 and 200 and terminal widths 80 and 140, settings closed and open, sample data on and off.

## 1. Grid
1.1 All card content sits one cell in from the card border (`INSET = 1`), on every card.
1.2 Nested rows (tick lists, the Cards list) sit one indent step further in (`INDENT = 1`). No other indent exists.
1.3 Table columns are separated by one cell; grid columns (stats, settings groups) by one as well (`COL_GAP = 1`), everywhere.

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
5.5 Each theme has one accent colour (`accent` in `hooks/core.ts` THEMES): every ⚙ on every card is always drawn in it, as are cost figures, focus rings and hovers. Original: the app's orange (`claude`). Frostwerk: blue `#00c2e8`. Reader: slate `#46545c`. A new theme sets `accent` along with bg, card, fg, muted and border.
5.4 Every theme ink is at least 4.5:1 against the theme's card and page background.

## 6. Grids (stat rows and settings groups)
6.1 Columns span the card wall to wall and are equal: every cell grows from zero (`flexGrow 1`, width 0, `minWidth 0`), so the first column starts on the left inset and the last ends on the right inset.
6.2 Each stat column needs at least 12 cells, each settings group 24. A grid shows the most columns that fit at that minimum, stepping down one column at a time (6, 5, 4, 3, 2, 1).
6.3 Every row of a grid has the same column count and widths; a short last row is padded with empty cells, never stretched.
6.4 Stats that belong together sit in one grid, so they stay on one row as long as they fit; Session Totals shows its cost split and token counts as one row of five.
6.5 All grids in one card share one column count (the card's widest row), so column edges line up from row to row; a shorter row is padded with empty cells.
6.4 When the surface reports no width, the grid hands the reflow to the surface: cells wrap at their minimum width.

## 7. Tables
7.1 Permissions, Recent Requests, Sub-Agents, Tasks and Session Totals each use one column-def list, shared by the header and every row, so a header cell has the same width and alignment as its values.
7.2 The free-text column (name, label) grows to fill the row; every numeric column is 8 cells wide and right-aligned, header included. Tables span wall to wall.
7.3 Below the table's minimum width (10 cells of text plus its fixed columns) each row stacks as "label: value" lines instead of squeezing.
7.4 Only free text truncates with an ellipsis. Numbers never truncate.
7.5 A table is one block: header and rows with no blank lines between them.
7.6 Activity and the Cache lists follow the same columns: a fixed time column, a growing text column, a right-aligned 8-cell number.

## 8. Bars
8.1 A bar fills the flexible column of its row; its value sits in a fixed numeric column on the right.

## 9. Label/value rows
9.1 Label (a heading) left; a dim note then the bold value right. One helper draws every such row (Context, Total, Memory index).

## 10. Controls
10.1 A tick is `☑` when on and `☐` when off, one Unicode pair drawn in the monospaced face so both are one width. The state shows in the glyph itself, because a desktop Button ignores colour.
10.2 A tick and its label are separated by two spaces on every list.
10.3 The disclosure arrow is one glyph plus a space in both states (`▾ `, `▸ `). A list's arrow column is 3 cells, with a blank placeholder where no arrow shows.
10.4 Buttons have one style: the surface's own Button; under a terminal theme, an accent `[ label ]` in the theme's ink.

## 11. Settings
11.1 Main's settings groups are a grid (rule 6): equal columns wall to wall, at least 24 cells each, then 2-up, then stacked.

## 12. Resizing
12.1 Narrow (under 40 columns): grids go 1-up, tables stack as label: value rows, secondary columns drop.
12.2 Medium (40 to 99): grids take as many equal columns as fit at their minimum; columns that need room (model, calls, input + write) appear from 54 columns.
12.3 Wide (100 and over): all columns show; grids and tables stretch wall to wall.
12.4 Free text truncates; grids and tick lists reflow; nothing scrolls sideways.

## 13. Themes
13.1 All themes draw the same layout; only colours change.
