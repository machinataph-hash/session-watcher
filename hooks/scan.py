"""Reads one session's transcripts: its active time and its token use.

Token use: every model response in the main transcript and in each sub-agent's
transcript (<session>/subagents/*.jsonl). One response is written as several
lines (one per content block) that repeat its usage, so each response counts
once, by its message id, with the largest figure seen for each field.

Active time: a turn runs from the first message after an end of turn to the
main loop's next end_turn; the time between turns is idle. Sub-agent lines are
left out of it, since they run inside a main turn.

Prints {"ms", "byModel": {model: {"main": usage, "agents": usage}}}.
"""
import glob, json, os, sys
from datetime import datetime

sid = sys.argv[1]
home = os.environ.get('CLAUDE_CONFIG_DIR') or os.path.expanduser('~/.claude')
paths = glob.glob(os.path.join(home, 'projects', '*', sid + '.jsonl'))
if not paths:
    print(json.dumps({'missing': True}))
    sys.exit(0)
main_path = paths[0]
agent_paths = glob.glob(os.path.join(main_path[:-len('.jsonl')], 'subagents', '*.jsonl'))

FIELDS = (('input', 'input_tokens'), ('cacheWrite', 'cache_creation_input_tokens'),
          ('cacheRead', 'cache_read_input_tokens'), ('output', 'output_tokens'))
responses = {}  # message id -> (who, model, {field: max})


def read(path, is_agent, events):
    with open(path, encoding='utf-8', errors='replace') as f:
        for line in f:
            if '"type":"assistant"' not in line and '"type":"user"' not in line:
                continue
            try:
                o = json.loads(line)
            except ValueError:
                continue
            msg = o.get('message') or {}
            if o.get('type') == 'assistant':
                u = msg.get('usage')
                model = msg.get('model') or ''
                if u and model and model != '<synthetic>':
                    key = msg.get('id') or o.get('uuid')
                    who = 'agents' if is_agent or o.get('isSidechain') else 'main'
                    prev = responses.get(key)
                    vals = {f: int(u.get(src) or 0) for f, src in FIELDS}
                    if prev:
                        vals = {f: max(vals[f], prev[2][f]) for f in vals}
                    responses[key] = (who, model, vals)
            if events is None or o.get('isSidechain') or o.get('isMeta'):
                continue
            if o.get('type') not in ('assistant', 'user'):
                continue
            ts = o.get('timestamp')
            if not ts:
                continue
            at = int(datetime.fromisoformat(ts.replace('Z', '+00:00')).timestamp() * 1000)
            end = o['type'] == 'assistant' and msg.get('stop_reason') == 'end_turn'
            c = msg.get('content')
            prompt = o['type'] == 'user' and not o.get('isCompactSummary') and (
                isinstance(c, str) or any(isinstance(b, dict) and b.get('type') == 'text' for b in c or []))
            events.append((at, end, prompt))


events = []
read(main_path, False, events)
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
for who, model, vals in responses.values():
    m = by_model.setdefault(model, {
        'main': {'input': 0, 'cacheWrite': 0, 'cacheRead': 0, 'output': 0, 'calls': 0, 'usd': 0},
        'agents': {'input': 0, 'cacheWrite': 0, 'cacheRead': 0, 'output': 0, 'calls': 0, 'usd': 0},
    })
    row = m[who]
    for f in vals:
        row[f] += vals[f]
    row['calls'] += 1
print(json.dumps({'ms': ms, 'byModel': by_model}))
