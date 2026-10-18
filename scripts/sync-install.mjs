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
 * Why not ask pnpm: it cannot see a non-manifest change. Copy directly, then say exactly what
 * changed.
 *
 * HARD LINKS. On this deployment some files in the profile copy are not copies at all: they share
 * an inode with the checkout (`nlink = 2`, verified 2026-10-18), so editing the source already
 * edited the "installed" file. Reporting that as `copied` would be a lie — nothing needed copying —
 * so it gets its own status, `linked`, and no write. Measured 2026-10-18: copying a file onto its
 * own hard link left the bytes intact on this machine, but that is a self-copy whose behaviour is
 * not guaranteed elsewhere (`cp a a` refuses), so the safe move is not to attempt it.
 *
 *   node scripts/sync-install.mjs             # copy, report
 *   node scripts/sync-install.mjs --check     # report only; exit 1 when the copy is stale
 *   node scripts/sync-install.mjs --force-copy# break a link and write a real copy
 *   node scripts/sync-install.mjs --link      # create hard links instead of copies
 *
 * Exit: 0 = in sync (or synced), 1 = stale under --check, 2 = no installed copy to write.
 */
import { copyFileSync, existsSync, linkSync, mkdirSync, readFileSync, statSync, unlinkSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'

const HERE = dirname(fileURLToPath(import.meta.url))
const SRC = resolve(HERE, '..')
const PKG = 'dsh-preset-local-delegate'
const FILES = ['package.json', 'cordis.patch.yml', 'local-delegate.mjs', 'local-delegate.selftest.mjs', 'README.md', 'README.en.md', 'engine-profile.json']

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

/** `dev:ino`, or null when the file is absent. Two equal keys mean one file on disk. */
function identity(path) {
  try {
    const st = statSync(path)
    return `${st.dev}:${st.ino}`
  } catch {
    return null
  }
}

const check = process.argv.includes('--check')
const forceCopy = process.argv.includes('--force-copy')
const linkMode = process.argv.includes('--link')
const dst = targetDir()

if (!existsSync(dst)) {
  console.error(`sync-install: no installed copy at ${dst}`)
  console.error('  install the bundle first (plugin_manager install_bundle), then re-run this.')
  process.exit(2)
}

let stale = 0
let linked = 0
for (const f of FILES) {
  const from = join(SRC, f)
  const to = join(dst, f)
  if (!existsSync(from)) continue
  const toExists = existsSync(to)
  const isLinked = toExists && identity(from) !== null && identity(from) === identity(to)

  if (isLinked) {
    linked += 1
    if (!forceCopy) {
      console.log(`  linked  ${f}   (hard link — the source IS the installed copy; nothing to do)`)
      continue
    }
    // Deliberate unlink first: writing through a link would mutate the source too.
    if (!check) {
      unlinkSync(to)
      copyFileSync(from, to)
      console.log(`  copied  ${f}   (link broken on purpose: --force-copy)`)
    }
    continue
  }

  if (same(from, to) && !linkMode) {
    console.log(`  same    ${f}`)
    continue
  }

  stale += 1
  if (check) {
    console.log(`  STALE   ${f}`)
    continue
  }
  mkdirSync(dirname(to), { recursive: true })
  if (linkMode) {
    if (toExists) unlinkSync(to)
    try {
      linkSync(from, to)
      console.log(`  linked  ${f}   (created: --link)`)
    } catch (e) {
      console.log(`  copy    ${f}   (cannot hard-link here: ${e.code || e.message})`)
      copyFileSync(from, to)
    }
  } else {
    copyFileSync(from, to)
    console.log(`  copied  ${f}`)
  }
}

if (check) {
  if (stale) {
    console.error(`\n${stale} file(s) out of date in ${dst} — run: node scripts/sync-install.mjs`)
    process.exit(1)
  }
  console.log(`\n${dst} is up to date${linked ? ` (${linked} hard-linked, so nothing to copy)` : ''}`)
} else {
  console.log(`\n${stale ? `${stale} file(s) synced to` : 'already up to date at'} ${dst}`
    + `${linked ? ` · ${linked} hard-linked` : ''}`)
  if (stale) console.log('restart DSH itself (a new session in the same process keeps the old module instance — measured 2026-10-02).')
  if (linked) console.log('a hard link needs no copy, but the RUNNING process still holds the old module instance: restart it.')
}
