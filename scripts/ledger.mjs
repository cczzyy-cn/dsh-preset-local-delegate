#!/usr/bin/env node
/**
 * ledger.mjs — sum up what gated local delegation actually cost and caught.
 *
 * `local-delegate.mjs` appends one JSON line per `delegate_batch` to
 * `$DSH_HOME/local-delegate-ledger.jsonl` (disable with `DSH_LOCAL_LEDGER=0`). This reads that file
 * and answers the only questions worth asking about it:
 *
 *   - how much local compute was spent, and how many tasks passed the gate;
 *   - which VERIFIER KINDS the work actually used, and how often they fail — the routing guide's
 *     "what is worth delegating" is a claim that this table can test;
 *   - how the numbers move by day.
 *
 * It reports what was measured (local tokens) and never invents an "API tokens saved" figure: that
 * would need the caller's model and price, which this file does not record.
 *
 * Usage:
 *   node scripts/ledger.mjs [--days N] [--file PATH] [--json]
 */
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const argv = process.argv.slice(2)
const flag = (name, fallback) => {
  const i = argv.indexOf(name)
  return i === -1 ? fallback : argv[i + 1]
}
const JSON_OUT = argv.includes('--json')
const days = Number(flag('--days', '0'))
const file = flag('--file', process.env.DSH_LOCAL_LEDGER && process.env.DSH_LOCAL_LEDGER !== '0'
  ? process.env.DSH_LOCAL_LEDGER
  : join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'local-delegate-ledger.jsonl'))

if (!existsSync(file)) {
  console.error(`ledger: no ledger at ${file}`)
  console.error('  it is written by delegate_batch (DSH_LOCAL_LEDGER=0 disables it); nothing to sum yet.')
  process.exit(0)
}

const cutoff = days > 0 ? Date.now() - days * 86400000 : 0
const rows = []
let skipped = 0
for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
  if (!line.trim()) continue
  try {
    const row = JSON.parse(line)
    if (Date.parse(row.ts) < cutoff) continue
    rows.push(row)
  } catch {
    skipped += 1
  }
}

const num = (v) => (Number.isFinite(v) ? v : 0)
const sum = (xs) => xs.reduce((n, x) => n + x, 0)
const pct = (a, b) => (b ? `${Math.round((a / b) * 100)}%` : '—')
const fmt = (n) => n.toLocaleString('en-US')
const median = (xs) => {
  if (!xs.length) return 0
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.floor(s.length / 2)]
}

const tasks = sum(rows.map((r) => num(r.tasks)))
const passed = sum(rows.map((r) => num(r.passed)))
const tokens = rows.reduce((a, r) => ({
  prompt: a.prompt + num(r.tokens?.prompt),
  read: a.read + num(r.tokens?.read),
  reused: a.reused + num(r.tokens?.reused),
  generated: a.generated + num(r.tokens?.generated),
}), { prompt: 0, read: 0, reused: 0, generated: 0 })
const localMs = sum(rows.map((r) => num(r.localMs)))
const retried = sum(rows.map((r) => num(r.retried)))

const byDay = new Map()
const byKind = new Map()
const byCwd = new Map()
for (const r of rows) {
  const day = String(r.ts || '').slice(0, 10)
  const d = byDay.get(day) || { batches: 0, tasks: 0, passed: 0, tokens: 0, ms: 0 }
  d.batches += 1
  d.tasks += num(r.tasks)
  d.passed += num(r.passed)
  d.tokens += num(r.tokens?.prompt) + num(r.tokens?.generated)
  d.ms += num(r.localMs)
  byDay.set(day, d)

  for (const k of Array.isArray(r.kinds) ? r.kinds : []) {
    const e = byKind.get(k) || { tasks: 0, batches: 0 }
    e.tasks += num(r.tasks)
    e.batches += 1
    byKind.set(k, e)
  }
  const cwd = r.cwd || '(unknown)'
  const c = byCwd.get(cwd) || { tasks: 0, passed: 0 }
  c.tasks += num(r.tasks)
  c.passed += num(r.passed)
  byCwd.set(cwd, c)
}

if (JSON_OUT) {
  console.log(JSON.stringify({
    file, batches: rows.length, tasks, passed, failed: tasks - passed, skippedLines: skipped,
    tokens: { ...tokens, total: tokens.prompt + tokens.generated },
    localMs, retried,
    byDay: Object.fromEntries(byDay), byKind: Object.fromEntries(byKind), byCwd: Object.fromEntries(byCwd),
  }, null, 2))
  process.exit(0)
}

console.log(`ledger: ${file}`)
console.log(`${rows.length} batch(es) · ${tasks} task(s) · ${passed} PASS (${pct(passed, tasks)}) · ${rows.length ? (localMs / 1000).toFixed(1) : 0} s local compute`)
console.log(`local tokens: ${fmt(tokens.prompt + tokens.generated)} (${fmt(tokens.prompt)} prompt: ${fmt(tokens.read)} read + ${fmt(tokens.reused)} reused; ${fmt(tokens.generated)} generated)`)
if (retried) console.log(`retries: ${retried} task(s) needed more than one attempt`)
if (skipped) console.log(`skipped ${skipped} unparsable line(s)`)

const dayRows = [...byDay.entries()].sort()
if (dayRows.length > 1) {
  console.log('\nby day')
  for (const [day, d] of dayRows) {
    console.log(`  ${day}  ${String(d.batches).padStart(3)} batch  ${String(d.tasks).padStart(4)} task  `
      + `${pct(d.passed, d.tasks).padStart(4)} PASS  ${fmt(d.tokens).padStart(9)} tokens  ${(d.ms / 1000).toFixed(1)} s`)
  }
}

const kindRows = [...byKind.entries()].sort((a, b) => b[1].tasks - a[1].tasks)
if (kindRows.length) {
  console.log('\nverifier kinds used')
  for (const [kind, e] of kindRows) {
    console.log(`  ${kind.padEnd(18)} ${String(e.batches).padStart(3)} batch  ${String(e.tasks).padStart(4)} task`)
  }
}

const cwdRows = [...byCwd.entries()].sort((a, b) => b[1].tasks - a[1].tasks).slice(0, 5)
if (cwdRows.length > 1) {
  console.log('\nby working directory')
  for (const [cwd, c] of cwdRows) {
    console.log(`  ${pct(c.passed, c.tasks).padStart(4)} PASS  ${String(c.tasks).padStart(4)} task  ${cwd}`)
  }
}
