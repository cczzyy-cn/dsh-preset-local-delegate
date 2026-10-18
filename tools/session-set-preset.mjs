#!/usr/bin/env node
// Repoint ONE recorded `agentPreset` in a session header, so a session that records a preset the
// deployment no longer has becomes resolvable again.
//
// Why: a session's header records `agentPreset` at creation, and the workspace client REUSES a blank
// session when you click "new session" (`sessions.create({ workspaceId, sessionId })`). If that blank
// session recorded a preset that was later removed, every new session fails with
// `agent-preset/not-found: Unknown agent preset: <id>` (measured 2026-10-02) -- and deleting the
// preset is otherwise a perfectly legitimate deployment change. The file is a CONCATENATION of zstd
// frames, so this rewrites frame 0 only and leaves every later frame byte-for-byte untouched.
//
// Usage:
//   node tools/session-set-preset.mjs <session.v4.jsonl.zstd> --preset <newId> [--write] [--backup-dir <dir>]
//     without --write it only reports what it would do
//
// Read-only unless --write.
import { copyFileSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib'

const argv = process.argv.slice(2)
const file = argv[0]
const flag = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined }
const newId = flag('--preset')
const backupDir = flag('--backup-dir')
const write = argv.includes('--write')
if (!file || !newId) {
  console.error('usage: node tools/session-set-preset.mjs <session.v4.jsonl.zstd> --preset <newId> [--write] [--backup-dir <dir>]')
  process.exit(2)
}

const MAGIC = [0x28, 0xb5, 0x2f, 0xfd]
const buf = readFileSync(file)
const starts = []
for (let i = 0; i + 3 < buf.length; i += 1) {
  if (buf[i] === MAGIC[0] && buf[i + 1] === MAGIC[1] && buf[i + 2] === MAGIC[2] && buf[i + 3] === MAGIC[3]) starts.push(i)
}
if (starts.length === 0) { console.error(`${file}: no zstd frame found`); process.exit(1) }

const slices = starts.map((s, k) => buf.subarray(s, k + 1 < starts.length ? starts[k + 1] : buf.length))
const parts = slices.map((s) => zstdDecompressSync(s))
const first = parts[0].toString('utf8')
const line = first.split('\n').filter(Boolean)[0]
let header
try { header = JSON.parse(line) } catch { console.error(`${file}: first record is not a session header`); process.exit(1) }
if (header.type !== 'session') { console.error(`${file}: first record type is ${header.type}, not "session"`); process.exit(1) }

const oldId = header.agentPreset
console.log(`${file}`)
console.log(`  frames      : ${starts.length}`)
console.log(`  session     : ${header.id}`)
console.log(`  agentPreset : ${oldId}  ->  ${newId}`)
console.log(`  other frames: ${parts.length - 1} (left byte-for-byte unchanged)`)
if (oldId === newId) { console.log('  nothing to do'); process.exit(0) }
if (!write) { console.log('  dry run: pass --write to apply'); process.exit(0) }

const updated = { ...header, agentPreset: newId }
const newFirst = Buffer.concat([
  zstdCompressSync(Buffer.from(`${JSON.stringify(updated)}\n`, 'utf8')),
  ...slices.slice(1),
])
if (backupDir !== undefined) {
  mkdirSync(backupDir, { recursive: true })
  const target = join(backupDir, `${basename(file)}.bak-before-preset-${String(oldId).replace(/[^\w.-]/g, '_')}`)
  copyFileSync(file, target)
  console.log(`  backup      : ${target}`)
} else {
  const target = `${file}.bak-before-preset-${String(oldId).replace(/[^\w.-]/g, '_')}`
  writeFileSync(target, buf)
  console.log(`  backup      : ${target}`)
}
writeFileSync(file, newFirst)

// Verify by reading the file back the same way every reader does: frame by frame.
const after = readFileSync(file)
const afterStarts = []
for (let i = 0; i + 3 < after.length; i += 1) {
  if (after[i] === MAGIC[0] && after[i + 1] === MAGIC[1] && after[i + 2] === MAGIC[2] && after[i + 3] === MAGIC[3]) afterStarts.push(i)
}
const afterParts = afterStarts.map((s, k) => zstdDecompressSync(after.subarray(s, k + 1 < afterStarts.length ? afterStarts[k + 1] : after.length)))
const afterText = Buffer.concat(afterParts).toString('utf8')
const afterHeader = JSON.parse(afterText.split('\n').filter(Boolean)[0])
const recordsBefore = parts.reduce((n, p) => n + p.toString('utf8').split('\n').filter(Boolean).length, 0)
const recordsAfter = afterText.split('\n').filter(Boolean).length
const tailSame = Buffer.compare(Buffer.concat(parts.slice(1)), Buffer.concat(afterParts.slice(1))) === 0
console.log(`  verified    : agentPreset=${afterHeader.agentPreset}  records ${recordsBefore} -> ${recordsAfter}  tail-identical=${tailSame}`)
if (afterHeader.agentPreset !== newId || recordsBefore !== recordsAfter || !tailSame) {
  console.error('  VERIFY FAILED -- restore the backup above')
  process.exit(1)
}
console.log('  ok')
