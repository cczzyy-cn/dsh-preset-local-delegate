#!/usr/bin/env node
// Dump a DSH session transcript (`session.v4.jsonl.zstd`) to plain JSONL on stdout.
//
// Why a tool: the file is not one zstd stream. It is a CONCATENATION of zstd frames, one per append
// (21 frames in an 11 KB child session, 100+ in a long one), and Node's `zstdDecompressSync` returns
// only the FIRST frame — so the naive read silently prints the session header and nothing else. This
// walks the frame magics, decompresses each frame, and concatenates.
//
// Usage:
//   node tools/session-dump.mjs <session.v4.jsonl.zstd> [out.jsonl]
//   node tools/session-dump.mjs <file> --summary          # event-type counts + assistant texts
//
// Read-only.
import { readFileSync, writeFileSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'

const src = process.argv[2]
const out = process.argv.find((a) => a.endsWith('.jsonl'))
const summary = process.argv.includes('--summary')
if (!src) {
  console.error('usage: node tools/session-dump.mjs <session.v4.jsonl.zstd> [out.jsonl] [--summary]')
  process.exit(2)
}

const buf = readFileSync(src)
const MAGIC = [0x28, 0xb5, 0x2f, 0xfd]
const starts = []
for (let i = 0; i + 3 < buf.length; i++) {
  if (buf[i] === MAGIC[0] && buf[i + 1] === MAGIC[1] && buf[i + 2] === MAGIC[2] && buf[i + 3] === MAGIC[3]) starts.push(i)
}
if (starts.length === 0) {
  console.error(`${src}: no zstd frame found`)
  process.exit(1)
}
const parts = []
let failed = 0
for (let k = 0; k < starts.length; k++) {
  const slice = buf.subarray(starts[k], k + 1 < starts.length ? starts[k + 1] : buf.length)
  try {
    parts.push(zstdDecompressSync(slice))
  } catch (e) {
    failed += 1
    console.error(`frame ${k} @${starts[k]}: ${e.message}`)
  }
}
const text = Buffer.concat(parts).toString('utf8')
if (out) writeFileSync(out, text, 'utf8')
else if (!summary) process.stdout.write(text)

if (summary) {
  const lines = text.split('\n').filter(Boolean)
  console.log(`${src}`)
  console.log(`  frames ${starts.length} (${failed} failed), records ${lines.length}`)
  const types = new Map()
  const steps = []
  for (const line of lines) {
    let r
    try { r = JSON.parse(line) } catch { continue }
    const t = r.type ?? r.kind ?? '(none)'
    const sub = r.event?.type ?? r.event?.kind
    const key = sub ? `${t}/${sub}` : t
    types.set(key, (types.get(key) ?? 0) + 1)
    if (key === 'event/step/end' || key === 'step/end' || key === 'event/turn/end' || key === 'turn/end') {
      steps.push(`${key} ${JSON.stringify(r.event ?? r).slice(0, 200)}`)
    }
  }
  for (const [k, v] of [...types.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${String(v).padStart(5)}  ${k}`)
  for (const s of steps) console.log(`  > ${s}`)
}
