/**
 * local-delegate self-test.
 *
 * Every case pins a behaviour this preset depends on, and most of them pin a defect that a
 * weaker implementation actually had: a malformed schema that made `schema` pass everything,
 * `additionalProperties:false` silently ignored, a looping answer reported as `invalid JSON`,
 * an empty answer blamed on the model instead of the engine, a verifier exception aborting a
 * whole batch, and a delegation request that asked the provider for a reasoning effort it does
 * not advertise (which fails before the request is ever sent).
 *
 * The suite also drives `apply` with a minimal fake context, because `import` proves a module
 * evaluates but never that its handlers run.
 *
 *   node local-delegate.selftest.mjs
 */
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import {
  apply, buildChildRequest, check, inspectImages, looksDegenerate, matchesSchema, mutateAnswer,
  needlesFrom, positiveFromVerify, probeEngine, proveGate, VERIFIER_KIND_IDS,
} from './local-delegate.mjs'

let passed = 0
let failed = 0
let skipped = 0

function ok(name, cond, detail) {
  if (cond) {
    passed += 1
    console.log(`ok   ${name}`)
  } else {
    failed += 1
    console.log(`FAIL ${name}${detail === undefined ? '' : ` — ${detail}`}`)
  }
}

function skip(name, why) {
  skipped += 1
  console.log(`skip ${name} — ${why}`)
}

/** Assert a verifier verdict without letting a thrown error count as a verdict. */
function verdict(name, kind, content, expected, want, field, asserts) {
  let r
  try {
    r = check(kind, content, expected, field, asserts)
  } catch (e) {
    ok(name, false, `threw ${String((e && e.message) || e)}`)
    return
  }
  ok(name, r.ok === want, `ok=${r.ok} (wanted ${want}) detail=${r.detail}`)
}

console.log('# verifier kinds')

verdict('json_equals: exact payload passes', 'json_equals', '[1,2,3]', '[1,2,3]', true)
verdict('json_equals: fenced payload passes (local models wrap answers in fences)',
  'json_equals', '```json\n["a","b"]\n```', '["a","b"]', true)
verdict('json_equals: a wrong value fails', 'json_equals', '[1,2]', '[2,1]', false)

verdict('json_order: orders by the named field', 'json_order',
  '[{"v":"a"},{"v":"b"}]', '["a","b"]', true, 'v')
verdict('json_order: a wrong order fails', 'json_order',
  '[{"v":"b"},{"v":"a"}]', '["a","b"]', false, 'v')
verdict('json_order: no field name is a FAIL, not a crash', 'json_order', '[{"v":"a"}]', '["a"]', false)

verdict('set_eq: order and duplicates are irrelevant', 'set_eq', '[2,1,1]', '[1,2]', true)
verdict('set_eq: a non-array expectation is a FAIL, not a crash', 'set_eq', '[1,2]', '"nope"', false)

verdict('count: array length', 'count', '[1,2,3]', '3', true)
verdict('count: wrong length fails', 'count', '[1,2]', '3', false)
verdict('count: a non-array fails', 'count', '{"n":2}', '2', false)

console.log('\n# schema verifier (a gate that cannot fail is worse than no gate)')

verdict('schema: a matching payload passes', 'schema',
  '{"name":"a","n":2}', '{"type":"object","required":["name"],"properties":{"name":{"type":"string"}}}', true)
verdict('schema: a malformed schema FAILS instead of passing everything', 'schema',
  '{"anything":1}', '"not-a-schema"', false)
verdict('schema: additionalProperties:false is enforced', 'schema',
  '{"name":"a","extra":1}', '{"type":"object","properties":{"name":{"type":"string"}},"additionalProperties":false}', false)
verdict('schema: minLength is enforced', 'schema',
  '{"name":""}', '{"type":"object","properties":{"name":{"type":"string","minLength":2}}}', false)
verdict('schema: enum, minimum and nested items are enforced', 'schema',
  '{"mode":"z","n":1,"xs":[1,"two"]}',
  '{"type":"object","properties":{"mode":{"enum":["a","b"]},"n":{"minimum":5},"xs":{"type":"array","items":{"type":"integer"}}}}', false)
verdict('schema: integer and number are distinguished', 'schema',
  '{"n":1.5}', '{"type":"object","properties":{"n":{"type":"integer"}}}', false)
ok('matchesSchema: a bare string schema does not reject an object',
  matchesSchema({ a: 1 }, {}) === true)

console.log('\n# scalar verifiers')

verdict('exact: trimmed equality passes', 'exact', ' 42 \n', '42', true)
verdict('exact: a different value fails', 'exact', '43', '42', false)
verdict('regex: a match passes', 'regex', 'abc-123', '^[a-z]+-\\d+$', true)
verdict('regex: an invalid pattern is a FAIL with a readable reason, not a throw', 'regex', 'x', '[', false)
const regexBad = check('regex', 'x', '[', undefined)
ok('regex: the invalid-pattern reason names the pattern problem',
  /invalid regex pattern/.test(regexBad.detail), regexBad.detail)
verdict('contains: a substring passes', 'contains', 'the answer is 42', '42', true)

// `all_of` is the reading verifier. A vision or transcript answer is prose, so the caller must be
// able to say "these facts must all appear" without knowing the phrasing — and must still FAIL for
// something that is not in the image at all.
verdict('all_of: every needle present in prose passes, ignoring case and punctuation',
  'all_of', 'The digit **3** is inside the **circle** (or oval).', ['3', 'circle'], true)
verdict('all_of: a hyphenated reading still matches the word',
  'all_of', 'Send e-mail to the office.', ['email'], true)
verdict('all_of: a needle that is absent FAILS — the check is not decorative',
  'all_of', 'The digit 3 is inside a circle.', ['3', 'purple elephant'], false)
verdict('all_of: a "|"-separated string works as well as an array',
  'all_of', 'a circle and a rectangle', 'circle|rectangle', true)
verdict('all_of: a wrong shape FAILS even though the digit is right',
  'all_of', 'The digit 3 is inside a circle.', ['3', 'ellipse'], false)
verdict('all_of: an empty needle list FAILS rather than trivially passing',
  'all_of', 'anything', [], false)
verdict('all_of: a non-string expectation is a FAIL, not a crash',
  'all_of', 'anything', 42, false)
const allOfDetail = check('all_of', 'nothing here', ['alpha', 'beta'])
ok('all_of: the reason names what was missing',
  /2\/2 not found/.test(allOfDetail.detail) && /alpha/.test(allOfDetail.detail), allOfDetail.detail)

// A line break inside a needle must not fail on layout alone (OCR answers rewrap).
verdict('all_of: a needle split across two lines still matches',
  'all_of', 'MEN WALK ON MOON\n SAMPLE 42 DELTA', ['MEN WALK ON MOON', 'SAMPLE 42 DELTA'], true)

// wholeWord — the difference between "mentions read" and "mentions reader". The second case is the
// one that fails if boundary matching runs on the SQUASHED text, where "the reader" has become
// "thereader" and a legitimate needle of `reader` no longer starts at a boundary.
verdict('all_of: wholeWord rejects a needle glued to another word',
  'all_of', 'The reader is here.', '{"needles":["read"],"wholeWord":true}', false)
verdict('all_of: wholeWord keeps a legitimate word whose neighbour the squash removed',
  'all_of', 'The reader is here.', '{"needles":["reader"],"wholeWord":true}', true)
verdict('all_of: without wholeWord the substring still counts (unchanged behaviour)',
  'all_of', 'The reader is here.', '["read"]', true)
verdict('compile: loose JavaScript parses', 'compile', 'const x = 1', undefined, true)
verdict('compile: garbage fails', 'compile', 'const = =', undefined, false)
verdict('compile: a fenced block still parses', 'compile', '```js\nconst x = 1\n```', undefined, true)

console.log('\n# the failure modes that used to be misreported')

const empty = check('json_equals', '   ', '[]')
ok('an empty answer blames the engine, not the model', /engine offline/.test(empty.detail), empty.detail)

const loop = Array.from({ length: 12 }, () => 'the same line over and over').join('\n')
ok('looksDegenerate flags a looping answer', looksDegenerate(loop) === true)
ok('looksDegenerate leaves a normal JSON answer alone',
  looksDegenerate(JSON.stringify({ a: 1, b: [1, 2, 3] })) === false)
const looped = check('json_equals', loop, '[]')
ok('a looping answer is reported as repetition, not as invalid JSON',
  /degenerate repetition/.test(looped.detail), looped.detail)

console.log('\n# the gate NEVER throws (a verifier exception used to abort the whole batch)')

for (const kind of ['json_equals', 'json_order', 'set_eq', 'count', 'schema']) {
  let r
  let threw = null
  try {
    r = check(kind, '{"a":1}', '[]', undefined)
  } catch (e) {
    threw = e
  }
  ok(`check(${kind}) on valid JSON of the wrong type is a FAIL, not a crash`,
    threw === null && r && r.ok === false, threw ? String(threw.message) : `ok=${r && r.ok}`)
}
const unknown = check('nope', 'x', undefined)
ok('an unknown kind is a FAIL with the kind named', unknown.ok === false && /unknown kind/.test(unknown.detail))

// `python_exec` is the only verifier that extracts source out of prose and then shells out.
const pyNoAsserts = check('python_exec', 'def f():\n    return 1', undefined)
ok('python_exec without asserts refuses rather than passing',
  pyNoAsserts.ok === false && /needs asserts/.test(pyNoAsserts.detail), pyNoAsserts.detail)
ok('python_exec FINDS a def whose indented body runs to the end of the answer '
  + '(a `\\Z` lookahead silently matched a literal "Z" and reported "no def block")',
  !/no def block/.test(pyNoAsserts.detail), pyNoAsserts.detail)
const pyFenced = check('python_exec', '```python\ndef f(n):\n    return n\n```', undefined)
ok('python_exec sees through a code fence', !/no def block/.test(pyFenced.detail), pyFenced.detail)

// The block must stop at the first non-indented line, not swallow the whole answer: `assert`
// lines are appended after it, so a swallowed top-level statement would be re-defined or run.
const pyPositive = check('python_exec', 'def f(n):\n    return n * 2\nprint("noise")', undefined, undefined, ['f(21) == 42'])
if (pyPositive.ok) ok('python_exec runs the extracted code and its asserts', true)
else if (/ENOENT/.test(pyPositive.detail)) skip('python_exec runs the extracted code and its asserts', 'no python interpreter on PATH')
else ok('python_exec runs the extracted code and its asserts', false, pyPositive.detail)

console.log('\n# the delegated child request (pinned against the live provider contract)')

const base = await buildChildRequest({
  label: '1.x', parent: { id: 'p' }, prompt: 'hi', signal: undefined,
  provider: 'strata', model: 'm', reasoningEffort: '', maxTokens: 4096,
  stripTools: true, persona: 'be terse',
})
ok('the request carries the local route', base.agentOptions.provider === 'strata' && base.agentOptions.model === 'm')
ok('NO reasoning effort is sent when none is configured (the provider rejects an unadvertised effort)',
  !('reasoningEffort' in base.agentOptions), JSON.stringify(base.agentOptions))
ok('a max-token cap is sent so one delegation cannot run away', base.agentOptions.maxTokens === 4096)
ok('the child tool surface is stripped', base.toolFilter && Array.isArray(base.toolFilter.allow)
  && base.toolFilter.allow.length === 0, JSON.stringify(base.toolFilter))
// A `deny` list here is a MEASURED BUG, not a hardening, and this pins it. `tools.restrict()`
// validates denied names against the GLOBAL registry and refuses the whole request for an unknown
// one — measured: `tools.restrict() names unknown global tools "subagent", … ; known global tools:
// …`. The tool that caused the runaway (`subagent`) is registered by this preset's OWN composition,
// so it is not global and cannot be named; and the global delegation tools it COULD name are already
// excluded by `allow: []`. With such a list every task failed in ~5 ms for attempts=3.
ok('the child filter is exactly { allow: [] } — no `deny` key (a deny list breaks the whole path)',
  !('deny' in base.toolFilter), JSON.stringify(base.toolFilter))
ok('the child persona shadows the deployment persona section', base.persona === 'be terse')
ok('the prompt is a single text block when no image is attached', base.prompt.length === 1 && base.prompt[0].type === 'text')
ok('an image-less request carries no imageError', !('imageError' in base))

const withEffort = await buildChildRequest({ provider: 'strata', model: 'm', reasoningEffort: 'off', maxTokens: 0, stripTools: false, persona: '' })
ok('a configured reasoning effort IS carried through', withEffort.agentOptions.reasoningEffort === 'off')
ok('maxTokens 0 omits the cap', !('maxTokens' in withEffort.agentOptions))
ok('stripTools:false omits the tool filter', !('toolFilter' in withEffort))
ok('an empty persona is omitted (never shadow with an empty string)', !('persona' in withEffort))

console.log('\n# image delegation (the local engine is multimodal)')

// A 1x1 PNG is enough: what is pinned here is the request SHAPE and the path handling, not pixels.
const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)
const imgDir = mkdtempSync(join(tmpdir(), 'local-delegate-imgtest-'))
const pngPath = join(imgDir, 'probe.png')
writeFileSync(pngPath, PNG_1PX)

/** Stand-in for ctx.attachments. Records what was admitted and returns the real ref shape. */
function fakeAttachments(overrides) {
  const o = overrides || {}
  const saved = []
  return {
    saved,
    saveImages: async (inputs) => {
      if (o.fail) throw new Error(o.fail)
      saved.push(inputs)
      return inputs.map((input, i) => ({
        attachmentId: `sha256:probe${i}`,
        mediaType: input.mediaType,
        width: 1,
        height: 1,
        ...(input.name === undefined ? {} : { name: input.name }),
      }))
    },
  }
}

const att0 = fakeAttachments()
const withImg = await buildChildRequest({
  provider: 'strata', model: 'm', prompt: 'what is in this image?', images: [pngPath],
  attachments: att0, maxTokens: 4096, stripTools: true, persona: 'be terse',
})
ok('an attached image becomes a second block of type "image"',
  withImg.prompt.length === 2 && withImg.prompt[1].type === 'image',
  JSON.stringify(withImg.prompt.map((b) => b.type)))
// This is the defect this suite exists to prevent: the pi-ai adapter switches on block.type and its
// only image case is `image`, reading block.attachment.attachmentId. An `image_url` block (the
// obvious OpenAI shape) hits `default: break` and is dropped with NO error, so the model answers
// about a picture it never received. It shipped in an earlier revision of this file and was caught
// only by running a real delegation against the engine, which answered about something else.
ok('NEVER the image_url shape (the adapter drops it silently, with no error)',
  !withImg.prompt.some((b) => b.type === 'image_url'), JSON.stringify(withImg.prompt.map((b) => b.type)))
ok('the image block carries a durable attachment ref, which is what the adapter reads',
  withImg.prompt[1].attachment && typeof withImg.prompt[1].attachment.attachmentId === 'string',
  JSON.stringify(withImg.prompt[1]))
// BYTES, not base64. The build declares `SaveImageAttachment { data: Uint8Array; … }` and its store
// decodes with sharp; base64 is the RPC *wire* shape, which the harness converts before calling the
// same store method. This assertion used to pin base64 — the module's own assumption rather than the
// build's contract — and that is exactly why every `images:` delegation failed in ~0 ms with
// `Unsupported or malformed image data.` while the suite stayed green.
ok('the image bytes are handed to the attachment store as BYTES (the declared Uint8Array contract)',
  att0.saved.length === 1
  && (Buffer.isBuffer(att0.saved[0][0].data) || att0.saved[0][0].data instanceof Uint8Array)
  && !(typeof att0.saved[0][0].data === 'string')
  && Buffer.compare(Buffer.from(att0.saved[0][0].data), PNG_1PX) === 0,
  `typeof=${typeof att0.saved[0][0].data} ctor=${att0.saved[0][0] && att0.saved[0][0].data && att0.saved[0][0].data.constructor && att0.saved[0][0].data.constructor.name}`)
ok('the media type is derived per extension, not assumed to be PNG',
  att0.saved[0][0].mediaType === 'image/png', JSON.stringify(att0.saved[0][0].mediaType))
ok('the text block survives alongside the image', withImg.prompt[0].text === 'what is in this image?')
ok('a readable image produces no imageError', !('imageError' in withImg))

const noImages = await buildChildRequest({ prompt: 'x' })
ok('no images means no imageError field', !('imageError' in noImages))
const emptyImages = await buildChildRequest({ prompt: 'x', images: [] })
ok('an empty image list means no imageError field', !('imageError' in emptyImages))

// A READABLE image with no attachment service must FAIL, never fall through to a text-only request:
// that is exactly the silent-drop failure mode this whole section guards against.
const noAttachments = await buildChildRequest({ prompt: 'x', images: [pngPath] })
ok('a readable image with no attachment service is an imageError, not a silent text-only request',
  /attachment service is not mounted/.test(noAttachments.imageError || ''), noAttachments.imageError)
ok('and it does not pretend to carry the image', noAttachments.prompt.length === 1)

// A bad path must be reported, never thrown: an escaping throw would abort the whole batch.
let threwOnBadPath = null
let badPathReq = null
try {
  badPathReq = await buildChildRequest({ prompt: 'x', images: [join(imgDir, 'nope.png')], attachments: fakeAttachments() })
} catch (e) { threwOnBadPath = e }
ok('a missing image file does NOT throw out of buildChildRequest',
  threwOnBadPath === null, threwOnBadPath ? String(threwOnBadPath.message) : 'threw')
ok('a missing image file is reported as imageError naming the path',
  badPathReq && /cannot read/.test(badPathReq.imageError) && /nope\.png/.test(badPathReq.imageError),
  badPathReq ? badPathReq.imageError : 'no request')
ok('the failing request still carries its text block, so the reason is readable',
  badPathReq && badPathReq.prompt.length === 1 && badPathReq.prompt[0].type === 'text')

// Validate-before-commit: a bad path in a batch must not leave the good member stored.
const attHalf = fakeAttachments()
const mixed = await buildChildRequest({ prompt: 'x', images: [pngPath, join(imgDir, 'gone.png')], attachments: attHalf })
ok('a batch with one bad path admits NOTHING (no half-stored attachments left behind)',
  attHalf.saved.length === 0 && /cannot read/.test(mixed.imageError || ''),
  `saved=${attHalf.saved.length} err=${mixed.imageError}`)

// A store that refuses must surface as imageError, not as an escaping throw.
const attFail = fakeAttachments({ fail: 'image batch exceeds the configured limit' })
const refused = await buildChildRequest({ prompt: 'x', images: [pngPath], attachments: attFail })
ok('a refused attachment batch is an imageError, not a throw',
  /exceeds the configured limit/.test(refused.imageError || ''), refused.imageError)

const insp = inspectImages([pngPath])
ok('inspectImages returns store-shaped inputs (bytes + mediaType + name), not blocks and not base64',
  insp.length === 1 && insp[0].data instanceof Uint8Array && typeof insp[0].data !== 'string'
  && insp[0].mediaType === 'image/png'
  && insp[0].name === 'probe.png', JSON.stringify({ t: typeof insp[0].data, n: insp[0].name }))
ok('inspectImages passes no images through as an empty list',
  inspectImages(undefined).length === 0 && inspectImages('').length === 0)

let threwOnBadExt = null
try { inspectImages([join(imgDir, 'notes.txt')]) } catch (e) { threwOnBadExt = e }
ok('an unsupported extension is refused with the supported list named',
  threwOnBadExt !== null && /unsupported image extension/.test(String(threwOnBadExt.message)),
  threwOnBadExt ? String(threwOnBadExt.message) : 'did not throw')

rmSync(imgDir, { recursive: true, force: true })

console.log('\n# preset wiring (apply, driven with a minimal fake context)')

function fakeCtx(options) {
  const o = options || {}
  const tools = []
  const sections = []
  const ctx = {
    tools: { register: (def) => { tools.push(def); return () => {} } },
    systemPrompt: { section: (s) => { sections.push(s); return () => {} } },
    get: (key) => {
      if (key === 'subagents') return o.subagents
      if (key === 'attachments') return o.attachments
      return undefined
    },
  }
  if (o.effect) ctx.effect = (fn) => fn()
  return { ctx, tools, sections }
}

function fakeSubagents(responses, stopReasons, diagnostics) {
  const requests = []
  let disposed = 0
  let calls = 0
  return {
    requests,
    get disposed() { return disposed },
    list: () => ['spawn'],
    start: async (name, req) => {
      requests.push({ name, req })
      const text = responses[Math.min(calls, responses.length - 1)]
      const stop = Array.isArray(stopReasons)
        ? stopReasons[Math.min(calls, stopReasons.length - 1)]
        : (stopReasons || 'completed')
      const diagnostic = Array.isArray(diagnostics)
        ? diagnostics[Math.min(calls, diagnostics.length - 1)]
        : diagnostics
      calls += 1
      return {
        id: `child-${calls}`,
        localAgent: undefined,
        result: Promise.resolve({
          output: [{ type: 'text', text }],
          stopReason: stop,
          ...(diagnostic ? { diagnostic } : {}),
        }),
        dispose: async () => { disposed += 1 },
      }
    },
  }
}

const wired = fakeCtx({ effect: true, subagents: fakeSubagents(['[]']) })
apply(wired.ctx)
const names = wired.tools.map((t) => t.name).sort()
ok('apply registers exactly verify_task and delegate_batch',
  JSON.stringify(names) === JSON.stringify(['delegate_batch', 'verify_task']), JSON.stringify(names))
ok('apply registers exactly one prompt section', wired.sections.length === 1)
ok('the prompt section is named for this plugin', wired.sections[0] && wired.sections[0].name === 'tool:local-delegate')
ok('the prompt section is a FUNCTION, so it can decide per request whether to say anything',
  typeof wired.sections[0].text === 'function')
// The top-level agent is the only one that can act on the routing guide; a delegated child has no
// tools here and cannot delegate, and it used to pay 1,633 prompt tokens for this text on every
// single delegation (measured: 6,679 chars). Depth is the harness's own child predicate.
const asGuide = (agent) => wired.sections[0].text({ agent })
const parentAgent = { session: { header: {} }, options: {} }
const childAgent = { session: { header: { delegationDepth: 1, origin: 'subagent', parentSession: 'p' } }, options: {} }
const childByOptions = { session: { header: {} }, options: { subagentDepth: 1 } }
ok('the routing guide is given to the top-level agent',
  /deterministic checker/.test(asGuide(parentAgent)) && /escalate to DeepSeek/.test(asGuide(parentAgent)))
// The routing POLICY still stays with the parent, but a child is no longer told NOTHING: raising
// maxDepth falsified the old "a delegated child has no tools here and cannot delegate", and a child
// that re-delegated, or that polled job_* for a subagent id, burned budget that is never retried.
// It now gets CHILD_GUIDE — the traps only, at roughly a tenth of the length.
const isRoutingGuide = (t) => /deterministic checker/.test(t)
ok('the routing guide is WITHHELD from a delegated child (header depth)',
  !isRoutingGuide(asGuide(childAgent)), JSON.stringify(asGuide(childAgent).slice(0, 60)))
ok('the routing guide is WITHHELD from a delegated child (runtime depth)',
  !isRoutingGuide(asGuide(childByOptions)))
ok('a delegated child IS given the child notes (re-delegation and job_* traps)',
  /DELEGATED CHILD/.test(asGuide(childAgent))
  && /run_in_background: false/.test(asGuide(childAgent))
  && /job_output/.test(asGuide(childAgent)))
ok('the child notes are far shorter than the routing guide',
  asGuide(childAgent).length * 3 < asGuide(parentAgent).length,
  `${asGuide(childAgent).length} vs ${asGuide(parentAgent).length}`)
ok('an unreadable context keeps the guide (the safe direction: never hide it from the top-level agent)',
  /deterministic checker/.test(asGuide(undefined)) && /deterministic checker/.test(wired.sections[0].text({})))
ok('verify_task is registered with an output renderer', typeof wired.tools.find((t) => t.name === 'verify_task').output.render === 'function')
// WITHDRAWN, and pinned so it is not silently re-added: an `engine_info` tool that GETs `/health` was
// built, then failed with `Error: content.some is not a function` in TWO parameter shapes (empty
// `properties`, then one real optional parameter), and was removed. See the note in the module. The
// knowledge it was meant to carry lives in the GUIDE instead of in a tool.
ok('the withdrawn engine_info tool is NOT registered',
  wired.tools.find((t) => t.name === 'engine_info') === undefined)

// The kind table is the single source for the description and for both schemas, so they cannot drift
// apart again. They HAD drifted, and this is the check that would have caught it: `checkInner`
// implemented sixteen kinds while the `verify_task` description still named eleven, which left the
// five kinds that need no expected answer — the ones this preset exists for — invisible in the tool
// contract. The comparison is against the SOURCE, not against the table, so a kind added to
// `checkInner` and forgotten in the table fails here too.
const moduleSource = readFileSync(fileURLToPath(new URL('./local-delegate.mjs', import.meta.url)), 'utf8')
const implementedKinds = [...new Set([...moduleSource.matchAll(/case '([a-z_]+)':/g)].map((m) => m[1]))].sort()
const verifyDef = wired.tools.find((t) => t.name === 'verify_task')
const dbDef = wired.tools.find((t) => t.name === 'delegate_batch')
const verifySchema = dbDef.parameters.properties.tasks.items.properties.verify
ok('every kind checkInner implements is in VERIFIER_KINDS',
  JSON.stringify(implementedKinds) === JSON.stringify([...VERIFIER_KIND_IDS].sort()),
  `implemented=${implementedKinds.join(', ')} | table=${VERIFIER_KIND_IDS.join(', ')}`)
ok('the verify_task description names every kind (five were missing before)',
  VERIFIER_KIND_IDS.every((id) => verifyDef.description.includes(id)),
  VERIFIER_KIND_IDS.filter((id) => !verifyDef.description.includes(id)).join(', '))
ok('the verify_task kind parameter enumerates every kind',
  JSON.stringify(verifyDef.parameters.properties.kind.enum) === JSON.stringify(VERIFIER_KIND_IDS))
ok('the delegation schema enumerates the kinds too (the model chose blind before)',
  JSON.stringify(verifySchema.properties.kind.enum) === JSON.stringify(VERIFIER_KIND_IDS))
const readmeText = readFileSync(fileURLToPath(new URL('./README.md', import.meta.url)), 'utf8')
ok('the README documents every kind',
  VERIFIER_KIND_IDS.every((id) => readmeText.includes(`\`${id}\``)),
  VERIFIER_KIND_IDS.filter((id) => !readmeText.includes(`\`${id}\``)).join(', '))

const noEffect = fakeCtx({ effect: false, subagents: fakeSubagents(['[]']) })
apply(noEffect.ctx)
ok('apply still registers without ctx.effect (the fallback the self-test depends on)', noEffect.tools.length === 2)

console.log('\n# delegate_batch, end to end against a fake provider')

const verify = { kind: 'json_equals', expected: '[1]' }
const happy = fakeSubagents(['[1]'])
const h = fakeCtx({ effect: true, subagents: happy })
apply(h.ctx)
const happyTool = h.tools.find((t) => t.name === 'delegate_batch')
const happyResult = await happyTool.execute(
  { tasks: [{ description: 'a', prompt: 'p', verify }] },
  { agent: { id: 'parent' }, signal: undefined },
)
ok('a passing task reports PASS with its attempt count',
  happyResult.results[0].ok === true && happyResult.results[0].attempts === 1,
  JSON.stringify(happyResult.results[0]))
ok('the delegated child request is the stripped local one',
  happy.requests[0].req.agentOptions.provider === 'strata'
  && Array.isArray(happy.requests[0].req.toolFilter.allow)
  && happy.requests[0].req.toolFilter.allow.length === 0,
  JSON.stringify(happy.requests[0].req.agentOptions))
ok('every run is disposed', happy.disposed === 1)
ok('the render echoes the raw answer so the caller can read what it paid for',
  /raw: \[1\]/.test(happyTool.output.render({}, happyResult)[0].text))

// A failure must retry ONCE, then escalate — and must not abort the tasks after it.
// (Explicit `retries: 1`: the DEFAULT is 0, which the next block tests.)
const flaky = fakeSubagents(['[2]', '[1]', '[3]'])
const f = fakeCtx({ effect: true, subagents: flaky })
apply(f.ctx)
const flakyTool = f.tools.find((t) => t.name === 'delegate_batch')
const flakyResult = await flakyTool.execute(
  {
    // Explicit, because the DEFAULT is now 0 (see the test below): this case is about the retry PATH,
    // not about the default.
    retries: 1,
    tasks: [
      { description: 'first fails once then passes', prompt: 'p1', verify },
      { description: 'second', prompt: 'p2', verify: { kind: 'json_equals', expected: '[3]' } },
    ],
  },
  { agent: { id: 'parent' }, signal: undefined },
)
ok('an explicitly requested retry is spent, and the recovery is reported',
  flakyResult.results[0].ok === true && flakyResult.results[0].attempts === 2,
  JSON.stringify(flakyResult.results[0]))
ok('a failing task does not abort the remaining tasks',
  flakyResult.results.length === 2 && flakyResult.results[1].ok === true,
  JSON.stringify(flakyResult.results))
ok('task ids are numbered so two delegations of the same file do not collide',
  flakyResult.results[0].id.startsWith('1.') && flakyResult.results[1].id.startsWith('2.'))
ok('every run is disposed even on the retry path', flaky.disposed === 3, String(flaky.disposed))

// THE DEFAULT IS 0: a FAIL is reported so the caller can escalate, instead of being silently
// re-bought. Measured — nothing was ever `recovered` across 10 same-shape observations, and a
// retried task can now loop and cost a whole DSH_DELEGATE_TIMEOUT_MS budget (seen twice). A resend is
// also exactly what the README tells the caller NOT to do: change the question or split the input.
const noRetry = fakeSubagents(['[2]'])
const nr = fakeCtx({ effect: true, subagents: noRetry })
apply(nr.ctx)
const nrResult = await nr.tools.find((t) => t.name === 'delegate_batch').execute(
  { tasks: [{ description: 'always wrong', prompt: 'p', verify }] },
  { agent: { id: 'parent' }, signal: undefined },
)
ok('a FAIL is NOT retried by default: one child is spent and the failure is reported',
  nrResult.results[0].ok === false && nrResult.results[0].attempts === 1 && noRetry.requests.length === 1,
  `attempts=${nrResult.results[0].attempts} started=${noRetry.requests.length}`)
ok('the default-0 FAIL still carries its verifier reason, so the caller can escalate it',
  /json_equals/.test(nrResult.results[0].detail), nrResult.results[0].detail)
ok('the schema advertises the new default, so the model does not assume a free retry',
  /default 0/.test(dbDef.parameters.properties.retries.description),
  dbDef.parameters.properties.retries.description)

// The footer must report what the PATH cost, not just what the last attempt cost. A retry is local
// compute too, and summing only `ms` hid it: measured 2026-10-02, a batch that really spent ~253 s
// printed `240.1 s of local compute`. Attempt 1 here is deliberately slow and FAILS; the retry is
// instant and passes — so `ms` stays ~0 while `spentMs` carries the whole 60 ms.
function slowFirstSubagents(firstMs) {
  let calls = 0
  return {
    list: () => ['spawn'],
    start: async () => {
      calls += 1
      const mine = calls
      if (mine === 1) await new Promise((r) => setTimeout(r, firstMs))
      const text = mine === 1 ? '[2]' : '[1]'
      return {
        id: `slow-${mine}`,
        result: Promise.resolve({ output: [{ type: 'text', text }], stopReason: 'completed' }),
        dispose: async () => {},
      }
    },
  }
}

const slow = slowFirstSubagents(60)
const sl = fakeCtx({ effect: true, subagents: slow })
apply(sl.ctx)
const slTool = sl.tools.find((t) => t.name === 'delegate_batch')
const slResult = await slTool.execute(
  // Explicit `retries: 1`: the DEFAULT is now 0, and this test is about the COST accounting.
  { retries: 1, tasks: [{ description: 'slow first', prompt: 'p', verify }] },
  { agent: { id: 'parent' }, signal: undefined },
)
const slRow = slResult.results[0]
ok('a retried task records the cost of EVERY attempt, not just the last one',
  slRow.attempts === 2 && slRow.ms < 50 && slRow.spentMs >= 55,
  `attempts=${slRow.attempts} ms=${slRow.ms} spentMs=${slRow.spentMs}`)
ok('the batch footer is computed from the full cost (a retry no longer hides its own compute)',
  slTool.output.render({}, slResult)[0].text.includes(`${(slRow.spentMs / 1000).toFixed(1)} s of local compute`),
  slTool.output.render({}, slResult)[0].text)

const unverified = fakeSubagents(['whatever'])
const u = fakeCtx({ effect: true, subagents: unverified })
apply(u.ctx)
const uResult = await u.tools.find((t) => t.name === 'delegate_batch').execute(
  { tasks: [{ description: 'no verifier', prompt: 'p' }] },
  { agent: { id: 'parent' }, signal: undefined },
)
ok('a task without a verifier is reported as unverified, not as a pass',
  uResult.results[0].ok === null && /no verifier/.test(uResult.results[0].detail),
  JSON.stringify(uResult.results[0]))

// A child that never finishes must not be able to hold the caller.
// Measured 2026-10-02: one `delegate_batch` child re-delegated its own task 169 times and ran 341 s
// / 24,500 output tokens, because NOTHING here bounded a single run — `retries` bounds re-runs, and
// the harness exposes no step cap at all. This fake never settles `result`, which is the worst case:
// a child that ignores the abort signal entirely.
function hangingSubagents() {
  const requests = []
  let disposed = 0
  return {
    requests,
    get disposed() { return disposed },
    list: () => ['spawn'],
    start: async (name, req) => {
      requests.push({ name, req })
      return { id: 'child-hang', result: new Promise(() => {}), dispose: async () => { disposed += 1 } }
    },
  }
}

process.env.DSH_DELEGATE_TIMEOUT_MS = '120'
const hang = hangingSubagents()
const hb = fakeCtx({ effect: true, subagents: hang })
apply(hb.ctx)
const budgetStart = Date.now()
const budgetResult = await hb.tools.find((t) => t.name === 'delegate_batch').execute(
  { retries: 2, tasks: [{ description: 'hang', prompt: 'p', verify }] },
  { agent: { id: 'parent' }, signal: undefined },
)
const budgetElapsed = Date.now() - budgetStart
delete process.env.DSH_DELEGATE_TIMEOUT_MS
const budgetRow = budgetResult.results[0]
ok('a child that never finishes is cut off by this preset\'s own budget, not by the operator',
  budgetRow.ok === false && budgetRow.stop === 'aborted' && /did not finish/.test(budgetRow.detail),
  JSON.stringify(budgetRow))
ok('the budget stop names the budget AND the knob that moves it',
  /budget expired/.test(budgetRow.detail) && /DSH_DELEGATE_TIMEOUT_MS/.test(budgetRow.detail),
  budgetRow.detail)
ok('a budget overrun is NOT retried (it reproduces), so exactly one child was started',
  budgetRow.attempts === 1 && hang.requests.length === 1,
  `attempts=${budgetRow.attempts} started=${hang.requests.length}`)
ok('the caller is released when the budget expires, not left waiting on a dead child',
  budgetElapsed < 1500, `${budgetElapsed} ms`)
ok('a cut-off child is still disposed', hang.disposed === 1, String(hang.disposed))

// The budget is read per call, so a one-off tiny value must not leak into the next delegation.
const afterBudget = fakeSubagents(['[1]'])
const ab = fakeCtx({ effect: true, subagents: afterBudget })
apply(ab.ctx)
const abResult = await ab.tools.find((t) => t.name === 'delegate_batch').execute(
  { tasks: [{ description: 'after', prompt: 'p', verify }] },
  { agent: { id: 'parent' }, signal: undefined },
)
ok('the budget is read per call: a one-off tiny value does not leak into later delegations',
  abResult.results[0].ok === true && abResult.results[0].attempts === 1,
  JSON.stringify(abResult.results[0]))

// A delegation that throws must be reported per task, never escape.
const boom = {
  list: () => ['spawn'],
  start: async () => { throw new Error('provider exploded') },
}
const b = fakeCtx({ effect: true, subagents: boom })
apply(b.ctx)
const bResult = await b.tools.find((t) => t.name === 'delegate_batch').execute(
  { tasks: [{ description: 'boom', prompt: 'p', verify }] },
  { agent: { id: 'parent' }, signal: undefined },
)
ok('a delegation error is a per-task FAIL with the reason',
  bResult.results[0].ok === false && /provider exploded/.test(bResult.results[0].detail),
  JSON.stringify(bResult.results[0]))

// No provider registered is one actionable error, not N misleading rows.
const none = fakeCtx({ effect: true, subagents: { list: () => [], start: async () => { throw new Error('unreachable') } } })
apply(none.ctx)
let noProviderThrew = null
try {
  await none.tools.find((t) => t.name === 'delegate_batch').execute(
    { tasks: [{ description: 'x', prompt: 'p' }] }, { agent: { id: 'parent' } })
} catch (e) { noProviderThrew = e }
ok('no registered subagent provider is one readable error',
  noProviderThrew !== null && /no subagent provider registered/.test(String(noProviderThrew.message)),
  noProviderThrew ? String(noProviderThrew.message) : 'did not throw')

// A bad image path is a CALLER error: it must fail its own task, not retry (it will reproduce) and
// NOT abort the tasks after it.
const imgDir2 = mkdtempSync(join(tmpdir(), 'local-delegate-imgtest2-'))
const goodPng = join(imgDir2, 'good.png')
writeFileSync(goodPng, PNG_1PX)
const withImages = fakeSubagents(['[1]', '[1]'])
const wi = fakeCtx({ effect: true, subagents: withImages, attachments: fakeAttachments() })
apply(wi.ctx)
const wiResult = await wi.tools.find((t) => t.name === 'delegate_batch').execute(
  {
    tasks: [
      { description: 'reads an image', prompt: 'what is this?', images: [goodPng], verify },
      { description: 'bad path', prompt: 'x', images: [join(imgDir2, 'missing.png')], verify },
      { description: 'after the bad one', prompt: 'p', verify },
    ],
  },
  { agent: { id: 'parent' }, signal: undefined },
)
ok('a task with images sends an attachment-backed image block to the provider',
  withImages.requests[0].req.prompt.length === 2 && withImages.requests[0].req.prompt[1].type === 'image'
  && !!withImages.requests[0].req.prompt[1].attachment,
  JSON.stringify(withImages.requests[0].req.prompt.map((b) => b.type)))
ok('a bad image path is a per-task FAIL naming the file',
  wiResult.results[1].ok === false && /cannot read/.test(wiResult.results[1].detail)
  && /missing\.png/.test(wiResult.results[1].detail),
  JSON.stringify(wiResult.results[1]))
ok('a bad image path is NOT retried (it would reproduce exactly)',
  wiResult.results[1].attempts === 1, JSON.stringify(wiResult.results[1]))
ok('a bad image path does not abort the task after it',
  wiResult.results.length === 3 && wiResult.results[2].ok === true,
  JSON.stringify(wiResult.results.map((r) => r.ok)))
rmSync(imgDir2, { recursive: true, force: true })

console.log('\n# the verified payload survives the verdict')

// A PASS whose answer is longer than the echo used to be UNREADABLE: the caller had to redo the work
// on DeepSeek, so the delegation saved nothing. The child has no tools (delegate_batch strips them),
// so it cannot write the file itself — the plugin writes it, verbatim.
const longAnswer = JSON.stringify(Array.from({ length: 12 }, (_, i) => `row ${i + 1} ${'x'.repeat(40)}`))
const longSubs = fakeSubagents([longAnswer])
const lg = fakeCtx({ effect: true, subagents: longSubs })
apply(lg.ctx)
const longTool = lg.tools.find((t) => t.name === 'delegate_batch')
const longResult = await longTool.execute(
  { tasks: [{ description: 'a long payload', prompt: 'p', verify: { kind: 'count', expected: '12' } }] },
  { agent: { id: 'parent' }, signal: undefined },
)
const longRow = longResult.results[0]
ok('a PASS longer than the echo is written to a file, with its size',
  longRow.ok === true && typeof longRow.outputFile === 'string'
  && longRow.bytes === Buffer.byteLength(longAnswer, 'utf8') && longRow.chars === longAnswer.length,
  JSON.stringify({ ok: longRow.ok, chars: longRow.chars, bytes: longRow.bytes, file: longRow.outputFile }))
ok('the file holds the answer byte for byte (the echo is truncated)',
  typeof longRow.outputFile === 'string' && readFileSync(longRow.outputFile, 'utf8') === longAnswer)
ok('the raw echo stays verbatim instead of being whitespace-collapsed',
  String(longRow.output).includes('","'), JSON.stringify(String(longRow.output).slice(-40)))
ok('the render names the file so the caller can read the whole answer',
  /full: .*\.txt \(\d+ bytes, sha256 [0-9a-f]{16}\)/.test(longTool.output.render({}, longResult)[0].text),
  longTool.output.render({}, longResult)[0].text.split('\n').pop())
ok('a short answer is not written to disk (nothing left behind)',
  typeof happyResult.results[0].outputFile === 'undefined')
if (typeof longRow.outputFile === 'string') rmSync(dirname(longRow.outputFile), { recursive: true, force: true })

console.log('\n# a run that did not finish is not an answer')

// The verifier PASSES on this text, which is exactly why the stop reason must outrank it: a
// truncated answer is not a smaller answer but a different one, and `covers`, `count` and `schema`
// can all be satisfied by half of it.
const truncated = fakeSubagents(['[1]'], 'max-tokens')
const tr = fakeCtx({ effect: true, subagents: truncated })
apply(tr.ctx)
const trResult = await tr.tools.find((t) => t.name === 'delegate_batch').execute(
  { tasks: [{ description: 'truncated', prompt: 'p', verify }] },
  { agent: { id: 'parent' }, signal: undefined },
)
ok('a truncated child FAILS even though its partial answer satisfies the verifier',
  trResult.results[0].ok === false && /did not finish/.test(trResult.results[0].detail)
  && trResult.results[0].stop === 'max-tokens',
  JSON.stringify(trResult.results[0]).slice(0, 180))
ok('a ceiling hit is NOT retried (it reproduces exactly) and names the knob',
  trResult.results[0].attempts === 1 && /DSH_LOCAL_MAX_TOKENS/.test(trResult.results[0].detail))

const errored = fakeSubagents(['[1]'], 'error', 'engine refused the request')
const er = fakeCtx({ effect: true, subagents: errored })
apply(er.ctx)
const erResult = await er.tools.find((t) => t.name === 'delegate_batch').execute(
  // Explicit `retries: 1`: the DEFAULT is 0, and this case is about the transient-fault PATH.
  { retries: 1, tasks: [{ description: 'errored', prompt: 'p', verify }] },
  { agent: { id: 'parent' }, signal: undefined },
)
ok('a child that errored is a FAIL and IS retried (that fault may be transient)',
  erResult.results[0].ok === false && erResult.results[0].attempts === 2 && erResult.results[0].stop === 'error',
  JSON.stringify(erResult.results[0]).slice(0, 180))
ok("the provider's own diagnostic rides along, so the FAIL is actionable",
  /engine refused the request/.test(erResult.results[0].detail)
  && erResult.results[0].diagnostic === 'engine refused the request',
  erResult.results[0].detail.slice(0, 140))

ok('a finished task reports how long the local model took and how it ended',
  happyResult.results[0].stop === 'completed' && Number.isFinite(happyResult.results[0].ms),
  JSON.stringify({ stop: happyResult.results[0].stop, ms: happyResult.results[0].ms }))
const flakyRender = happyTool.output.render({}, flakyResult)[0].text
ok('the batch footer reports the local compute and whether a retry RECOVERED anything',
  /2\/2 PASS/.test(flakyRender) && /local compute/.test(flakyRender) && /1 retried, 1 recovered/.test(flakyRender),
  flakyRender.split('\n').pop())

// `prove: true` must work for the omission-checking kinds: they are the ones whose positive is prose,
// and before the derived positives they reported "no positive example" and could not be proven at all.
const covSubs = fakeSubagents(['alpha beta'])
const cv = fakeCtx({ effect: true, subagents: covSubs })
apply(cv.ctx)
const covResult = await cv.tools.find((t) => t.name === 'delegate_batch').execute(
  {
    tasks: [{
      description: 'summary',
      prompt: 'p',
      verify: { kind: 'covers', expected: '["alpha","beta"]' },
      prove: true,
    }],
  },
  { agent: { id: 'parent' }, signal: undefined },
)
ok('prove: true covers the kinds that need no expected answer (they used to report "no positive example")',
  covResult.results[0].ok === true && covSubs.requests.length === 1,
  `${JSON.stringify(covResult.results[0])} | local calls=${covSubs.requests.length}`)

console.log('\n# verifier kinds that need no expected answer')

// covers — the answer is judged on what it FAILS to mention, so the needles may be machine-derived.
verdict('covers: every needle present passes', 'covers', '["alpha","beta"]', '["alpha","beta"]', true)
verdict('covers: a missing needle FAILS', 'covers', '["alpha"]', '["alpha","beta"]', false)
verdict('covers: a needle in the surrounding prose still counts without a field', 'covers', 'the alpha value', '["alpha"]', true)
verdict('covers: with a field, prose elsewhere does NOT satisfy it', 'covers', '[{"text":"nothing here"}]', '["alpha"]', false, 'text')
verdict('covers: with a field, the field does satisfy it', 'covers', '[{"text":"the alpha value"}]', '["alpha"]', true, 'text')

// wholeWord, on the kind where the false PASS was measured: `read` must not be satisfied by `reader`.
verdict('covers: wholeWord rejects a needle glued to another word (read vs reader)',
  'covers', '[{"text":"the reader is here"}]', '{"needles":["read"],"wholeWord":true}', false, 'text')
verdict('covers: wholeWord accepts the word itself',
  'covers', '[{"text":"please read this"}]', '{"needles":["read"],"wholeWord":true}', true, 'text')
verdict('covers: without wholeWord the substring still counts (unchanged behaviour)',
  'covers', '[{"text":"the reader is here"}]', '["read"]', true, 'text')
verdict('covers: wholeWord works for a multi-word needle',
  'covers', '[{"text":"alpha beta gamma"}]', '{"needles":["alpha beta"],"wholeWord":true}', true, 'text')

// subset_of — the anti-hallucination check the measured function-index gate lacked.
verdict('subset_of: inside the allowed set passes', 'subset_of', '["a","b"]', '["a","b","c"]', true)
verdict('subset_of: an invented element FAILS', 'subset_of', '["a","zz"]', '["a","b","c"]', false)
verdict('subset_of: a missing element is NOT an error', 'subset_of', '["a"]', '["a","b","c"]', true)

// union_eq — a partition is checkable from the universe alone, so no human supplies the buckets.
verdict('union_eq: a partition covering the universe passes', 'union_eq', '{"x":["a"],"y":["b","c"]}', '["a","b","c"]', true)
verdict('union_eq: a dropped item FAILS', 'union_eq', '{"x":["a"],"y":["b"]}', '["a","b","c"]', false)
verdict('union_eq: an invented item FAILS', 'union_eq', '{"x":["a"],"y":["b","c","zz"]}', '["a","b","c"]', false)
verdict('union_eq: an item filed twice FAILS', 'union_eq', '{"x":["a","b"],"y":["b","c"]}', '["a","b","c"]', false)

// python_check — any invariant the caller can write, which is what removes "know the answer first".
verdict('python_check: a holding invariant passes', 'python_check', '{"n":3}', 'assert answer["n"] == 3', true)
verdict('python_check: a failing invariant FAILS', 'python_check', '{"n":4}', 'assert answer["n"] == 3', false)
verdict('python_check: a non-JSON answer arrives as text', 'python_check', 'hello world', 'assert "world" in answer', true)

// citation — the claim is never judged, only its evidence.
const citeDir = mkdtempSync(join(tmpdir(), 'local-delegate-cite-'))
writeFileSync(join(citeDir, 'a.txt'), 'line one carries a sufficiently long sentence\nline two carries another sufficiently long sentence\n', 'utf8')
const citeCfg = JSON.stringify({ root: citeDir, files: ['a.txt'], minQuote: 12, minClaims: 1, require: ['a.txt'] })
const cite = (line, quote) => JSON.stringify([{ claim: 'x', evidence: { file: 'a.txt', line, quote } }])
verdict('citation: a real quotation passes', 'citation', cite(1, 'sufficiently long sentence'), citeCfg, true)
verdict('citation: a fabricated quotation FAILS', 'citation', cite(1, 'this text appears nowhere'), citeCfg, false)
verdict('citation: the right quote on the WRONG line FAILS', 'citation', cite(9, 'sufficiently long sentence'), citeCfg, false)
verdict('citation: an unreadable file FAILS', 'citation',
  JSON.stringify([{ claim: 'x', evidence: { file: 'missing.txt', line: 1, quote: 'sufficiently long sentence' } }]), citeCfg, false)
verdict('citation: the same evidence reused for two claims FAILS', 'citation',
  JSON.stringify([
    { claim: 'a', evidence: { file: 'a.txt', line: 1, quote: 'sufficiently long sentence' } },
    { claim: 'b', evidence: { file: 'a.txt', line: 1, quote: 'sufficiently long sentence' } },
  ]), citeCfg, false)

// A quotation that spans lines: the subject of a review is a statement, and a statement is rarely
// one line. Before `span`, every multi-line citation was reported as fabricated.
const multiQuote = 'sufficiently long sentence line two carries'
verdict('citation: a quotation that spans two lines passes (it used to be called fake)',
  'citation', cite(1, multiQuote), citeCfg, true)
verdict('citation: span:1 restores the strict single-line rule',
  'citation', cite(1, multiQuote),
  JSON.stringify({ root: citeDir, files: ['a.txt'], minQuote: 12, minClaims: 1, require: ['a.txt'], span: 1 }), false)
verdict('citation: a multi-line quotation with an invented word still FAILS',
  'citation', cite(1, 'sufficiently long sentence line two carries purple elephant'), citeCfg, false)

// A citation gate judges EVIDENCE, not structure — yet a citation positive is JSON, so the generic
// operators DID fire on it (perturbNumber moved a line number, dropField removed a field) and the proof
// reported `accepts 2/6 wrong answers` against a gate that was perfectly fine. These four kinds are now
// excluded from structural mutation, so the honest report is "cannot certify", never fake leakage.
// This MUST run BEFORE citeDir is removed: the gate reads the file, so a deleted root simply looks like a
// rejected positive, and the assertion would pass for the wrong reason.
const citationProof = proveGate({ kind: 'citation', expected: citeCfg, positive: cite(1, 'sufficiently long sentence') })
ok('a citation gate is never structurally mutated (a JSON positive is not a structural answer)',
  citationProof.total === 0 && citationProof.proven === false && citationProof.positiveOk === true,
  JSON.stringify({ total: citationProof.total, positiveOk: citationProof.positiveOk, kind: citationProof.kind }))

rmSync(citeDir, { recursive: true, force: true })

console.log('\n# gate self-proof (mutation)')

const PROOF_POS = [{ file: 'a.ts', functions: [{ name: 'alpha', kind: 'function', line: 3, exported: true }] }]
const PROOF_SHAPE = { semantics: { closedShape: true } }

const proofMutants = mutateAnswer(PROOF_POS, PROOF_SHAPE)
ok('the mutator derives several distinct wrong answers',
  proofMutants.length >= 6 && new Set(proofMutants.map((m) => m.id)).size === proofMutants.length,
  proofMutants.map((m) => m.id).join(', '))
ok('no mutant equals the good answer',
  proofMutants.every((m) => JSON.stringify(m.payload) !== JSON.stringify(PROOF_POS)))

const vacuous = proveGate({ kind: 'json_equals', positive: '', expected: '""', config: {} })
ok('nothing to mutate is NOT a proof (a vacuous pass is a failure)',
  vacuous.proven === false && vacuous.total === 0, JSON.stringify(vacuous))

const decorative = proveGate({ kind: 'schema', positive: PROOF_POS, expected: '{"type":"array"}', config: PROOF_SHAPE })
ok('a gate that accepts anything has no power',
  decorative.proven === false && decorative.leaked.length > 0,
  JSON.stringify({ total: decorative.total, leaked: decorative.leaked.map((l) => l.id) }))

const exactGate = proveGate({ kind: 'json_equals', positive: PROOF_POS, expected: JSON.stringify(PROOF_POS), config: PROOF_SHAPE })
ok('json_equals rejects every mutant of its own expected',
  exactGate.proven === true && exactGate.discrimination === 1, JSON.stringify(exactGate.leaked))

// The integration that matters: a powerless gate must be refused WITHOUT calling the local model.
const proofSubs = fakeSubagents(['["a"]'])
const proofCtx = fakeCtx({ effect: true, subagents: proofSubs })
apply(proofCtx.ctx)
const refusedProof = await proofCtx.tools.find((t) => t.name === 'delegate_batch').execute(
  {
    tasks: [{
      description: 'decorative gate',
      prompt: 'p',
      verify: { kind: 'schema', expected: '{"type":"array"}' },
      prove: { positive: PROOF_POS, semantics: PROOF_SHAPE.semantics },
    }],
  },
  { agent: { id: 'parent' }, signal: undefined },
)
ok('a powerless gate is refused before the local model is called',
  refusedProof.results[0].ok === false && /no power/.test(refusedProof.results[0].detail) && proofSubs.requests.length === 0,
  `${refusedProof.results[0].detail} | local calls=${proofSubs.requests.length}`)

// …and a gate that survives its proof still runs the task normally.
const strongSubs = fakeSubagents(['["a"]'])
const strongCtx = fakeCtx({ effect: true, subagents: strongSubs })
apply(strongCtx.ctx)
const allowed = await strongCtx.tools.find((t) => t.name === 'delegate_batch').execute(
  {
    tasks: [{
      description: 'sound gate',
      prompt: 'p',
      verify: { kind: 'json_equals', expected: '["a"]' },
      prove: true,
    }],
  },
  { agent: { id: 'parent' }, signal: undefined },
)
ok('a gate that survives its proof still runs the task',
  allowed.results[0].ok === true && strongSubs.requests.length === 1,
  `${JSON.stringify(allowed.results[0])} | local calls=${strongSubs.requests.length}`)

// The OTHER half of the proof, which was missing: rejecting every mutant is worthless if the gate
// also rejects the RIGHT answer — it scores discrimination 1.0 and escalates every delegation, i.e.
// it costs more than no gate at all. Both of these reported proven:true before the check existed.
const rejectsGood = proveGate({ kind: 'json_equals', positive: PROOF_POS, expected: '{"nope":1}', config: PROOF_SHAPE })
ok('a gate that rejects the right answer is NOT proven (rejecting mutants is only half a proof)',
  rejectsGood.proven === false && rejectsGood.positiveOk === false && rejectsGood.leaked.length === 0,
  JSON.stringify({ ...rejectsGood, leaked: rejectsGood.leaked.map((l) => l.id) }))
const alwaysRaises = proveGate({ kind: 'python_check', positive: PROOF_POS, expected: 'raise SystemExit(1)', config: PROOF_SHAPE })
ok('a python_check whose source always raises is not proven either',
  alwaysRaises.proven === false && alwaysRaises.positiveOk === false, JSON.stringify(alwaysRaises))

console.log('\n# prove without being handed the answer (derived positives)')

const coversNeedles = needlesFrom('covers', '["alpha","beta"]')
const derivedCovers = positiveFromVerify({ kind: 'covers', expected: '["alpha","beta"]' })
ok('covers reads its own needles and derives a positive from them',
  JSON.stringify(coversNeedles) === '["alpha","beta"]' && derivedCovers === 'alpha\nbeta',
  `${JSON.stringify(coversNeedles)} -> ${JSON.stringify(derivedCovers)}`)
const coversProof = proveGate({ kind: 'covers', expected: '["alpha","beta"]', positive: derivedCovers })
ok('a covers gate is provable with no positive from the caller',
  coversProof.proven === true && coversProof.total >= 1,
  JSON.stringify({ total: coversProof.total, leaked: coversProof.leaked.map((l) => l.id), positiveOk: coversProof.positiveOk }))
const omitted = mutateAnswer(derivedCovers, { needles: coversNeedles })
ok('the omit-a-needle mutant is what gives a text gate its power',
  omitted.some((m) => m.id === 'omitNeedle')
  && check('covers', String(omitted.find((m) => m.id === 'omitNeedle').payload), '["alpha","beta"]').ok === false,
  JSON.stringify(omitted.map((m) => m.id)))
const allOfProof = proveGate({
  kind: 'all_of',
  expected: '["alpha","beta"]',
  positive: positiveFromVerify({ kind: 'all_of', expected: '["alpha","beta"]' }),
})
ok('all_of is provable the same way', allOfProof.proven === true, JSON.stringify(allOfProof))

// The object form must not silently lose the strictness: a wholeWord gate whose needles were read
// without the flag would be the lenient gate again, wearing the strict one's name.
const wwPositive = positiveFromVerify({ kind: 'covers', expected: '{"needles":["alpha","beta"],"wholeWord":true}' })
ok('prove reads the needles out of the object form too',
  wwPositive === 'alpha\nbeta', JSON.stringify(wwPositive))
const wwProof = proveGate({ kind: 'covers', expected: '{"needles":["alpha","beta"],"wholeWord":true}', positive: wwPositive })
ok('a wholeWord covers gate is provable, and the omit-a-needle mutant still breaks it',
  wwProof.proven === true && wwProof.total >= 1, JSON.stringify(wwProof))

for (const v of [
  { kind: 'count', expected: '2' },
  { kind: 'union_eq', expected: '["a","b"]' },
  { kind: 'json_order', expected: '["b","a"]', field: 'name' },
]) {
  const positive = positiveFromVerify(v)
  const proof = proveGate({ ...v, positive })
  ok(`prove derives a positive for ${v.kind} and the gate survives its own proof`,
    proof.positiveOk === true && proof.total >= 1 && proof.proven === true,
    JSON.stringify({ positive, total: proof.total, leaked: proof.leaked.map((l) => l.id), positiveOk: proof.positiveOk }))
}
// A `semantics` flag is the caller's honest judgement about whether a mutant is really wrong, and two
// of them are false alarms for specific kinds — a gate is condemned for a defect it cannot see.
const orderPositive = positiveFromVerify({ kind: 'json_order', expected: '["b","a"]', field: 'name' })
const orderClosed = proveGate({
  kind: 'json_order', expected: '["b","a"]', field: 'name', positive: orderPositive,
  config: { semantics: { closedShape: true } },
})
ok('closedShape is a FALSE ALARM for json_order (an extra field is invisible to a field-order gate)',
  orderClosed.proven === false && orderClosed.leaked.some((l) => l.id === 'addField'),
  JSON.stringify(orderClosed.leaked.map((l) => l.id)))

// A schema with no instance: matchesSchema is right to reject the derived instance, and the proof must
// report that instead of blessing the gate — this is the case that would have been silent otherwise.
const unsatSchema = '{"type":"object","required":["a"],"additionalProperties":false}'
const unsatProof = proveGate({
  kind: 'schema', expected: unsatSchema, positive: positiveFromVerify({ kind: 'schema', expected: unsatSchema }),
})
ok('a schema with no instance is reported, not blessed',
  unsatProof.proven === false && unsatProof.positiveOk === false, JSON.stringify(unsatProof))
const satisfiedSchema = '{"type":"object","properties":{"a":{"type":"string"}},"required":["a"],"additionalProperties":false}'
const satProof = proveGate({
  kind: 'schema', expected: satisfiedSchema, positive: positiveFromVerify({ kind: 'schema', expected: satisfiedSchema }),
  config: { semantics: { closedShape: true } },
})
ok('a satisfiable closed schema is provable, and the derived positive passes it',
  satProof.proven === true && satProof.positiveOk === true,
  JSON.stringify({ positive: positiveFromVerify({ kind: 'schema', expected: satisfiedSchema }), total: satProof.total }))
const subsetPositive = positiveFromVerify({ kind: 'subset_of', expected: '["a","b"]' })
ok('subset_of derives its positive (the whole allowed set is inside itself)',
  JSON.stringify(subsetPositive) === '["a","b"]'
  && check('subset_of', JSON.stringify(subsetPositive), '["a","b"]').ok === true)
ok('the kinds that cannot be derived say so instead of guessing',
  ['python_exec', 'python_check', 'regex', 'citation'].every((k) => positiveFromVerify({ kind: k, expected: 'x' }) === undefined))

// The tool-using path (subagent + verify_task) must be able to prove its gate too: previously only
// delegate_batch could, so an inherited-tools child's answer was gated by an unproven verifier.
const verifyTool = wired.tools.find((t) => t.name === 'verify_task')
const provedAdHoc = await verifyTool.execute({ kind: 'count', expected: '2', content: '[1,2]', prove: true })
ok('verify_task proves a gate before using it', provedAdHoc.ok === true, JSON.stringify(provedAdHoc))
const refusedAdHoc = await verifyTool.execute({
  kind: 'json_equals', expected: '{"a":99}', content: '{"a":99}', prove: { positive: '{"a":1}' },
})
ok('verify_task refuses a gate that rejects the known-good answer it was handed',
  refusedAdHoc.ok === false && /no power/.test(refusedAdHoc.detail) && /does not accept/.test(refusedAdHoc.detail),
  JSON.stringify(refusedAdHoc))

// The rejected-positive check must OUTRANK "no structural operator". An unstructured kind always reports
// total === 0, so ordering them the other way would report a BROKEN gate as the innocuous "cannot certify"
// — and the caller would ship a gate that fails every delegation. Pinned with the broken one, not the good one.
const brokenUnstructured = await verifyTool.execute({
  kind: 'python_exec', content: 'x = 1', asserts: ['1 == 2'], prove: { positive: 'x = 1' },
})
ok('an unstructured kind that rejects its positive is still reported as rejecting it',
  brokenUnstructured.ok === false && /does not accept/.test(brokenUnstructured.detail),
  JSON.stringify(brokenUnstructured))

console.log('\n# engine preflight')

const down = await probeEngine('127.0.0.1', 1)
ok('a closed port reads as down', down === false)

console.log(`\n${passed} passed, ${failed} failed${skipped ? `, ${skipped} skipped` : ''}`)
process.exit(failed === 0 ? 0 : 1)
