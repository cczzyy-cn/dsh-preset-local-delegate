#!/usr/bin/env node
/**
 * doctor.mjs — one read-only command that answers "will delegation work right now?"
 *
 * WHY. Every trap this deployment has actually hit is a *staleness* trap, and each one looks like a
 * different bug:
 *
 *   - the running DSH process loaded its composition at start, so a fixed file changes nothing until
 *     a restart (measured 2026-10-02, 2026-10-13, 2026-10-15 and again 2026-10-18: process started
 *     14:20:16, preset fixed 14:23:14, every new session still failed);
 *   - the profile copy of this bundle is a hard link to the checkout, so "install" is not a moment;
 *   - the engine serves one model id while the profile, the preset and the compaction policy each
 *     hold their own copy of it;
 *   - `<config>.shared-settings.json` can silently add sampling to every delegation.
 *
 * None of those is visible from the file you are editing, and each has produced a wrong conclusion
 * ("the fix did not work", "the model is broken"). This script reads them all at once and prints one
 * table. It changes NOTHING: no writes, no sync, no restart.
 *
 * Usage:
 *   node scripts/doctor.mjs            # human table, exit 1 if any check FAILs
 *   node scripts/doctor.mjs --json     # machine-readable
 *   node scripts/doctor.mjs --deep     # also scan every session for a dead local route (slow)
 *   node scripts/doctor.mjs --no-color # for logs
 *
 * Exit: 0 = every check PASS/WARN/SKIP, 1 = at least one FAIL, 2 = cannot even locate the install.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..')
const HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
const PROFILE = join(HOME, 'profiles', 'desktop')
const INSTALLED = join(PROFILE, 'node_modules', 'dsh-preset-local-delegate')
const ASAR = process.env.DSH_ASAR || join(
  process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'),
  'Programs', 'DeepSeek Harness', 'resources', 'app.asar')

const argv = process.argv.slice(2)
const JSON_OUT = argv.includes('--json')
const DEEP = argv.includes('--deep')
const COLOR = !argv.includes('--no-color') && !JSON_OUT && process.stdout.isTTY !== false
const BASE_URL = flag('--url') || 'http://127.0.0.1:8080'

/** Prompt variables the persona registry resolves. Extended only after checking the build. */
const REGISTERED_PROMPT_VARIABLES = new Set(['provider', 'model'])

const c = (code, s) => (COLOR ? `\u001b[${code}m${s}\u001b[0m` : s)
const dim = (s) => c('2', s)
const red = (s) => c('31', s)
const green = (s) => c('32', s)
const yellow = (s) => c('33', s)
const cyan = (s) => c('36', s)

function flag(name, fallback) {
  const i = argv.indexOf(name)
  return i === -1 ? fallback : argv[i + 1]
}

const results = []
function record(status, name, detail, remedy = '') {
  results.push({ status, name, detail, remedy })
  if (!JSON_OUT) {
    const tag = status === 'PASS' ? green('PASS')
      : status === 'WARN' ? yellow('WARN')
        : status === 'SKIP' ? dim('SKIP')
          : red('FAIL')
    console.log(`  ${tag}  ${name}`)
    if (detail) console.log(`        ${dim(detail)}`)
    if (remedy) console.log(`        ${cyan('→ ' + remedy)}`)
  }
}

const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex')
const same = (a, b) => existsSync(a) && existsSync(b) && sha(a) === sha(b)
const ageOf = (p) => (existsSync(p) ? statSync(p).mtimeMs : null)
const fmtAgo = (ms) => {
  const s = Math.round((Date.now() - ms) / 1000)
  if (s < 90) return `${s}s ago`
  if (s < 5400) return `${Math.round(s / 60)}min ago`
  return `${(s / 3600).toFixed(1)}h ago`
}

// ── 1. what is on disk ───────────────────────────────────────────────────────────────────────────
if (!existsSync(INSTALLED)) {
  console.error(`doctor: no installed copy at ${INSTALLED}`)
  console.error('  install the bundle first (plugin_manager install_bundle), then re-run.')
  process.exit(2)
}

const FILES = ['package.json', 'cordis.patch.yml', 'local-delegate.mjs', 'local-delegate.selftest.mjs', 'README.md', 'README.en.md']
const drifted = FILES.filter((f) => existsSync(join(REPO, f)) && existsSync(join(INSTALLED, f))
  && !same(join(REPO, f), join(INSTALLED, f)))
if (drifted.length) {
  record('FAIL', 'installed copy matches the checkout', `differs in: ${drifted.join(', ')}`,
    'node scripts/sync-install.mjs')
} else {
  record('PASS', 'installed copy matches the checkout', `${FILES.length} files, sha256 identical`)
}

// A hard link means "editing the source edits the installed preset" — worth saying out loud,
// because sync-install can then never report that file stale.
for (const f of ['cordis.patch.yml', 'local-delegate.mjs']) {
  const a = join(REPO, f)
  const b = join(INSTALLED, f)
  if (!existsSync(a) || !existsSync(b)) continue
  const sa = statSync(a)
  const sb = statSync(b)
  if (sa.ino === sb.ino && sa.dev === sb.dev) {
    record('WARN', `${f} is a hard link to the checkout`,
      `nlink=${sa.nlink}, same inode — the source and the "installed" copy are one file`,
      'nothing to do if that is intended; a copyFileSync would silently break the link')
    break
  }
}

// ── 2. is the running process older than the files it should have loaded? ────────────────────────
// This is the trap that costs the most time, and it is invisible in every file: the composition is
// read at process start, so a corrected preset does nothing until DSH restarts.
function processStart() {
  if (process.platform !== 'win32') return null
  try {
    const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      "(Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue | Sort-Object StartTime | " +
      'Select-Object -First 1 -ExpandProperty StartTime).ToUniversalTime().ToString("o")'],
    { encoding: 'utf8', timeout: 15000 }).trim()
    return out ? Date.parse(out) : null
  } catch {
    return null
  }
}

const started = processStart()
// One entry per INODE: the checkout and the "installed" copy share a hard link, so listing both
// would print the same mtime twice and read like two separate problems.
const watched = {}
for (const [name, path] of Object.entries({
  'preset': join(REPO, 'cordis.patch.yml'),
  'module': join(REPO, 'local-delegate.mjs'),
  'preset (installed copy)': join(INSTALLED, 'cordis.patch.yml'),
  'profile patch': join(PROFILE, 'cordis.patch.yml'),
})) {
  try {
    const st = statSync(path)
    const key = `${st.dev}:${st.ino}`
    if (!Object.values(watched).some((w) => w.key === key)) watched[name] = { path, key }
  } catch {
    /* absent is reported by the preset checks below */
  }
}
const watchedPaths = Object.fromEntries(Object.entries(watched).map(([k, v]) => [k, v.path]))
if (started === null) {
  record('SKIP', 'DSH process vs files', 'could not read the process start time on this platform')
} else {
  const newer = Object.entries(watchedPaths).filter(([, p]) => (ageOf(p) ?? 0) > started)
  if (newer.length) {
    const detail = newer.map(([k, p]) => `${k} changed ${fmtAgo(ageOf(p))}`).join(', ')
    record('FAIL', 'the running DSH started after its config was last edited', `process started ${fmtAgo(started)}; ${detail}`,
      'quit and reopen the DSH desktop app — a new session in the same process keeps the old module and config')
  } else {
    record('PASS', 'the running DSH started after its config was last edited', `process started ${fmtAgo(started)}`)
  }
}

// ── 3. preset composition ───────────────────────────────────────────────────────────────────────
let patchText = ''
try {
  patchText = readFileSync(join(INSTALLED, 'cordis.patch.yml'), 'utf8')
} catch (e) {
  record('FAIL', 'installed preset is readable', String(e))
}
if (patchText) {
  const rows = (patchText.match(/^\s+- id: /gm) || []).length
  const hasLocalRow = /- id: local-delegate\b/.test(patchText) || /name: dsh-preset-local-delegate\/local-delegate\.mjs/.test(patchText)
  if (hasLocalRow) record('PASS', 'the preset adds its own row', `${rows} "- id:" rows, local-delegate.mjs referenced`)
  else record('FAIL', 'the preset adds its own row', 'no local-delegate row found', 'python tools/build-local-delegate-preset.py')

  // A persona prefix/suffix is a template; an unregistered {{var}} fails prompt ASSEMBLY, so every
  // session on the preset dies with no transcript. Measured 2026-10-18: {{cwd}}.
  const dead = []
  for (const m of patchText.matchAll(/\{\{\s*([A-Za-z0-9_.:-]+)\s*\}\}/g)) {
    if (!REGISTERED_PROMPT_VARIABLES.has(m[1])) dead.push(m[1])
  }
  if (dead.length) {
    record('FAIL', 'no dead prompt variable in the preset', `unregistered: ${[...new Set(dead)].join(', ')}`,
      'remove the clause (the working directory arrives as literal user context) and regenerate')
  } else {
    record('PASS', 'no dead prompt variable in the preset', `only ${[...REGISTERED_PROMPT_VARIABLES].join(', ')}`)
  }

  // The compaction policy is the one row this deployment configures by hand; a model id left over
  // from the previous engine is invisible until a session hits the trigger.
  const compactionModel = /modelPolicies:[\s\S]{0,200}?model:\s*(\S+)/.exec(patchText)?.[1]
  const localModel = /DSH_LOCAL_MODEL \|\| '([^']+)'/.exec(readFileSync(join(INSTALLED, 'local-delegate.mjs'), 'utf8'))?.[1]
  const profileText = existsSync(join(PROFILE, 'cordis.patch.yml')) ? readFileSync(join(PROFILE, 'cordis.patch.yml'), 'utf8') : ''
  const profileModel = /providers:[\s\S]*?strata:[\s\S]*?models:[\s\S]*?- id:\s*(\S+)/.exec(profileText)?.[1]
  const models = { 'module default': localModel, 'profile route': profileModel, 'compaction policy': compactionModel }
  const ids = [...new Set(Object.values(models).filter(Boolean))]
  if (ids.length > 1) {
    record('FAIL', 'model id is the same everywhere', Object.entries(models).map(([k, v]) => `${k}=${v}`).join(', '),
      'one swap must touch all of them (engine profile, DSH profile patch, compacted modelPolicies, module default)')
  } else if (ids.length === 1) {
    record('PASS', 'model id is the same everywhere', `all point at ${ids[0]}`)
  }

  // allowedModels is what a session's durable route policy is built from: a stale list refuses
  // `subagent(provider: strata, ...)` before any request while `delegate_batch` still works.
  if (localModel && !profileText.includes(`model: ${localModel}`)) {
    record('WARN', 'allowedModels mentions the current model', 'the profile patch does not list it',
      'add it to subagent-model-selection-settings.allowedModels')
  } else if (localModel) {
    record('PASS', 'allowedModels mentions the current model', localModel)
  }
}

// ── 4. the engine ──────────────────────────────────────────────────────────────────────────────
async function getJson(path, ms = 2000) {
  const res = await fetch(`${BASE_URL}${path}`, { signal: AbortSignal.timeout(ms) })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json()
}

let health = null
try {
  health = await getJson('/health', 1500)
  const bits = [`model=${health.model}`, `max_context=${health.max_context}`]
  if (health.images !== undefined) bits.push(`images=${health.images}`)
  if (health.loaded !== undefined) bits.push(`loaded=${health.loaded}`)
  record(health.loaded === false ? 'WARN' : 'PASS', 'engine is up', bits.join(', '))
} catch (e) {
  record('FAIL', 'engine is up', `${BASE_URL} — ${e.message}`,
    'start Strata first; without it every delegation fails with a misleading `invalid JSON`')
}

if (health) {
  const installedModel = /DSH_LOCAL_MODEL \|\| '([^']+)'/.exec(readFileSync(join(INSTALLED, 'local-delegate.mjs'), 'utf8'))?.[1]
  if (installedModel && health.model && installedModel !== health.model) {
    record('FAIL', 'engine serves the model the preset asks for', `engine=${health.model}, preset=${installedModel}`,
      'swap one of them, sync-install, and restart DSH')
  } else if (installedModel) {
    record('PASS', 'engine serves the model the preset asks for', installedModel)
  }
  if (health.images === false) {
    record('WARN', 'engine advertises image input', 'images=false — `images:` tasks will fail',
      'restart the engine with --vision')
  }

  // The shared-settings trap: this file is merged into every request that carries no sampling of its
  // own, and a delegation is exactly that. A temperature saved from the web Chat page therefore
  // samples every delegation while the engine config still looks greedy.
  try {
    const settings = await getJson('/settings', 1500)
    const defaults = (settings && settings.defaults) || {}
    const keys = Object.keys(defaults)
    if (keys.some((k) => /temperature|top_p|min_p|top_k/.test(k))) {
      record('FAIL', 'shared settings add no sampling', `shared defaults carry ${keys.join(', ')}`,
        'keep that file to reasoning_effort only — it overrides greedy for every delegation')
    } else {
      const effort = defaults.reasoning_effort
      if (effort === 'none') {
        record('WARN', 'shared settings: reasoning effort', `${effort} (measured: multi-step arithmetic goes wrong silently)`,
          'set {"defaults":{"reasoning_effort":"low"}}')
      } else {
        record('PASS', 'shared settings add no sampling',
          keys.length ? `defaults=${JSON.stringify(defaults)}` : 'empty')
      }
    }
  } catch {
    record('SKIP', 'shared settings', '/settings did not answer')
  }
}

// ── 5. optional: sessions pinned to a model that no longer exists ───────────────────────────────
if (DEEP && health && health.model) {
  const r = spawnSync(process.execPath, [join(REPO, 'tools', 'session-route-policy.mjs'), '--model', health.model],
    { encoding: 'utf8', timeout: 120000 })
  const dead = ((r.stdout || '').match(/dead-route/g) || []).length
  if (dead) {
    record('WARN', 'no session is pinned to a dead local route', `${dead} session(s) report dead-route`,
      'tools/session-route-policy.mjs lists them; a subagent from those sessions is refused')
  } else {
    record('PASS', 'no session is pinned to a dead local route', 'route policy scan clean')
  }
}

// ── verdict ────────────────────────────────────────────────────────────────────────────────────
const failed = results.filter((r) => r.status === 'FAIL')
const warned = results.filter((r) => r.status === 'WARN')

if (JSON_OUT) {
  console.log(JSON.stringify({ baseUrl: BASE_URL, profile: PROFILE, results, failures: failed.length, warnings: warned.length }, null, 2))
} else {
  console.log('')
  if (failed.length) {
    console.log(`${red('NOT READY')} — ${failed.length} failure(s), ${warned.length} warning(s)`)
    console.log(dim('  fix the failures above, then re-run; the arrow on each one is the next action'))
  } else {
    console.log(`${green('READY')} — ${results.length} checks, ${warned.length} warning(s)`)
    if (warned.length) console.log(dim('  warnings do not block delegation'))
  }
}
process.exit(failed.length ? 1 : 0)
