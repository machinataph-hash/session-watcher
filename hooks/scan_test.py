"""Tests for scan.py. Run: python3 -I hooks/scan_test.py"""
import json, os, subprocess, sys, tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
T0 = 1_790_000_000_000


def iso(ms):
    from datetime import datetime, timezone
    return datetime.fromtimestamp(ms / 1000, timezone.utc).strftime('%Y-%m-%dT%H:%M:%S.%f')[:-3] + 'Z'


def resp(mid, at, write=0, read=0, inp=0, one_h=None, side=False):
    u = {'input_tokens': inp, 'cache_creation_input_tokens': write, 'cache_read_input_tokens': read, 'output_tokens': 10}
    if one_h is not None:
        u['cache_creation'] = {'ephemeral_1h_input_tokens': one_h, 'ephemeral_5m_input_tokens': 0}
    return {'type': 'assistant', 'timestamp': iso(at), 'isSidechain': side, 'uuid': mid + str(at),
            'message': {'id': mid, 'model': 'claude-opus-5-5', 'usage': u, 'content': []}}


def run(main, agent=()):
    home = tempfile.mkdtemp()
    d = os.path.join(home, 'projects', 'p')
    os.makedirs(os.path.join(d, 'sid', 'subagents'))
    with open(os.path.join(d, 'sid.jsonl'), 'w') as f:
        f.write('\n'.join(json.dumps(o, separators=(',', ':')) for o in main))
    with open(os.path.join(d, 'sid', 'subagents', 'a.jsonl'), 'w') as f:
        f.write('\n'.join(json.dumps(o, separators=(',', ':')) for o in agent))
    out = subprocess.run([sys.executable, '-I', os.path.join(HERE, 'scan.py'), 'sid'], capture_output=True, text=True,
                         env={**os.environ, 'CLAUDE_CONFIG_DIR': home})
    assert out.returncode == 0, out.stderr
    return json.loads(out.stdout)


def check(name, got, want):
    assert got == want, f'{name}: got {got!r}, want {want!r}'
    print('ok', name)


d = run(
    [
        resp('z', T0 - 1000),                                  # placeholder: no tokens at all
        resp('a', T0, write=60000, inp=5),                     # no split: main thread, so one-hour
        resp('b', T0 + 1000, write=500, read=60000, one_h=900),  # split larger than the write: capped
        resp('c', T0 + 1000, write=10, read=60500),            # same millisecond as b: must not crash
        resp('d', T0 + 62 * 60 * 1000, write=70000, read=1000),  # after an hour idle
    ],
    [resp('e', T0 + 5000, write=4000, side=True)],             # sub-agent, no split: five-minute
)
m = d['byModel']['claude-opus-5-5']
check('starting load skips the empty placeholder', d['cache']['first'], 60005)
check('main write with no split counts as one-hour, split capped at the write',
      m['main']['cacheWrite1h'], 60000 + 500 + 10 + 70000)
check('sub-agent write with no split counts as five-minute', m['agents']['cacheWrite1h'], 0)
check('rebuild labels', [r['why'] for r in d['cache']['rebuilds']], ['start', 'idle'])

# A session whose working directory moved: a transcript in each project folder, the second repeating the first's lines.
home = tempfile.mkdtemp()
for p, lines in (('p1', [resp('a', T0, inp=5)]), ('p2', [resp('a', T0, inp=5), resp('b', T0 + 1000, inp=7)])):
    os.makedirs(os.path.join(home, 'projects', p))
    with open(os.path.join(home, 'projects', p, 'sid.jsonl'), 'w') as f:
        f.write('\n'.join(json.dumps(o, separators=(',', ':')) for o in lines))
out = subprocess.run([sys.executable, '-I', os.path.join(HERE, 'scan.py'), 'sid'], capture_output=True, text=True, env={**os.environ, 'CLAUDE_CONFIG_DIR': home})
check('every project folder is read, each request once', json.loads(out.stdout)['byModel']['claude-opus-5-5']['main']['calls'], 2)
