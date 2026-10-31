// Builds report/page.html: page.src.html with hooks/core.ts bundled in. The mod fills __STATE__ when it publishes.
// Run after changing page.src.html or core.ts: node report/build.mjs
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
const d = import.meta.dirname
const core = execFileSync('npx', ['-y', 'esbuild@0.24.0', '--bundle', '--format=iife', '--global-name=SW', '--minify', '--target=es2020', '--log-level=warning', '--tsconfig-raw={}'], {
  input: "export { k, usd, clock, dur, hhmm, when, untilReset, modelName, familyOf, weighted, writeCost, fresh, sum, empty, taskTotal, scanTotal, newTask, EXTRAS, SECTIONS, TARGETS, THEMES, BUCKETS, targetsOf, canStep, applyLayoutMessage } from './hooks/core.ts'",
  cwd: `${d}/..`,
}).toString()
writeFileSync(`${d}/page.html`, readFileSync(`${d}/page.src.html`, 'utf8').replace('__CORE__', () => core.replace(/<\/script/gi, '<\\/script')))
// A page with no state yet: --preview <state.json> writes report/preview.html for a look.
const i = process.argv.indexOf('--preview')
if (i > 0) writeFileSync(`${d}/preview.html`, readFileSync(`${d}/page.html`, 'utf8').replace('__STATE__', () => readFileSync(process.argv[i + 1], 'utf8').replace(/</g, '\\u003c')))
