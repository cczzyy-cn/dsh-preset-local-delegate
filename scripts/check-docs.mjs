#!/usr/bin/env node
/**
 * check-docs.mjs — assert that the numbers the documentation states are the numbers that are true.
 *
 * WHY. The documentation IS the product here: the preset's whole claim is "here is what was
 * measured". But every fact in it is hand-maintained, and drift is silent — a stale README still
 * reads like a careful README. Measured 2026-10-18, while doing something else entirely:
 *
 *   - README.md said the profile cap is `maxTokens 65536` in one table and `131072` in another,
 *     while the live profile said 32768;
 *   - README.en.md still named `qwen3.8-flash-next-iq3_s` as the live route, two model swaps late
 *     (0 mentions of the model that was actually serving);
 *   - both READMEs and NEXT-SESSION.md still advertised the old self-test count.
 *
 * This script only ASSERTS; it never rewrites prose. Generated documentation would lose the sources
 * and the narrative, which are the two things worth keeping, so the numbers are checked and the
 * words stay the author's.
 *
 * Usage:
 *   node scripts/check-docs.mjs            # table; exit 1 on any FAIL
 *   node scripts/check-docs.mjs --no-selftest  # skip running the suite (fast, for pre-commit)
 *   node scripts/check-docs.mjs --json
 */
import { readFileSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..')
const argv = process.argv.slice(2)
const RUN_SELFTEST = !argv.includes('--no-selftest')
const JSON_OUT = argv.includes('--json')

const COLOR = !argv.includes('--no-color') && !JSON_OUT
const c = (code, s) => (COLOR ? `\u001b[${code}m${s}\u001b[0m` : s)
const dim = (s) => c('2', s)
const red = (s) => c('31', s)
const green = (s) => c('32', s)
const yellow = (s) => c('33', s)
const cyan = (s) => c('36', s)

const results = []
function record(status, name, detail = '', remedy = '') {
  results.push({ status, name, detail, remedy })
  if (!JSON_OUT) {
    const tag = status === 'PASS' ? green('PASS')
      : status === 'WARN' ? yellow('WARN')
        : status === 'SKIP' ? dim('SKIP') : red('FAIL')
    console.log(`  ${tag}  ${name}`)
    if (detail) console.log(`        ${dim(detail)}`)
    if (remedy) console.log(`        ${cyan('→ ' + remedy)}`)
  }
}

const read = (f) => readFileSync(join(REPO, f), 'utf8')
const lines = (f) => read(f).split(/\r?\n/)

/** The deployment's declared engine facts. */
const ENGINE = JSON.parse(read('engine-profile.json'))
/** Facts the docs state that can be derived from the tree. */
const MODULE = 'local-delegate.mjs'
const moduleBytes = statSync(join(REPO, MODULE)).size
const moduleHash = createHash('sha256').update(readFileSync(join(REPO, MODULE))).digest('hex').toUpperCase()
const moduleHash16 = moduleHash.slice(0, 16)
const perCallMaxTokens = 4096

// ── 1. every stated self-test count is the real one ─────────────────────────────────────────────
let actualPassed = null
if (RUN_SELFTEST) {
  const r = spawnSync(process.execPath, [join(REPO, 'local-delegate.selftest.mjs')], {
    cwd: REPO,
    encoding: 'utf8',
    timeout: 300000,
    env: { ...process.env, DSH_SKIP_ENGINE_PROBE: '1' },
  })
  const m = /(\d+) passed, (\d+) failed/.exec(`${r.stdout || ''}\n${r.stderr || ''}`)
  if (!m) {
    record('FAIL', 'the self-test runs', (r.stderr || '').trim().split('\n').slice(-3).join(' | '),
      'node local-delegate.selftest.mjs')
  } else if (Number(m[2]) !== 0) {
    record('FAIL', 'the self-test suite passes', `${m[1]} passed, ${m[2]} failed`, 'fix the failing case first')
  } else {
    actualPassed = Number(m[1])
    record('PASS', 'the self-test suite passes', `${actualPassed} passed, 0 failed`)
  }
} else {
  record('SKIP', 'the self-test suite passes', '--no-selftest')
}

if (actualPassed !== null) {
  const claims = []
  for (const f of ['README.md', 'README.en.md', 'NEXT-SESSION.md']) {
    for (const [i, line] of lines(f).entries()) {
      for (const m of line.matchAll(/(\d{2,4})\s*(?:passed|deterministic cases|个确定性用例)/g)) {
        claims.push({ f, line: i + 1, stated: Number(m[1]), text: line.trim().slice(0, 110) })
      }
    }
  }
  const wrong = claims.filter((x) => x.stated !== actualPassed)
  if (wrong.length) {
    record('FAIL', `every stated self-test count is ${actualPassed}`, wrong.map((w) => `${w.f}:${w.line} says ${w.stated}`).join(', '),
      'update the count, or the number is describing a different thing — say which')
  } else {
    record('PASS', `every stated self-test count is ${actualPassed}`, `${claims.length} claim(s) across 3 files`)
  }
}

// ── 2. the module fingerprint is the module ─────────────────────────────────────────────────────
{
  const want = [`${moduleHash16}`, moduleBytes.toLocaleString('en-US')]
  const wrong = []
  for (const f of ['README.md', 'README.en.md']) {
    const text = read(f)
    if (!text.includes(moduleHash16)) wrong.push(`${f}: no fingerprint ${moduleHash16}`)
    // 123,872 and 123872 are both acceptable spellings of the same byte count.
    if (!new RegExp(`${moduleBytes.toLocaleString('en-US')}|${moduleBytes}\\b`).test(text)) {
      wrong.push(`${f}: no byte count ${moduleBytes}`)
    }
  }
  if (wrong.length) record('FAIL', 'the module fingerprint matches the file', wrong.join('; '), `sha256 ${moduleHash16}, ${moduleBytes} B`)
  else record('PASS', 'the module fingerprint matches the file', `${moduleHash16}, ${want[1]} B`)
}

// ── 3. the live model id is the one the profile declares ────────────────────────────────────────
// A historical mention is legitimate - both READMEs keep the measurements that retired older
// engines - so the rule is: any OTHER id must sit on a line that says so.
const HISTORICAL = /(此前|之前|当时|曾经|曾用|历史|旧的|换成|换到|替换|已换|已删除|旧|then|used to|\bwas\b|\bwere\b|earlier|previously|replaced|replaces|history|deleted|swap|2026-0[0-9]|2026-1[0-9])/i
{
  const wrong = []
  for (const f of ['README.md', 'README.en.md']) {
    for (const [i, line] of lines(f).entries()) {
      for (const m of line.matchAll(/(?:strata\/)?(qwen3\.8-flash-next-[a-z0-9_]+)/g)) {
        const id = m[1]
        if (id === ENGINE.model) continue
        if (HISTORICAL.test(line)) continue
        wrong.push(`${f}:${i + 1} names ${id} as if current`)
      }
    }
  }
  if (wrong.length) {
    record('FAIL', `no stale model id outside history (current: ${ENGINE.model})`, wrong.slice(0, 6).join('; ')
      + (wrong.length > 6 ? ` (+${wrong.length - 6} more)` : ''),
    'either fix the claim, or mark the line as history (此前/当时/was/used to) so the next reader can tell')
  } else {
    record('PASS', `no stale model id outside history (current: ${ENGINE.model})`, 'every other id is marked historical')
  }
}

// ── 4. the numbers the profile row states ──────────────────────────────────────────────────────
// Line-scoped on purpose: `maxTokens` legitimately appears as the PER-CALL cap (4096) right next to
// the profile cap, and a global "any maxTokens must equal X" rule would be wrong by design.
{
  const wrong = []
  const md = lines('README.md')
  const routeRow = md.find((l) => /DSH 路由/.test(l))
  if (!routeRow) wrong.push('README.md: no "DSH 路由" row')
  else {
    const id = /strata\/[a-z0-9._-]+/.exec(routeRow)?.[0]
    if (id !== `strata/${ENGINE.model}`) wrong.push(`route row says ${id}, engine-profile says strata/${ENGINE.model}`)
    const cw = Number(/contextWindow\s*(\d+)/.exec(routeRow)?.[1])
    if (cw !== ENGINE.maxContext) wrong.push(`contextWindow ${cw} != ${ENGINE.maxContext}`)
    const mt = Number(/maxTokens\s*(\d+)/.exec(routeRow)?.[1])
    if (mt !== ENGINE.maxTokens) wrong.push(`maxTokens ${mt} != ${ENGINE.maxTokens}`)
  }
  const capRow = md.find((l) => /输出上限/.test(l))
  if (capRow) {
    const n = Number(/maxTokens\s*(\d+)/.exec(capRow)?.[1])
    if (n !== ENGINE.maxTokens && n !== perCallMaxTokens) {
      wrong.push(`"输出上限" row says maxTokens ${n}; the profile cap is ${ENGINE.maxTokens}, the per-call cap is ${perCallMaxTokens}`)
    }
  }
  if (wrong.length) record('FAIL', 'the profile route numbers are the profile’s', wrong.join('; '),
    'one source: engine-profile.json')
  else record('PASS', 'the profile route numbers are the profile’s', `context=${ENGINE.maxContext}, maxTokens=${ENGINE.maxTokens}`)
}

// ── 5. the engine version the state table claims ───────────────────────────────────────────────
{
  const row = lines('README.md').find((l) => /^\|\s*引擎\s*\|/.test(l))
  if (!row) record('WARN', 'the state table names the engine version', 'no "引擎" row found')
  else if (!row.includes(ENGINE.engineVersion)) {
    record('FAIL', 'the state table names the engine version', `row does not contain ${ENGINE.engineVersion}`,
      'update the row, or bump engine-profile.json if the engine really changed')
  } else {
    record('PASS', 'the state table names the engine version', ENGINE.engineVersion)
  }
}

// ── 6. the two documents agree on which one is primary ────────────────────────────────────────
// README.md is the main document (Chinese); README.en.md is the full English version. Both exist,
// and a reader who opens one must not find a different deployment described there.
{
  const zh = read('README.md')
  const en = read('README.en.md')
  const problems = []
  if (!zh.includes(ENGINE.model)) problems.push('README.md never names the current model')
  if (!en.includes(ENGINE.model)) problems.push('README.en.md never names the current model')
  const zhSize = zh.length
  const enSize = en.length
  if (enSize < zhSize * 0.5) problems.push(`README.en.md is ${Math.round(enSize / zhSize * 100)}% of README.md — it has fallen behind`)
  if (problems.length) record('FAIL', 'both READMEs describe the same deployment', problems.join('; '),
    'the English README is a full version, not an archive: regenerate its facts from engine-profile.json')
  else record('PASS', 'both READMEs describe the same deployment', `${zhSize} / ${enSize} chars`)
}

// ── verdict ────────────────────────────────────────────────────────────────────────────────────
const failed = results.filter((r) => r.status === 'FAIL')
const skipped = results.filter((r) => r.status === 'SKIP')
if (JSON_OUT) {
  console.log(JSON.stringify({ engine: ENGINE.model, results, failures: failed.length }, null, 2))
} else {
  console.log('')
  if (failed.length) {
    console.log(`${red('DOCS OUT OF SYNC')} — ${failed.length} failure(s)`)
  } else {
    console.log(`${green('DOCS MATCH THE TREE')} — ${results.length - skipped.length} checks`)
  }
}
process.exit(failed.length ? 1 : 0)
