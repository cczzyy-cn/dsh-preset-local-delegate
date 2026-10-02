/**
 * Sync this bundle's files into the profile's pnpm copy.
 *
 * WHY THIS EXISTS. The bundle is installed as a `file:` directory dependency, and pnpm keys such
 * a dependency by its MANIFEST, not by its contents. Measured on this deployment (2026-10-01):
 * after `README.md` was added, a re-install printed "Already up to date" and the profile copy
 * still lacked the file. So editing `local-delegate.mjs` — a non-manifest file — and re-running
 * the install leaves the harness running the OLD module while the source tree shows the new one.
 * That is the worst kind of drift: the obvious signal ("I reinstalled it") actively lies.
 *
 * The fix is to stop asking pnpm and copy the files directly, then say exactly what changed.
 *
 *   node scripts/sync-install.mjs            # copy, report
 *   node scripts/sync-install.mjs --check    # report only; exit 1 when the copy is stale
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'

const HERE = dirname(fileURLToPath(import.meta.url))
const SRC = resolve(HERE, '..')
const PKG = 'dsh-preset-local-delegate'
const FILES = ['package.json', 'cordis.patch.yml', 'local-delegate.mjs', 'local-delegate.selftest.mjs', 'README.md']

/** The pnpm copy to write. `DSH_PROFILE_DIR` is set for an agent's shell by the harness. */
function targetDir() {
  const explicit = process.env.DSH_LOCAL_DELEGATE_INSTALL
  if (explicit) return resolve(explicit)
  const profileDir = process.env.DSH_PROFILE_DIR
  if (profileDir) return join(profileDir, 'node_modules', PKG)
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  const profile = process.env.DSH_PROFILE || 'desktop'
  return join(home, 'profiles', profile, 'node_modules', PKG)
}

function same(a, b) {
  try {
    return readFileSync(a, 'utf8').replace(/\r\n/g, '\n') === readFileSync(b, 'utf8').replace(/\r\n/g, '\n')
  } catch {
    return false
  }
}

const check = process.argv.includes('--check')
const dst = targetDir()

if (!existsSync(dst)) {
  console.error(`sync-install: no installed copy at ${dst}`)
  console.error('  install the bundle first (plugin_manager install_bundle), then re-run this.')
  process.exit(2)
}

let stale = 0
for (const f of FILES) {
  const from = join(SRC, f)
  const to = join(dst, f)
  if (!existsSync(from)) continue
  if (same(from, to)) {
    console.log(`  same    ${f}`)
    continue
  }
  stale += 1
  if (check) {
    console.log(`  STALE   ${f}`)
  } else {
    mkdirSync(dirname(to), { recursive: true })
    copyFileSync(from, to)
    console.log(`  copied  ${f}`)
  }
}

if (check) {
  if (stale) {
    console.error(`\n${stale} file(s) out of date in ${dst} — run: node scripts/sync-install.mjs`)
    process.exit(1)
  }
  console.log(`\n${dst} is up to date`)
} else {
  console.log(`\n${stale ? `${stale} file(s) synced to` : 'already up to date at'} ${dst}`)
  if (stale) console.log('restart DSH itself (a new session in the same process keeps the old module instance — measured 2026-10-02).')
}
