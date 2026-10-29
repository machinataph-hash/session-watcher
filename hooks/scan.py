"""Reads one session's transcripts: its active time and its token use.

Token use: every model response in the main transcript and in each sub-agent's
transcript (<session>/subagents/*.jsonl). One response is written as several
lines (one per content block) that repeat its usage, so each response counts
once, by its message id, with the largest figure seen for each field.

Active time: a turn runs from the first message after an end of turn to the
main loop's next end_turn; the time between turns is idle. Sub-agent lines are
left out of it, since they run inside a main turn.

Cache health: the first request's context (the starting load); every
main-thread request writing over 50k tokens to the cache (a rebuild), labelled
start, idle (over 60 minutes since the previous response), summary (a summary
came in between) or other; the memory index size; the 10 largest tool results.

Prints {"ms", "byModel": {model: {"main": usage, "agents": usage}}, "cache"}.
"""
import glob, json, os, sys
from datetime import datetime

sid = sys.argv[1]
home = os.environ.get('CLAUDE_CONFIG_DIR') or os.path.expanduser('~/.claude')
paths = glob.glob(os.path.join(home, 'projects', '*', sid + '.jsonl'))
if not paths:
    print(json.dumps({'missing': True}))
    sys.exit(0)
# A session whose working directory moved has a transcript in each project folder it used; every line is read once.
paths.sort(key=os.path.getmtime)
main_path = paths[-1]
agent_paths = [a for p in paths for a in glob.glob(os.path.join(p[:-len('.jsonl')], 'subagents', '*.jsonl'))]
seen_lines = set()

FIELDS = (('input', 'input_tokens'), ('cacheWrite', 'cache_creation_input_tokens'),
          ('cacheRead', 'cache_read_input_tokens'), ('output', 'output_tokens'))
responses = {}  # message id -> (who, model, {field: max}, first timestamp)
summaries = []  # timestamps of summaries in the main transcript
tool_names = {}  # tool_use id -> tool name
results = []  # (chars, tool_use id, timestamp)
REBUILD = 50000
IDLE_MS = 60 * 60 * 1000


def stamp(o):
    ts = o.get('timestamp')
    if not ts:
        return None
    return int(datetime.fromisoformat(ts.replace('Z', '+00:00')).timestamp() * 1000)


def text_len(c):
    if isinstance(c, str):
        return len(c)
    return sum(len(b.get('text') or '') for b in c or [] if isinstance(b, dict))


def read(path, is_agent, events):
    with open(path, encoding='utf-8', errors='replace') as f:
        for line in f:
            if '"type":"assistant"' not in line and '"type":"user"' not in line and 'compact_boundary' not in line:
                continue
            try:
                o = json.loads(line)
            except ValueError:
                continue
            uid = o.get('uuid')
            if uid:
                if uid in seen_lines:
                    continue
                seen_lines.add(uid)
            msg = o.get('message') or {}
            if not is_agent and (o.get('isCompactSummary') or o.get('subtype') == 'compact_boundary'):
                at = stamp(o)
                if at is not None:
                    summaries.append(at)
            c = msg.get('content')
            if o.get('type') == 'assistant':
                for b in c if isinstance(c, list) else []:
                    if isinstance(b, dict) and b.get('type') == 'tool_use' and b.get('id'):
                        tool_names[b['id']] = b.get('name') or '?'
                u = msg.get('usage')
                model = msg.get('model') or ''
                if u and model and model != '<synthetic>':
                    key = msg.get('id') or o.get('uuid')
                    who = 'agents' if is_agent or o.get('isSidechain') else 'main'
                    prev = responses.get(key)
                    vals = {f: int(u.get(src) or 0) for f, src in FIELDS}
                    split = u.get('cache_creation')
                    vals['cacheWrite1h'] = int((split or {}).get('ephemeral_1h_input_tokens') or 0)
                    vals['split'] = 1 if isinstance(split, dict) else 0
                    if prev:
                        vals = {f: max(vals[f], prev[2][f]) for f in vals}
                    responses[key] = (who, model, vals, prev[3] if prev else stamp(o))
            elif o.get('type') == 'user' and isinstance(c, list):
                for b in c:
                    if isinstance(b, dict) and b.get('type') == 'tool_result':
                        results.append((text_len(b.get('content')), b.get('tool_use_id'), stamp(o)))
            if events is None or o.get('isSidechain') or o.get('isMeta'):
                continue
            if o.get('type') not in ('assistant', 'user'):
                continue
            at = stamp(o)
            if at is None:
                continue
            end = o['type'] == 'assistant' and msg.get('stop_reason') == 'end_turn'
            prompt = o['type'] == 'user' and not o.get('isCompactSummary') and (
                isinstance(c, str) or any(isinstance(b, dict) and b.get('type') == 'text' for b in c or []))
            events.append((at, end, prompt))


events = []
for p in paths:
    read(p, False, events)
for p in agent_paths:
    read(p, True, None)

events.sort()
ms, running, prev = 0, False, 0
for at, end, prompt in events:
    if running and not prompt:
        ms += max(0, at - prev)
    running = not end
    prev = at

by_model = {}
for who, model, vals, _ in responses.values():
    # a response without the split: main-thread writes are one-hour, a sub-agent's five-minute;
    # either way never more one-hour writes than writes
    one_h = vals['cacheWrite1h'] if vals.pop('split') else vals['cacheWrite'] if who == 'main' else 0
    vals['cacheWrite1h'] = min(one_h, vals['cacheWrite'])
    m = by_model.setdefault(model, {
        'main': {'input': 0, 'cacheWrite': 0, 'cacheWrite1h': 0, 'cacheRead': 0, 'output': 0, 'calls': 0, 'usd': 0},
        'agents': {'input': 0, 'cacheWrite': 0, 'cacheWrite1h': 0, 'cacheRead': 0, 'output': 0, 'calls': 0, 'usd': 0},
    })
    row = m[who]
    for f in vals:
        row[f] += vals[f]
    row['calls'] += 1
# placeholder lines with no tokens at all are not requests the cache saw
main = sorted(((at, vals) for who, _, vals, at in responses.values()
               if who == 'main' and at is not None and vals['input'] + vals['cacheWrite'] + vals['cacheRead'] > 0),
              key=lambda r: r[0])
summaries.sort()
first = (main[0][1]['input'] + main[0][1]['cacheWrite'] + main[0][1]['cacheRead']) if main else 0
rebuilds, count, written, prev_at, si = [], 0, 0, None, 0
for at, vals in main:
    seen = 0
    while si < len(summaries) and summaries[si] <= at:
        if prev_at is None or summaries[si] > prev_at:
            seen += 1
        si += 1
    if vals['cacheWrite'] > REBUILD:
        why = 'start' if prev_at is None else 'summary' if seen else 'idle' if at - prev_at > IDLE_MS else 'other'
        rebuilds.append({'at': at, 'tokens': vals['cacheWrite'], 'why': why})
        count += 1
        written += vals['cacheWrite']
    prev_at = at

memory = os.path.join(os.path.dirname(main_path), 'memory', 'MEMORY.md')
try:
    with open(memory, encoding='utf-8', errors='replace') as f:
        memory_chars = len(f.read())
except OSError:
    memory_chars = None

top = sorted(results, key=lambda r: -r[0])[:10]
cache = {
    'first': first,
    'rebuilds': rebuilds[-20:],
    'rebuildCount': count,
    'rebuildTokens': written,
    'memoryChars': memory_chars,
    'tools': [{'name': tool_names.get(i, '?'), 'chars': n, 'at': at or 0} for n, i, at in top],
}
print(json.dumps({'ms': ms, 'byModel': by_model, 'cache': cache}))
