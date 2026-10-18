#!/usr/bin/env node
/**
 * verifier-matrix.mjs — what each verifier kind actually rejects, measured rather than described.
 *
 * WHY. The sixteen kinds are the product: a gate with no discriminating power is worse than no gate,
 * because it turns "I checked" into a claim. The self-test already pins individual behaviours, but it
 * does not answer the question a caller asks when choosing a kind: *for this kind, what does a
 * near-miss look like, and is it caught?* This runs one positive and at least one near-miss negative
 * through every kind and prints the answer.
 *
 * The negatives are deliberately NEAR misses — right type, wrong value; right values, wrong order;
 * the quote present but on the wrong line — because that is where a check earns its keep.
 *
 * Usage:
 *   node scripts/verifier-matrix.mjs            # table, exit 1 if any case misbehaves
 *   node scripts/verifier-matrix.mjs --md       # Markdown, for docs/verifier-matrix.md
 *   node scripts/verifier-matrix.mjs --write    # write docs/verifier-matrix.md
 *   node scripts/verifier-matrix.mjs --json
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { check, VERIFIER_KINDS } from '../local-delegate.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..')
const argv = process.argv.slice(2)
const MD = argv.includes('--md') || argv.includes('--write')
const WRITE = argv.includes('--write')
const JSON_OUT = argv.includes('--json')

// citation is the one kind that reads the filesystem: it verifies that a quoted line really occurs
// at the claimed line. Its corpus has to exist, so it is built here and removed at the end.
const citeDir = mkdtempSync(join(tmpdir(), 'verifier-matrix-'))
writeFileSync(join(citeDir, 'a.txt'),
  'line one carries a sufficiently long sentence\nline two carries another sufficiently long sentence\n', 'utf8')
const citeCfg = JSON.stringify({ root: citeDir, files: ['a.txt'], minQuote: 12, minClaims: 1, require: ['a.txt'] })
const cite = (line, quote) => JSON.stringify([{ claim: 'x', evidence: { file: 'a.txt', line, quote } }])

const SCHEMA = JSON.stringify({
  type: 'object',
  required: ['a'],
  properties: { a: { type: 'integer' } },
  additionalProperties: false,
})

/**
 * want: true = this must PASS, false = this must FAIL.
 * note: what the negative is testing, in the words a reader needs.
 */
const CASES = [
  // json_equals — the strict one: same values in a different order are NOT equal.
  { kind: 'json_equals', content: '[1,2,3]', expected: '[1,2,3]', want: true },
  { kind: 'json_equals', content: '[1,2]', expected: '[2,1]', want: false, note: 'same values, wrong order' },

  // json_order — only the order of the named field is judged.
  { kind: 'json_order', content: '[{"v":"a"},{"v":"b"}]', expected: '["a","b"]', field: 'v', want: true },
  { kind: 'json_order', content: '[{"v":"b"},{"v":"a"}]', expected: '["a","b"]', field: 'v', want: false, note: 'reversed order' },

  // set_eq — order and duplicates are irrelevant, membership is not.
  { kind: 'set_eq', content: '[2,1,1]', expected: '[1,2]', want: true },
  { kind: 'set_eq', content: '[1,3]', expected: '[1,2]', want: false, note: 'one missing, one invented' },

  // count — length only.
  { kind: 'count', content: '[1,2,3]', expected: '3', want: true },
  { kind: 'count', content: '[1,2]', expected: '3', want: false, note: 'off by one' },

  // schema — the subset that is implemented, including additionalProperties:false.
  { kind: 'schema', content: '{"a":1}', expected: SCHEMA, want: true },
  { kind: 'schema', content: '{"a":"1"}', expected: SCHEMA, want: false, note: 'right key, wrong type' },
  { kind: 'schema', content: '{"a":1,"b":2}', expected: SCHEMA, want: false, note: 'extra key under additionalProperties:false' },

  // exact — trimmed string equality, case preserved.
  { kind: 'exact', content: ' 42 \n', expected: '42', want: true },
  { kind: 'exact', content: '42.0', expected: '42', want: false, note: 'numerically equal, textually not' },

  // regex — a pattern match, with an invalid pattern reported rather than thrown.
  { kind: 'regex', content: 'abc-123', expected: '^[a-z]+-\\d+$', want: true },
  { kind: 'regex', content: 'ABC-123', expected: '^[a-z]+-\\d+$', want: false, note: 'case' },

  // contains — literal substring.
  { kind: 'contains', content: 'the answer is 42', expected: '42', want: true },
  { kind: 'contains', content: 'the answer is 43', expected: '42', want: false, note: 'digit off by one' },

  // all_of — every needle, case- and punctuation-insensitive; wholeWord is opt-in.
  { kind: 'all_of', content: 'Alpha, beta and gamma.', expected: '["alpha","beta"]', want: true },
  { kind: 'all_of', content: 'Alpha and gamma.', expected: '["alpha","beta"]', want: false, note: 'a needle is absent' },
  { kind: 'all_of', content: 'the reader is here', expected: '{"needles":["read"],"wholeWord":true}', want: false, note: 'wholeWord: `read` must not match `reader`' },

  // compile — the answer parses as JavaScript (fences tolerated).
  { kind: 'compile', content: 'const x = 1', want: true },
  { kind: 'compile', content: 'const = =', want: false, note: 'syntax error' },

  // python_exec — extracts the def block and runs the caller's asserts. `asserts` is an ARRAY of
  // expressions (a bare string is read from `expected`, which is empty here) — the first run of this
  // matrix got that wrong and the kind said so, which is the point of running it.
  { kind: 'python_exec', content: 'def add(a, b):\n    return a + b\n', asserts: ['add(2, 3) == 5'], want: true },
  { kind: 'python_exec', content: 'def add(a, b):\n    return a - b\n', asserts: ['add(2, 3) == 5'], want: false, note: 'wrong operator, right shape' },

  // covers — judged on what the answer OMITS; needles may be machine-derived.
  { kind: 'covers', content: '["alpha","beta"]', expected: '["alpha","beta"]', want: true },
  { kind: 'covers', content: '["alpha"]', expected: '["alpha","beta"]', want: false, note: 'one needle omitted' },

  // subset_of — nothing invented; a missing member is not an error.
  { kind: 'subset_of', content: '["a"]', expected: '["a","b","c"]', want: true },
  { kind: 'subset_of', content: '["a","zz"]', expected: '["a","b","c"]', want: false, note: 'invented element' },

  // union_eq — a partition judged from the universe alone.
  { kind: 'union_eq', content: '{"x":["a"],"y":["b","c"]}', expected: '["a","b","c"]', want: true },
  { kind: 'union_eq', content: '{"x":["a"],"y":["b"]}', expected: '["a","b","c"]', want: false, note: 'item dropped' },
  { kind: 'union_eq', content: '{"x":["a","b"],"y":["b","c"]}', expected: '["a","b","c"]', want: false, note: 'item filed twice' },

  // citation — the claim is never judged, only whether the quote occurs at that line.
  { kind: 'citation', content: cite(1, 'sufficiently long sentence'), expected: citeCfg, want: true },
  { kind: 'citation', content: cite(9, 'sufficiently long sentence'), expected: citeCfg, want: false, note: 'right quote, wrong line' },
  { kind: 'citation', content: cite(1, 'this text appears nowhere'), expected: citeCfg, want: false, note: 'fabricated quote' },

  // python_check — any invariant, with the answer bound to `answer`. The source is `expected`.
  { kind: 'python_check', content: '{"n":3}', expected: 'assert answer["n"] == 3', want: true },
  { kind: 'python_check', content: '{"n":4}', expected: 'assert answer["n"] == 3', want: false, note: 'invariant violated' },
]

const results = SCASES()
function SCASES() {
  return CASES.map((c) => {
    let r
    try {
      r = check(c.kind, c.content, c.expected, c.field, c.asserts)
    } catch (e) {
      r = { ok: false, detail: `threw: ${(e && e.message) || e}` }
    }
    const got = r && r.ok === true
    return { ...c, got, detail: r && r.detail, mismatch: got !== c.want }
  })
}

rmSync(citeDir, { recursive: true, force: true })

const kinds = VERIFIER_KINDS.map((k) => k.id)
const byKind = new Map(kinds.map((k) => [k, { pos: 0, neg: 0, posPass: 0, negReject: 0, misses: [] }]))
for (const r of results) {
  const e = byKind.get(r.kind)
  if (r.want) { e.pos += 1; if (r.got) e.posPass += 1 } else { e.neg += 1; if (!r.got) e.negReject += 1 }
  if (r.mismatch) e.misses.push(`${r.want ? 'positive rejected' : 'negative passed'}${r.note ? ` (${r.note})` : ''}: ${r.detail || ''}`)
}

const uncovered = [...byKind.entries()].filter(([, e]) => e.pos === 0 || e.neg === 0).map(([k]) => k)
const broken = [...byKind.entries()].filter(([, e]) => e.misses.length > 0)

if (JSON_OUT) {
  console.log(JSON.stringify({ cases: results.length, kinds: kinds.length, uncovered, broken: broken.map(([k, e]) => ({ kind: k, misses: e.misses })), results }, null, 2))
  process.exit(broken.length || uncovered.length ? 2 : 0)
}

const lines = []
if (MD) {
  lines.push('# Verifier quality matrix')
  lines.push('')
  lines.push('Generated by `node scripts/verifier-matrix.mjs --write` — do not edit by hand.')
  lines.push('')
  lines.push('Every kind is run against a payload it must ACCEPT and at least one near miss it must REJECT.')
  lines.push('A near miss is the interesting column: right type wrong value, right values wrong order, the')
  lines.push('quote present but on the wrong line. `node scripts/check-docs.mjs` fails when this file is stale.')
  lines.push('')
  lines.push('| kind | positive | near miss it rejects | result |')
  lines.push('|---|---|---|---|')
  for (const k of kinds) {
    const e = byKind.get(k)
    const neg = results.filter((r) => r.kind === k && !r.want).map((r) => r.note).filter(Boolean)
    const verdict = e.misses.length ? `**BROKEN**: ${e.misses[0]}` : `${e.posPass}/${e.pos} pass · ${e.negReject}/${e.neg} rejected`
    lines.push(`| \`${k}\` | ${e.pos} | ${neg.join('; ') || '—'} | ${verdict} |`)
  }
  lines.push('')
  const totalPos = results.filter((r) => r.want).length
  const totalNeg = results.length - totalPos
  lines.push(`${results.length} cases: ${totalPos} must-pass, ${totalNeg} near misses across ${kinds.length} kinds.`)
} else {
  lines.push('')
  lines.push('kind                pos  neg   result')
  lines.push('─'.repeat(62))
  for (const k of kinds) {
    const e = byKind.get(k)
    const verdict = e.misses.length ? `BROKEN — ${e.misses[0]}` : `${e.posPass}/${e.pos} pass · ${e.negReject}/${e.neg} rejected`
    lines.push(`${k.padEnd(18)} ${String(e.pos).padStart(2)}   ${String(e.neg).padStart(2)}    ${verdict}`)
  }
  lines.push('')
  lines.push(`${results.length} cases across ${kinds.length} kinds: ${results.filter((r) => !r.mismatch).length} behaved as intended.`)
}

if (WRITE) {
  const out = join(REPO, 'docs', 'verifier-matrix.md')
  writeFileSync(out, `${lines.join('\n')}\n`, 'utf8')
  console.log(`wrote ${out}`)
} else {
  console.log(lines.join('\n'))
}

if (uncovered.length) {
  console.error(`\nno coverage for: ${uncovered.join(', ')} — every kind needs one positive and one near miss`)
}
if (broken.length) {
  console.error(`\n${broken.length} kind(s) did not behave as intended:`)
  for (const [k, e] of broken) for (const m of e.misses) console.error(`  ${k}: ${m}`)
}
process.exit(uncovered.length || broken.length ? 1 : 0)
