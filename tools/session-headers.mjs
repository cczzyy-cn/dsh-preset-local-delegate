#!/usr/bin/env node
// List DSH sessions with their header facts, so a preset that no longer exists can be found.
//
// Why: a session records `agentPreset` in its header at creation. Removing a preset from the
// deployment therefore leaves sessions whose recorded identity cannot be resolved any more --
// including BLANK sessions, which the workspace client reuses when you click "new session": the
// server then fails with `agent-preset/not-found: Unknown agent preset: <id>` and no new session
// can be created. That failure is invisible from the files that declare the roster.
//
// Decoding only the FIRST zstd frame is enough for the header and is ~100x cheaper than the whole
// transcript, so this walks every session instead of a sample.
//
// Usage:
//   node tools/session-headers.mjs [--home <dshHome>] [--preset <id>] [--blank]
//     --preset <id>  only sessions whose header names this preset (exit 1 if any)
//     --blank        only sessions with no conversation (header + policy records only)
//
// Read-only.
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

const argv = process.argv.slice(2)
const flag = (name, fallback) => {
  const i = argv.indexOf(name)
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback
}
const HOME = flag('--home', join(process.env.USERPROFILE ?? process.env.HOME ?? '.', '.dsh'))
const WANT_PRESET = flag('--preset', undefined)
const BLANK_ONLY = argv.includes('--blank')
const MAGIC = [0x28, 0xb5, 0x2f, 0xfd]

function frames(buf) {
  const starts = []
  for (let i = 0; i + 3 < buf.length; i += 1) {
    if (buf[i] === MAGIC[0] && buf[i + 1] === MAGIC[1] && buf[i + 2] === MAGIC[2] && buf[i + 3] === MAGIC[3]) starts.push(i)
  }
  return starts
}

function decodeFirst(buf) {
  const starts = frames(buf)
  if (starts.length === 0) return undefined
  const end = starts.length > 1 ? starts[1] : buf.length
  try { return zstdDecompressSync(buf.subarray(starts[0], end)).toString('utf8') } catch { return undefined }
}

function recordCount(buf) {
  const starts = frames(buf)
  let text = ''
  for (let k = 0; k < starts.length; k += 1) {
    const end = k + 1 < starts.length ? starts[k + 1] : buf.length
    try { text += zstdDecompressSync(buf.subarray(starts[k], end)).toString('utf8') } catch { /* partial frame */ }
  }
  return text.split('\n').filter(Boolean).length
}

const sessionsDir = join(HOME, 'sessions')
const rows = []
for (const slug of readdirSync(sessionsDir, { withFileTypes: true })) {
  if (!slug.isDirectory()) continue
  for (const entry of readdirSync(join(sessionsDir, slug.name), { withFileTypes: true })) {
    const file = join(sessionsDir, slug.name, entry.name, 'session.v4.jsonl.zstd')
    let buf
    try { buf = readFileSync(file) } catch { continue }
    const head = decodeFirst(buf)
    if (head === undefined) continue
    let header
    try { header = JSON.parse(head.split('\n').filter(Boolean)[0]) } catch { continue }
    const records = buf.length < 262144 ? recordCount(buf) : undefined
    rows.push({
      slug: slug.name,
      id: header.id ?? entry.name,
      preset: header.agentPreset,
      origin: header.origin,
      depth: header.delegationDepth,
      records,
      blank: records !== undefined && records <= 4,
      bytes: statSync(file).size,
      dir: join(sessionsDir, slug.name, entry.name),
    })
  }
}

const wanted = rows
  .filter((r) => (WANT_PRESET === undefined || r.preset === WANT_PRESET) && (!BLANK_ONLY || r.blank === true))
  .sort((a, b) => (a.preset ?? '').localeCompare(b.preset ?? '') || a.id.localeCompare(b.id))

console.log(`home: ${HOME}`)
console.log(`${wanted.length} session(s)${WANT_PRESET ? ` with agentPreset=${WANT_PRESET}` : ''}${BLANK_ONLY ? ' (blank only)' : ''}`)
const byPreset = new Map()
for (const r of rows) byPreset.set(r.preset ?? '(none)', (byPreset.get(r.preset ?? '(none)') ?? 0) + 1)
console.log(`all sessions by preset: ${[...byPreset.entries()].map(([k, v]) => `${k}=${v}`).join('  ')}`)
for (const r of wanted) {
  console.log(
    `  ${r.blank ? 'BLANK ' : '      '}${String(r.preset).padEnd(16)} ${r.id}  bytes=${r.bytes}` +
    `${r.records === undefined ? '' : ` records=${r.records}`}` +
    `${r.origin === undefined ? '' : ` origin=${r.origin}`}`
  )
}
process.exit(WANT_PRESET !== undefined && wanted.length > 0 ? 1 : 0)
