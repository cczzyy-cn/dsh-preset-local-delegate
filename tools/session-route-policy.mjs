#!/usr/bin/env node
// Which route is each session's durable `subagentModelSelectionPolicy` pinned to?
//
// Why: the route policy is a durable projection that is recorded ONCE per session
// (`init: () => null`, and `recordSubagentModelSelection` returns early when a value already exists --
// see @deepseek-ai/dsh-tool-subagent/lib/index.js in the running app.asar). So a deployment that
// changes the models on offer leaves EVERY older session pinned to the route list it captured at
// creation. `subagent` is then refused for that session in ~23 ms:
//
//   child LLM route "strata/<the model this deployment no longer offers>" is not allowed for this Session
//
// `delegate_batch` is NOT affected: it uses this preset's own route (LOCAL_PROVIDER/LOCAL_MODEL), not
// the session's model-selection policy. That asymmetry was measured 2026-10-13 (subagent refused,
// delegate_batch fine, same session), and this scan is how the residue is counted after a model swap.
//
// A session with no policy record is NOT restricted (an undefined policy means the fixed-route
// definition), so `unknown` is reported separately rather than lumped in with `STALE`.
//
// Decoding stops at the frame that carries the policy record, so this stays cheap on big transcripts.
//
// Usage:
//   node tools/session-route-policy.mjs [--home <dshHome>] [--frames 40] [--out <file.json>]
//     --frames <n>  how many frames to decode before giving up on finding a policy record
//     --out <file>  also write every row as JSON
//
// Exit code is 0; this is a report, not a gate. Read-only.
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

const argv = process.argv.slice(2)
const flag = (name, fallback) => {
  const i = argv.indexOf(name)
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback
}
const HOME = flag('--home', join(process.env.USERPROFILE ?? process.env.HOME ?? '.', '.dsh'))
const CAP = Number(flag('--frames', '40'))
const OUT = flag('--out', undefined)
const CURRENT = flag('--model', 'qwen3.8-flash-next-iq3_s')
// The marker of the model this deployment replaced (2026-10-14: IQ3_S replaced IQ2_XS; before that,
// the Coder IQ1_M). Sessions pinned to it are the residue a swap leaves behind.
const DEAD = flag('--dead', 'iq2_xs')
const MAGIC = [0x28, 0xb5, 0x2f, 0xfd]

// This file is a CONCATENATION of zstd frames (one appended per write), not a single stream:
// `zstdDecompressSync` on the whole buffer silently yields only the first frame.
function frames(buf) {
  const starts = []
  for (let i = 0; i + 3 < buf.length; i += 1) {
    if (buf[i] === MAGIC[0] && buf[i + 1] === MAGIC[1] && buf[i + 2] === MAGIC[2] && buf[i + 3] === MAGIC[3]) starts.push(i)
  }
  return starts
}

/** Every {provider, model} pair anywhere inside a decoded record. */
function routesIn(value, out = []) {
  if (Array.isArray(value)) { for (const v of value) routesIn(v, out); return out }
  if (value !== null && typeof value === 'object') {
    if (typeof value.provider === 'string' && typeof value.model === 'string') out.push(`${value.provider}/${value.model}`)
    for (const v of Object.values(value)) routesIn(v, out)
  }
  return out
}

const rows = []
for (const slug of readdirSync(join(HOME, 'sessions'), { withFileTypes: true })) {
  if (!slug.isDirectory()) continue
  for (const entry of readdirSync(join(HOME, 'sessions', slug.name), { withFileTypes: true })) {
    const file = join(HOME, 'sessions', slug.name, entry.name, 'session.v4.jsonl.zstd')
    let buf
    try { buf = readFileSync(file) } catch { continue }
    const starts = frames(buf)
    let header = {}
    let policy
    let truncated = true
    for (let k = 0; k < Math.min(starts.length, CAP); k += 1) {
      const end = k + 1 < starts.length ? starts[k + 1] : buf.length
      let text
      try { text = zstdDecompressSync(buf.subarray(starts[k], end)).toString('utf8') } catch { continue }
      for (const line of text.split('\n')) {
        if (line === '') continue
        let rec
        try { rec = JSON.parse(line) } catch { continue }
        if (k === 0 && header.id === undefined && rec.id !== undefined) header = rec
        if (policy === undefined && JSON.stringify(rec).includes('model-selection-policy')) {
          const routes = routesIn(rec)
          if (routes.length > 0) policy = routes
        }
      }
      if (policy !== undefined) break
    }
    // Four distinct states, and collapsing them would hide the only one that means "this route is
    // gone": a policy that lists a model the deployment no longer has, versus one that predates the
    // local engine entirely, versus no policy at all (which restricts nothing).
    const state = policy === undefined
      ? 'no-policy-record'
      : policy.some((r) => r.includes(CURRENT))
        ? 'allows-local'
        : policy.some((r) => r.includes(DEAD)) ? 'dead-route' : 'no-local-route'
    rows.push({
      id: header.id ?? entry.name,
      preset: header.agentPreset ?? '(none)',
      origin: header.origin ?? '(main)',
      depth: header.delegationDepth ?? 0,
      policy: policy === undefined ? '(no policy record)' : policy.join(','),
      state,
      frames: starts.length,
      bytes: statSync(file).size,
      mtime: statSync(file).mtime.toISOString(),
    })
  }
}

const count = (pred) => rows.filter(pred).length
const mains = rows.filter((r) => r.depth === 0)
console.log(`home     : ${HOME}`)
console.log(`local    : model on offer is "${CURRENT}"   deleted-model marker: "${DEAD}"`)
console.log(`sessions : ${rows.length}   main (depth 0): ${mains.length}`)
console.log('\nMAIN sessions (depth 0) by what their durable route policy allows:')
for (const s of ['allows-local', 'dead-route', 'no-local-route', 'no-policy-record']) {
  const hits = mains.filter((r) => r.state === s)
  console.log(`  ${s.padEnd(17)} ${hits.length}`)
  if (s === 'dead-route') {
    const routes = new Map()
    for (const r of hits) routes.set(r.policy, (routes.get(r.policy) ?? 0) + 1)
    for (const [k, v] of routes) console.log(`      pinned to: ${k}  (${v} session(s))`)
    for (const r of [...hits].sort((a, b) => b.mtime.localeCompare(a.mtime)).slice(0, 10)) {
      console.log(`      ${r.mtime.slice(0, 19)}  ${String(r.preset).padEnd(15)} ${r.id}`)
    }
  }
}
console.log(`\nall ${rows.length} sessions: allows-local=${count((r) => r.state === 'allows-local')}` +
  `  dead-route=${count((r) => r.state === 'dead-route')}` +
  `  no-local-route=${count((r) => r.state === 'no-local-route')}` +
  `  no-policy-record=${count((r) => r.state === 'no-policy-record')}`)
console.log('  "dead-route" + "no-local-route" = sessions where `subagent` with the local route is refused;')
console.log('  `delegate_batch` is unaffected either way (it uses this preset\'s own route). Children')
console.log('  (origin=subagent) cannot delegate anyway -- depth 2 is refused by the harness.')
if (OUT !== undefined) {
  writeFileSync(OUT, JSON.stringify(rows, null, 1), 'utf8')
  console.log(`\nfull rows written to ${OUT}`)
}
