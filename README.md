# Session Watcher

**A Claude Code mod that puts your session's cost, tokens and activity in one pane**: context and rate limits, Claude Code's own cost, token use for the whole session, per task and per request, your sub-agents, every permission check, and a log of what happened. Every number comes from a real session event or the session's own transcript, and nothing leaves your machine.

It builds on the token-use mod and takes ideas from [Flightdeck](https://github.com/scasella/claude-flightdeck).

<p align="center">
  <img src="docs/pane-original.png" alt="The Session Watcher pane in the Original theme: vitals with context, cost, rate limits and cache health, then session totals and tasks" width="400">
  <img src="docs/pane-frostwerk.png" alt="The same pane in the Frostwerk theme" width="400">
</p>
<p align="center"><sub>The Original theme (left) and Frostwerk (right).</sub></p>

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install session-watcher --marketplace machinataph-hash/session-watcher
```

Answer `y` to add the marketplace, then pick a scope. From a shell:

```sh
claude plugin install session-watcher --marketplace machinataph-hash/session-watcher
```

It needs `python3` on your PATH for the session totals and active time. Mods are an early-access Claude Code feature, and their API can change between releases.

## Use

| Command | Does |
| --- | --- |
| `/session-watcher` | open the pane |
| `/session-watcher close` | close it |
| `/session-watcher reset` | put every section back to its starting open or closed state |

Click a section's title to open or close it. The top card is always shown. Session totals and Tasks start open, and the rest start closed, so you choose what you see. The pane opens by itself when a session starts.

## What you see

| Section | Shows | From |
| --- | --- | --- |
| **Vitals** (always shown) | model, effort and permission mode; whether a turn is running; time to first token; a context bar measured against the window the session compacts at (`autoCompactWindow` in settings, else the model's window), amber at 65% and red at 85% by default; compactions; cost, how long the session has run, how much of that was active, and request count, a row that pressing the model's name folds away (Session totals keeps the cost and request count); the 5-hour and 7-day limits with time to reset; the engine gives whole percents, so once two percent steps have been measured each limit shows a two-decimal estimate (`37.42%`): the spend since the last step divided by the median dollars per percent of the last five steps, counted across every session that runs the mod (kept in the mod's store). Spend the mod does not see (claude.ai, other machines) makes it run low, and two sessions writing the store at once can drop one reading; a Cache health bar (the memory index out of 10,000 characters by default, marked Good, Fine or Bad) with a line under it explaining the figures, which the settings can hide | `turn.step`, `session.measure`, `session.compact`, `$.session.usage()`, the transcript |
| **Settings** (the ⚙ at the bottom right of Vitals) | a chip per section: tick it to show or hide that section, drag it to move the section (on mobile, an ↑ moves a section up a place); a checkbox that hides the Cache health bar from the Vitals card; a theme, picked by its checkbox: **Original** (the app's own colours), **Frostwerk** (dark, from Blueprint's Frostwerk brand) or **Reader** (light paper colours, from the Blueprint Reader); and **Cache targets**, a − and + per limit: the memory index's Good and Fine limits and bar width, where the context bar and the plan-limit bars turn orange and red, and the requests-per-turn limit. No limit has an upper end; raising a lower limit carries the one above it along. A button goes back to the defaults. The layout, theme and targets are kept for later sessions | the mod's store |
| **Session totals** | every request in the session, from the main thread and from sub-agents: request count, fresh tokens, cache reads, weighted tokens; a bar per kind of token showing its share of the weighted cost (input green, cache write amber, cache read red, output orange), then, after a thin line, its token count and share of all tokens; cost by who made the request and which model | the transcripts, read again after each turn |
| **Tasks** | one card per task (a task runs from one `mark_task` call to the next): its time, requests, cost, kinds of token, and who spent them | `turn.step` |
| **Recent requests** | the last 15 model requests: time, who, model, input and cache-write tokens, cache reads, output, cost | `turn.step` |
| **Sub-agents** | each sub-agent: running, done or failed; its task; type; model; steps; context size; output; run time; its last tool call | `agent.spawn`, `turn.step`, `tool.call`, `turn.complete` |
| **Permissions** | checks allowed, asked and denied, by kind of tool (file, shell, web, agent, other), a bar of the mix, and the latest 6 checks with secrets masked | `tool.check` |
| **Cache health** (closed at first) | the starting load (the context of the session's first request), requests in the current turn (highlighted past 15 by default), the memory index as a bar out of 10,000 characters (by default Good up to the 4,200 target, Fine up to 5,800, Bad past that; all three set in Settings), cache rebuilds (main-thread requests writing over 50k, each labelled session start, after a summary, idle over 1 hour, or other) and the 10 largest tool results so far. When the memory index is past its target, one line in the Vitals card says so | the transcripts; requests this turn from `turn.step` |
| **Last turn** | how long it took, the cost it added, tool calls, edits, errors, sub-agents started | `turn.start`, `tool.call`, `turn.complete` |
| **Activity** | your prompts (first 70 characters), sub-agents starting and finishing, edits, failed tool calls, denials, compactions | all of the above |

Two buttons copy the task summary and the full request log (up to 5,000 requests) as CSV.

### Cache targets

Each row in Settings → **Cache targets** has a − and a + that move it one step. The three memory rows are counted in characters of the memory index. The four percent rows are for two different bars, the context bar and the plan-limit bars, which measure their own percent of a fixed total. So those percents cannot be worked out from the memory rows.

| Row | Default | Step | What − and + change |
|---|---|---|---|
| Memory index: good to | 4,200 | 200 | the memory index bar is green up to this many characters |
| Memory index: fine to | 5,800 | 200 | orange up to this many; red past it |
| Memory index: bar width | 10,000 | 1,000 | how many characters the full bar stands for. A longer index fills it |
| Context: orange from % | 65 | 5 | the CONTEXT bar turns orange at this share of the context window |
| Context: red from % | 85 | 5 | and red at this share |
| Plan limits: orange from % | 60 | 5 | the 5-hour and 7-day limit bars turn orange at this percent used |
| Plan limits: red from % | 85 | 5 | and red at this percent |
| Requests per turn: limit | 15 | 1 | REQUESTS THIS TURN in Cache health turns red past this many |

No row has an upper end. A row goes down to one step at the least, and never below the row it pairs with: good stays under fine, fine stays at or under the bar width, and orange stays under red. Raising the lower row of a pair carries the upper one up with it, and lowering it again brings the upper one back. A value that differs from its default is shown bold. **↺ Back to the defaults** resets every row.

<p align="center">
  <img src="docs/settings.png" alt="The settings panel: section chips to show, hide and reorder sections, the Cache health bar checkbox, and the theme choice" width="400">
  <img src="docs/recent-requests.png" alt="The Recent requests section and the CSV buttons" width="380">
</p>

It fits the space it has. On a wide pane, each row of figures spreads from edge to edge. On a narrow pane, rows drop their less important columns and the bars get shorter. The terminal draws bars as block characters, and the desktop app draws them as SVG.

## Tasks and `mark_task`

The mod adds a tool, `mark_task`. When Claude calls it with a label (for example "A2 build"), every later request from the main thread and from sub-agents counts toward that task until the next call. The tool returns the totals of the task that just ended. A sub-agent stays with the task it started under. A call to token-use's own `mark_task` starts a task here too, so the two mods stay in step.

A second tool, `context_breakdown`, returns the context window broken down as `/context` shows it: each category, the tokens of each MCP server's tools (loaded and deferred apart), the memory files, agents, skills and slash commands. It is a deferred tool, so it adds only its name to each request until it is used.

## How the numbers are worked out

- **Session cost** is Claude Code's own total, the one `/cost` shows.
- **The cost of a row, task or request** is its tokens priced at list price, then scaled so the rows add up to Claude Code's total. The list prices are only used as ratios between models. Fable is priced like Opus until its price is known.
- **Session totals** come from the transcripts, the main one and each sub-agent's. A response is written there as several lines that repeat its usage, so each response is counted once, by its message id. This also counts requests made before the mod was loaded.
- **Weighted** = input ×1 + cache write ×2 (one-hour cache) or ×1.25 (five-minute cache) + cache read ×0.1 + output ×5. Each response says how many of its writes went to each cache; where a response does not (in the transcript or a `turn.step` record), or claims more one-hour writes than writes, main-thread writes count as one-hour (capped at the writes) and sub-agent writes as five-minute, which is how Claude Code sets them on a subscription. These are the price ratios, so weighted tokens compare cost, not volume. **Fresh** = input + cache write + output: the tokens paid at full price.
- **Active time** is time with a turn running, read from the transcript: from a prompt to the main thread's end of turn. Sub-agents run inside a turn, so they add no time of their own.
- **Time to first token** is timed at the mod's own hook, so it includes the network and anything else that runs before the response's first piece. When thinking isn't streamed, it includes the thinking.

## What is estimated, not measured

- Per-row cost, as above: Claude Code reports one total, not a cost per request.
- Tasks, recent requests and sub-agent cards only count what happened while the mod was loaded. Session totals count the whole session.
- Session totals update after each turn, so during a long turn they trail the live task count.
- A sub-agent's context size is the whole input of its latest request.

## What it can reach

Session Watcher only watches. Every hook passes its event on unchanged: it never denies, rewrites or delays a tool call, a prompt or a sub-agent. If its own bookkeeping fails, the event still passes through.

| It sees or does | Through |
| --- | --- |
| model requests and their token usage | `turn.step` |
| tool calls (name, path or command), whether they failed | `tool.call` |
| permission verdicts | `tool.check` |
| sub-agent starts and finishes | `agent.spawn`, `turn.complete` |
| your prompts' first 70 characters, for the activity log | `turn.start` |
| context, cost and rate limits | `session.measure`, `$.session.usage()` |
| runs `python3 hooks/scan.py`, which reads this session's own transcripts under `~/.claude/projects` | `$.process.run` |
| copies CSV to your clipboard when you press a button | `$.ui.copy` |

What it keeps lives in session state and ends with the session. It makes **no** network requests, writes no files, and calls no model. Paths are shortened and anything that looks like a key or token is masked before it is shown. `claude plugin validate .` lists exactly what it hooks and calls.

## Troubleshooting

- **The pane doesn't open:** check `claude --version` is 2.1.308 or later, then run `/reload-plugins` and `/session-watcher`. Look in the transcript for a dim line starting `session-watcher:`; it names what failed.
- **`/session-watcher` isn't in the `/` menu:** type it in full. Some surfaces list a mod's commands only after it has loaded.
- **Session totals stay at 0 or say "Reading the transcripts…":** check `python3` is installed and on your PATH.

## Files

| File | Holds |
| --- | --- |
| [`hooks/register.tsx`](hooks/register.tsx) | the event hooks and the pane |
| [`hooks/core.ts`](hooks/core.ts) | prices, sums and formatting, as plain functions |
| [`hooks/scan.py`](hooks/scan.py) | reads the session's transcripts for totals and active time |
| [`hooks/pane.test.tsx`](hooks/pane.test.tsx) | 30 tests: the section chips (hide, drag, a saved layout), the Cache health bar setting and the themes (kept, unknown ones dropped, every nested element painted), the limit estimator, drawing, opening and closing sections, folding the Vitals stats row (terminal and desktop), permission tallies, the context limit, cache-write pricing by cache length, the Cache health section and its Vitals line (memory index; requests this turn stay in Cache health), every width from 24 to 120 columns on the terminal and the desktop, and the `context_breakdown` text |
| [`hooks/scan_test.py`](hooks/scan_test.py) | `python3 -I hooks/scan_test.py`: transcript reading — one-hour writes when a response has no split, the cap at the write, empty placeholder lines skipped, two responses in the same millisecond, rebuild labels |
| [`types/index.d.ts`](types/index.d.ts) | the state contract |

## Develop

```sh
claude --plugin-dir .            # load it; edits reload
claude plugin validate .
claude plugin test .
```

## License

[MIT](LICENSE)
