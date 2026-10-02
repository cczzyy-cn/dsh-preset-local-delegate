# dsh-preset-local-delegate — the `local-delegate` agent preset

A **DSH agent preset**: it composes one agent's system prompt and tool surface. It is not a
standalone application and provides no service of its own.

It is the harness's shipped **`standard` preset, verbatim** — same persona, same shell, same
filesystem, jobs, skills, goals, plan mode, compaction and delegation rows — plus **one added
capability**:

> A subtask whose answer a machine can check is delegated to a **local** tool model as a
> subagent (0 API tokens), and the answer is gated behind a **deterministic verifier** before it
> is used. When the gate fails, the work escalates to DeepSeek. **The same path reads images**,
> because the local engine is multimodal.

```
task
 ├─ can I write a deterministic checker for the answer?
 │    ├─ no  → keep it on DeepSeek (do NOT delegate)
 │    └─ yes → delegate_batch → local engine (0 API tokens)
 │                 ├─ text  → the prompt, inlined
 │                 └─ image → `images: [path]`, attached and verified the same way
 │                 └─ verifier PASS → accept
 │                    verifier FAIL → escalate to DeepSeek (never retry the local model twice)
 └─ multi-step reasoning, cross-file causality, and every word the user reads stay on DeepSeek
```

The entry condition is **"can I write the checker"**, not "does this look easy". That is not a
style preference: a wrong local answer that is *rejected by a verifier* costs the local compute
**and** the DeepSeek round trip that follows it — strictly more than never delegating at all.
Pass rate is therefore the only number that matters. It applies to a picture exactly as it does
to text: a vision answer with no checker is not delegable either.

## What it adds

| Added row | What it registers |
|---|---|
| `local-delegate.mjs` | `verify_task`, `delegate_batch` (text and images), and the routing guidance section |

Nothing else. `python tools/build-local-delegate-preset.py --check` fails if
`cordis.patch.yml` ever drifts from that claim. Adding images did not touch the plugin list: the
capability lives inside the same module, so the "one added row" claim still holds.

### `verify_task` — the gate

Sixteen verifier kinds, all deterministic and all free:

| kind | checks |
|---|---|
| `json_equals` | deep equality against `expected` |
| `json_order` | array of objects ordered by `field` |
| `set_eq` | set equality (order and duplicates irrelevant) |
| `count` | array length |
| `schema` | JSON Schema subset: type / enum / required / properties / items / `additionalProperties` / `minLength`·`maxLength` / `pattern` / `minimum`·`maximum` |
| `exact` | trimmed string equality |
| `regex` | pattern match |
| `contains` | substring, exact |
| `all_of` | every needle in `expected` (array, or `"a\|b"`) appears in the answer, case- and punctuation-insensitive; the object form `{needles, wholeWord}` is available |
| `compile` | the answer parses as JavaScript |
| `python_exec` | extracts a `def` block, runs it with your `assert` expressions |
| `covers` | every needle in `expected` appears in the answer (optionally only in `field`) — judged on what the answer OMITS, so the needles may be machine-derived |
| `subset_of` | every element of the answer is inside `expected`; an invented element FAILS, a missing one does not |
| `union_eq` | the union of the answer's groups equals `expected` exactly — a partition is validated from the universe alone |
| `citation` | every claim carries `{file,line,quote}` and the quote must really occur at that line (±`tolerance`, spanning up to `span` lines); the claim itself is never judged |
| `python_check` | an arbitrary Python invariant, with the answer bound to `answer` |

The table above is generated from a single source in the module (`VERIFIER_KINDS`): the `verify_task`
description, the `kind` enum in both tool schemas, and the self-test all read it. That is not
tidiness. The description and the implementation **had** drifted — `checkInner` implemented sixteen
kinds while the `verify_task` description still named eleven, so the five kinds that need no expected
answer were invisible in the tool contract the model chooses from. A capability the caller cannot see
is a capability that is not there. The self-test now compares the `case` labels in `checkInner`
against the table and fails if either side gains or loses a kind.

The last five are the ones that need **no answer from the caller**, which is the point: the older
kinds all compare against an `expected` the caller had to compute first, so a task was only
delegatable if the answer was already known — which is most of the reason it was not worth
delegating. `union_eq` validates a classification from the universe alone, `covers` validates a
summary against machine-extracted symbol names, and `citation` turns "is this review correct?"
into "is this quotation real?", which is decidable.

`all_of` is the **reading-shaped** verifier. A vision or transcript answer is prose — "The digit
**3** is inside the **circle**" — so a caller must be able to assert *these facts must all appear*
without knowing the phrasing, and must still FAIL for something that is not in the image at all.
`contains` stays strictly literal on purpose: the two are different questions, and a caller who
asked the strict one should not be silently given the lenient one.

### Two knobs that decide whether a gate is false or merely strict

Both were added because the measurement said the gate was wrong, not because they were convenient.

**`wholeWord`** (for `all_of` and `covers`, via the object form `expected:
{"needles": ["read", …], "wholeWord": true}`): an occurrence glued to another word does not count.
Without it, `covers` for the needle `read` **passed** the answer "the reader is here" — the exact
false PASS this design exists to prevent. It stays opt-in, so every existing caller keeps the
lenient behaviour it asked for. Word characters are ASCII (letters, digits, underscore): CJK text has
no word boundaries, so a Chinese needle still matches inside a longer run — stated rather than
pretended, because a boundary rule that silently does nothing on half the alphabet is worse than
none. One trap is pinned by a test: boundary matching runs on a **space-preserving** normalization,
not on `squash`, or "the reader" becomes "thereader" and the legitimate needle `reader` fails its own
boundary test.

**`span`** (for `citation`, default 3): the quotation may cover up to `span` consecutive lines
starting at the cited line (±`tolerance`). The subject of a code review is a statement, and a
statement is rarely one line; with single-line matching the flagship use case was unusable —
measured, a two-line quotation from a two-line file was reported as `the evidence is fake`. The
window starts where the claim says it does, so citing the wrong line still fails, and `span: 1`
restores the strict rule.

Three contract decisions are worth stating because they were paid for:

- **The gate never throws.** A verifier exception used to escape `delegate_batch`, so one
  malformed task aborted the whole batch and tasks 2..N never ran. Every kind now guards its own
  input type and the switch is wrapped: a bad payload is a `FAIL` with a readable reason.
- **A run that did not finish is not an answer.** The harness result carries `stopReason`
  (`completed | max-tokens | aborted | error | refusal`), and this module used to read only
  `output` — so a child that hit its token ceiling or was aborted could return a partial answer that
  **satisfies the gate**: a summary covering half the symbols still "covers" them, a truncated JSON
  array is still an array, `count` on a shortened list is just a smaller number. The stop reason is
  now checked *before* the verdict and outranks it — only a finished run may pass. `max-tokens` is
  not retried (it reproduces exactly) and the message names `DSH_LOCAL_MAX_TOKENS`; an abort or a
  transport error stays retryable, but `retries` defaults to **0**, so the caller has to ask for that
  retry explicitly. The result's own `diagnostic` is
  carried into the FAIL when the provider supplies one. **Measured end to end from a session that
  loaded this revision**: a 600-string array whose `covers` gate looked only at the first two
  strings — chosen so the *truncated* answer satisfies the gate on its own — was still reported
  `FAIL ❌ — the child did not finish: stop=max-tokens … (42460 ms, stop=max-tokens)` with the footer
  `— 0/1 PASS · 42.5 s of local compute`. The 13,208-byte partial answer written to `outputFile`
  really does contain both needles, so the gate by itself would have accepted it: only the stop
  reason refused. A FAIL writes the full answer too, which is what makes that checkable after the
  fact. **Re-measured on the restarted app** (2026-10-02) with a different truncation size: the same
  probe came back `FAIL ❌ — the child did not finish: stop=max-tokens — a partial answer is never
  accepted, not even when it satisfies the verifier; split the task, or raise
  DSH_LOCAL_MAX_TOKENS (now 4096) (39039 ms, stop=max-tokens)`, footer `— 0/1 PASS · 39.0 s of local
  compute`, `attempts=1`; the partial 12,712-byte answer holds 210 of the 600 strings and **both**
  needles, verified by reading the file back. **Third run** (2026-10-02, a later app start whose
  module identity was probed as new first): `FAIL ❌ — the child did not finish: stop=max-tokens …
  (54027 ms, stop=max-tokens)`, footer `— 0/1 PASS · 54.0 s of local compute`, `outputFile` 13,208
  bytes with **234** of 600 strings and both needles present (counted, not eyeballed) — again only
  the stop reason refused an answer the gate would have taken.
- **`python_exec` extracts by line scan, not by lookahead.** The obvious
  `/def\s+\w+\s*\([\s\S]*?(?=\n(?!\s)|\Z)/` is broken in JavaScript — there is no `\Z`, and an
  unknown escape is an *identity* escape, so it matches a literal `Z`. For a definition whose
  indented body runs to the end of the answer the lookahead can never fire, and the verifier
  reported `no def block` for perfectly good code. Found here by adding a positive
  `python_exec` case; the earlier implementation shipped the bug.

### `prove` — prove the gate before spending the delegation

"Asking the verifier to accept the right answer" is the weak half of a proof: a gate that accepts
everything answers it perfectly. Pass `prove: true` (or a config object) on a task — or on
`verify_task` itself, which proves a gate for the tool-using (`subagent`) path — and the plugin
derives known-bad answers from a known-good one and requires the verifier to reject every one, **and
requires it to accept the known-good answer**. Both halves are needed, and the second one was
missing: a gate that rejects everything scores `discrimination 1.0` and fails every delegation, so it
costs more than no gate at all. Measured before the check existed — `json_equals` against a
deliberately wrong `expected`, and a `python_check` whose source always raised, both reported
`proven: true`:

| mutant | what it breaks |
|---|---|
| `empty`, `truncate`, `dropItem`, `duplicateItem` | completeness (something missing, or counted twice) |
| `addLookalike` | an entry invented from a name that really occurs in the source — the hardest kind to catch |
| `perturbNumber`, `shiftFar` | a number changed, or a position moved where it does not belong |
| `invertBoolean`, `relabelEnum` | a value or a label that is legal but wrong |
| `perturbString`, `invent` | a name altered by one character, or fabricated outright |
| `omitNeedle` | something that had to be mentioned was left out — the mutant `covers`/`all_of` need, with the needles taken from the verifier's own `expected` |
| `dropField`, `addField` | the shape contract broken |
| `wrapFence` | the JSON wrapped in a code fence (the local model's most common politeness) |

A gate that accepts any mutant is **reported instead of being used**, so a decorative verifier
costs nothing — not even the local call. The positive example comes from `prove.positive`, or is
**derived from `expected`** for every kind where that is possible (twelve of the sixteen, against
three before): `expected` *is* the answer for `json_equals`/`set_eq`/`exact`; it is a constraint the
answer must satisfy for `count`/`schema`/`union_eq`/`subset_of`; it is what the answer must mention
for `covers`/`all_of`; and for `json_order` the answer is the sequence of objects that produces the
given order. `python_exec`, `python_check`, `regex` and `citation` carry a program or an evidence
report and still need `prove.positive` from the caller. When a **derived** positive fails, the report
says so and names both possible causes — an unsatisfiable constraint (a schema with no instance, a
pattern `x` cannot satisfy) or a gate that rejects the right answer — because the caller cannot tell
them apart otherwise.

`semantics` switches (`hasIdentityField`, `hasEnums`, `closedVocabulary`, `closedShape`,
`textAnswer`) exist because a mutant that is still correct is a false alarm, and a false alarm
condemns a gate that is actually fine. Leaving one off is the caller's honest judgement that the
mutant would not really be wrong. Two of them are false alarms for specific kinds, both measured and
pinned by a test: `closedShape` for `json_order` (an extra field is invisible to a field-order gate)
and `duplicateItem` for `set_eq` (a set cannot see a duplicate). **Zero mutants is not a pass** — it
means nothing was proven.

Measured on this preset's own verifiers: `schema: {"type":"array"}` accepts every mutant (no
discriminating power), while `json_equals` against its own `expected` rejects all of them.

### `delegate_batch` — the delegation

`{tasks: [{description, prompt, verify?}], retries?}` → per task `{id, ok, detail, output,
attempts}`.

- Runs **sequentially** on one local engine (it serialises requests anyway).
- Ids are **numbered** — two delegations of the same file used to be indistinguishable.
- **A FAIL is reported, not re-bought: `retries` defaults to 0.** It retries only a *real
  verification failure* — never a pass, never a task with no verifier — and only when the caller asks
  (`retries: 1..3`). The batch footer still reports `N retried, M recovered`. This was 1 until it was
  measured, and the measurement killed *both* of the old justifications:
  - The reason given for a retry was "under greedy decoding it is probably the same purchase twice".
    **False**: one identical prompt sent three times generated different answers every time
    (86/50/44, 321/46/57, 49/48/54 tokens), so this engine is **not byte-deterministic even
    back-to-back** and a retry *is* a genuinely different sample.
  - The reason to keep it anyway would be "then a resend can rescue a borderline task".
    **Not observed once**: across the 7 same-shape reversal probes (every attempt a *finished*,
    cleanly-wrong answer, so these are valid observations rather than aborts) and 3 clean arithmetic
    failures, `recovered` was **0 in 10/10**.
  Three further facts made 0 the right default rather than merely an allowed one: a blind resend is
  exactly what this file tells the caller *not* to do (change the question, or split the input — the
  plugin cannot do either); the preset's contract is **FAIL escalates to DeepSeek**, so silently
  re-buying locally before escalating is backwards; and with the child's un-strippable tool list a
  retry can now **loop and cost a whole `DSH_DELEGATE_TIMEOUT_MS` budget** — seen twice, once as
  "fail in 5 s, then 120 s" and once as "fail, fail, then 120 s".
  **The honest limit of this evidence**, stated rather than buried: every observation is a task the
  model cannot do, so what is measured is "a resend never rescued a hopeless task". A task the model
  can *sometimes* do is still untested — which is why the escape hatch stays open and the schema
  spells out the new default. The verbatim-copy shape cannot settle it either way: 128 and 160
  characters PASS, while 200 characters loops for the entire budget instead of answering wrongly.
- **Every batch reports what the path cost**: per task the wall time and the stop reason, then a
  footer with `PASS/total` and the seconds of local compute. The caller who pays for a delegation is
  the one who should be able to see whether it was worth it. **The sum covers every attempt**, not
  just the last one: summing `result.ms` alone hid the retries, and a batch that really spent ~253 s
  printed `240.1 s of local compute`. Each row now carries `spentMs` (all attempts) beside `ms`
  (last attempt), and the self-test pins the difference with a deliberately slow first attempt.
- `dispose()` runs on every path, including the retry path and the failure path.
- Echoes a bounded slice of the raw answer, **verbatim** (not whitespace-collapsed), because a
  verdict line alone makes the caller pay for a model call it can never read.
- **Returns the whole answer, not just the echo.** When the answer is longer than
  `DSH_DELEGATE_OUTPUT_CHARS` (default 500), the full answer is written to `outputFile` — with
  `bytes` and a `sha256` — and the render names that path, so the caller reads the payload instead
  of redoing the work. This closes a real hole: a PASS whose payload exceeded the echo used to be
  unusable, which meant the delegation saved nothing, and the README's old advice ("a task that must
  return more should write a file") was impossible to follow because `delegate_batch` strips the
  child's tools — the child **cannot** write that file. The plugin writes it. The file is written on
  a FAIL too, since the raw answer is the evidence for why it failed, and it is never deleted.
- Preflights the engine first: a dead engine produces **one actionable error** instead of N
  identical `invalid JSON` rows.
- Accepts `images` per task. The picture is read by the caller and committed to the harness
  attachment store, so a relative path means what the caller's cwd says, and the local engine is
  never asked to resolve a path on another filesystem it cannot see.

### `images` — the local engine is multimodal

`serve/server.py` already accepts OpenAI `image_url` parts and Anthropic image blocks (base64, an
http(s) URL, or a bare local path), and the engine advertises it:

```
GET /v1/models → architecture.input_modalities = ["text", "image"]
GET /health    → {"status":"ok","model":"qwen3.8-flash-next-coder-iq1_m","images":true,"loaded":true}
```

So the capability was always there — the delegation layer just had no way to carry a picture.

**The wire shape is not the obvious one, and getting it wrong fails SILENTLY.** The obvious shape is
an OpenAI block. `@deepseek-ai/dsh-llm-pi-ai` serializes a user message by switching on `block.type`:

```js
case "image": {
  const version = requestImages.get(block.attachment.attachmentId)   // requires a durable ref
  content.push({ type: "image", data: Buffer.from(version.data).toString("base64"),
                 mimeType: version.mediaType })
  break
}
default: break          // ← any other block type is DROPPED, with no error
```

An `image_url` block therefore reaches the engine as **no image at all**, and the local model answers
about whatever else was in the prompt. This shipped in an earlier revision of this file and was only
caught by running a real delegation against the engine: the reading came back as
`Strata 2024-Q4 release notes changelog: 3.10, 2.7, 3.9, 2.11` — text from the parent session, about
a picture that never arrived. The suite's own shape check passed the whole time, because a shape
check cannot see a silent drop. The canonical block is

```js
{ type: 'image', attachment: { attachmentId, mediaType, width, height } }
```

with the bytes committed through `ctx.attachments.saveImages([...])` first. Two consequences are
built into the implementation:

- **Validate before commit.** `inspectImages` is pure and synchronous, so a bad path or an
  unsupported extension is refused *before* anything is stored. A half-stored batch would leave
  unreachable objects behind and still have to fail.
- **A readable image with no attachment service is an ERROR, not a silent text-only request.** That
  is the same failure mode as above, so it is reported as the task's `FAIL` and is **not retried** —
  it will reproduce exactly.

**The store takes encoded BYTES; base64 is only the wire form.** This is a *second* way to get images
wrong, and it is the loud one (it took longer to find than the silent one, because a green suite hid
it). Read out of the running build's `app.asar`:

```js
// @deepseek-ai/dsh-tool-cordis api-catalog: the declared store input
'export interface SaveImageAttachment { data: Uint8Array; mediaType: ImageMediaType; name?: string; }'
// validateImage(input): "encoded bytes, declared media type, and optional display name."

// @deepseek-ai/dsh-attachment-local: the store hands `data` straight to sharp
async function probeImage(data) { try { return await imageMetadata(sharp(data, { failOn: 'error' })) }
  catch (error) { … throw new AttachmentError("Unsupported or malformed image data.", "INVALID_IMAGE") } }

// @deepseek-ai/dsh-attachment: base64 belongs to the RPC WIRE shape, which the harness decodes first
function saveInput(image) { return { data: decodeBase64(image.data), mediaType: image.mediaType, … } }
```

So the durable form is a `Uint8Array` and the plugin must hand over the file's bytes. This module
used to pass `buf.toString('base64')` to `ctx.attachments.saveImages`, so **every** `images:`
delegation died in ~0 ms with `Unsupported or malformed image data.` (`INVALID_IMAGE`) *before* the
engine was called — 0.0 s of local compute, no request in the engine log. The self-test pinned that
base64 string, which is why 190 green assertions coexisted with a feature that never worked; the
assertions now require bytes and cite the declaration above (mutation-checked: reverting to base64
fails exactly those two).

### Measured cost of an image (this engine, thinking off, temperature 0)

| image | image tokens | first-visit wall | repeat of the same image |
|---|---:|---:|---:|
| 256×192 text | 78 | 0.70 s | — |
| 640×480 text | 330 | 0.77 s | 0.28 s |
| 1280×960 text | 1002 | 1.05–2.45 s | 0.28 s |
| 800×600 JPEG | 506 | 1.21–1.26 s | — |

Two properties make this cheap enough to use freely:

1. **Token cost scales with resolution**, so a screenshot is not the same purchase as a thumbnail.
2. **The engine caches the encoded image (and the whole prompt prefix)**, so re-showing the *same*
   image re-reads **7** prompt tokens instead of 1002 — measured, not inferred. A repeated read of a
   large image is ~0.3 s.

The cost that dominates is not encoding: the engine reads image tokens through the prefill path
(about 300 image tokens in ~660 ms). Cache a path if you look at the same picture repeatedly.

### What one image delegation actually costs — measured over nine runs

Measured 2026-10-02, after the app was restarted onto this revision, with the five fixtures in
`mk-test-images.py` and read out of each child's own session transcript (`tools/session-dump.mjs`):

| # | fixture (image tokens) | task prompt also said "do not call any tool" | steps | tools the child called | result | wall |
|---:|---|---|---:|---|---|---:|
| 1 | `img-plain` 640×480 (330) | no | 6 | `list_subagent_models` ×4, `subagent` ×1 (refused) | PASS | 8.2 s |
| 2 | `img-plain` | no | 2 | `list_subagent_models` ×1 | FAIL — read `MEN WALK ON MONA` | 0.9 s |
| 3 | `img-plain` | no | 2 | `list_subagent_models` ×1 | PASS | 5.3 s |
| 4 | `img-plain` | yes | 1 | none | PASS | 1.6 s |
| 5 | `img-plain` | yes | 1 | none | PASS | 1.4 s |
| 6 | `img-plain` | yes | 1 | none | PASS | 1.4 s |
| 7 | `img-small` 256×192 (78) | yes | 9 | `list_subagent_models` ×4, `subagent` ×1, `workflow` ×3 | PASS (1,061 B of meta-commentary around the right reading) | 14.5 s |
| 8 | `img-large` 1280×960 (1002) | yes | **27** | `list_subagent_models` ×4, `subagent` ×22 | **FAIL — `stop=aborted`, the 120 s budget** | 120.0 s |
| 9 | `img-photo` 800×600 JPEG (506) | yes | 1 | none | PASS | 1.8 s |

Three things this says, in order of how much they matter:

1. **The picture reaches the engine now and the gate decides correctly.** Seven of the nine runs
   passed; the two that did not were a genuine misread (`MONA`) and a budget abort, and both were
   reported as `FAIL` rather than shipped. A `prove: true` smoke test on the same revision passed too
   (1.4 s).
2. **What varies is the child's own behaviour, not the image path.** In 6 of 9 runs the child spent
   steps probing tools it cannot use. Its reachable set, read from the transcripts: `list_subagent_models`
   **works**, `subagent` **exists but is always refused** (`subagent depth 2 exceeds maxDepth 1`), and
   `workflow` is genuinely gone (`unknown tool "workflow"` — three attempts, nothing written to disk).
   The probe sequence is always the same shape: four `list_subagent_models` calls to find a route, then
   `subagent` forever. Only the module's own budget ends it, which is what the budget is for.
3. **The caller-side clause is a hint, not a fix.** `…; do not call any tool.` took three identical
   runs to 1 step / 0 calls — and then runs 7 and 8, with the same clause, took 9 and 27 steps. Do not
   read the first three as a solution. (Run 7 is the instructive one: the clause suppressed *calls*
   only partly, and the child instead narrated its own tool inventory for 1 KB before answering.)

Practical shape for a caller: keep the ask as small as it can be (the 640×480 and 800×600 JPEG reads
were the clean ones), expect the child to burn steps on its own tool inventory sometimes, and treat
the worst case as **one 120 s budget** of local compute — free in API tokens, not free in time. On
`stop=aborted`, re-ask smaller or differently; never take the partial answer.

Reading accuracy is likewise not free: across the seven runs that finished, the reads were exact
except for one (`MEN WALK ON MONA`). That is the whole argument for the gate deciding, and for
escalating a FAIL instead of trusting a plausible answer.

## Measured evidence

Everything in this section is measured, with its source. Claims that are not measured are in
*Honest boundaries* below.

### The local prompt is dominated by tool schemas

| measurement | value |
|---|---|
| prompt for a 3-line, 12-token extraction task | **12,401 tokens** |
| …of which the answer needed | ~12 tokens |
| prefill (cold cache) | 4,849 ms |
| generated | **88 tokens** |

Two things follow. First, the delegated child inherits the parent's whole composition, so its
tool schemas — not the task — are nearly the entire prompt. Second, a 12-token answer costing 88
generated tokens means **the thinking channel is on by default**.

`delegate_batch` therefore sends:

```js
{ agentOptions: { provider: 'strata', model: 'qwen3.8-flash-next-coder-iq1_m', maxTokens: 4096 },
  toolFilter: { allow: [] },          // the local model has no tool loop: schemas are pure overhead
  persona: '<a two-line tool-model persona>' }
```

- `toolFilter` / `persona` are supported by the `spawn` provider — read out of this harness's
  bundled source: `SpawnInProcessProvider.capabilities = { agentOptions: true, outputSchema: true,
  depthLimit: true, toolFilter: true, persona: true }`, and `applyChildComposition` passes both
  straight to `ctx.systemPrompt.section(...)` and `ctx.tools.restrict(...)`.
- `{ allow: [] }` is legal and means "keep none". `tools.restrict` throws only for `{}`
  (`allow === undefined && deny === undefined`); an empty `allow` set compiles and is applied.
  The preset's own scoped tools stay visible to the child, which is harmless — it cannot call
  them.

### Sampling: the engine default is already the best configuration

| claim | source |
|---|---|
| an absent `temperature` keeps the engine's default, **which is greedy (0)** | `serve/server.py:161-162` |
| greedy measured 6/6 on the tool-task set; `temperature 0.6` measured 5/6 | `本地工具模型建议.md` §3.1 |
| the engine accepts exactly `reasoning_effort: none \| low \| medium \| high` | `serve/server.py:1764-1766` |
| thinking off measured 5/5 on extraction/counting/arithmetic/code at a 0.61 s median; on, a 3.48 s median and a 12.42 s worst case, with no correctness gain on those classes | `本地工具模型建议.md` §3.2 |

So **do not add a `sampling` block to the engine config** — the delegation path is already on the
6/6 configuration. Temperature was never the problem.

**Thinking is now off at the engine for this deployment** (`POST /settings {"defaults":
{"reasoning_effort":"none"}}`, persisted to `strata-coder-iq1_m.shared-settings.json`), because the
engine's shared defaults fill in only where a request carries none of its own (`serve/server.py:759`)
and the harness sends none. Measured on this machine, 2026-10-01:

| measurement | before | after |
|---|---|---|
| one identical delegation (8-row JSON answer), engine log | `471 generated in 5992 ms` | `210 generated in 2283 ms` |
| the same tiny echo task, controlled A/B | `reasoning_effort: high` → 76 completion tokens, 1275 ms | shared default → **21** tokens, 679 ms |
| a harness-delegated child, engine log | `471 generated` | `21 generated in 238 ms` |

Honest correction to an earlier claim of "3–5×": the `0.61 s vs 3.48 s` pair in the table above was
measured on a different task set. On *this* preset's mechanical shapes the saving is ~2× generation
and roughly a second of wall time, not 3–5×. It is free, so it is on; a caller that wants thinking
back must still declare the effort on the provider row (option 2 below), because `strata` rejects an
effort it does not advertise.

### Do not delegate version or mixed-numeric ordering

Measured 5 runs each on `3.10, 2.7, 3.9, 2.11`: **0/5 with thinking off, 2/5 with it on**, always
failing the same way — `"3.10"` is parsed as the number `3.1` and then sorted
lexicographically to `[2.11, 2.7, 3.1, 3.9]`. That is a 1.89-bit quantisation limit, not a prompt
bug, and thinking does not fix it. Plain string and plain number ordering is fine. The routing
guidance says so explicitly.

### Contract facts verified against the live harness

| fact | how |
|---|---|
| `strata/qwen3.8-flash-next-coder-iq1_m` is a live route | `list_subagent_models provider=strata` |
| a delegated task round-trips correctly | sent a 3-line extraction; got `["alpha","delta","zeta"]` |
| **no reasoning effort may be sent** — the provider rejects one it does not advertise | `subagent(provider=strata, reasoning_effort='none')` → `provider "strata" model "…" does not support reasoning effort "none"`, before any request is sent |
| the engine is up and greedy | `GET /health` → `{"status":"ok","model":"qwen3.8-flash-next-coder-iq1_m","loaded":true}` |
| the attachment store takes encoded **bytes**, not base64 | in `app.asar`: `SaveImageAttachment { data: Uint8Array; … }`, `probeImage` → `sharp(data)`, and the wire adapter `saveInput` does `decodeBase64(image.data)` |
| a preset module instance is loaded **once per DSH process** | DSH started `18:12:02`, the module was rewritten `18:16:32`, a session opened `18:26` still reported the old `retries` default (`attempts=2`); see *Installing and editing* |
| what a delegated child can actually reach | its own transcript: `list_subagent_models` works, `subagent` exists but is always refused (`depth 2 exceeds maxDepth 1`), `workflow` is `unknown tool` (3 attempts, nothing written) |

Because of that rejection, `DSH_LOCAL_REASONING_EFFORT` defaults to **empty**: the request omits
the field rather than failing. Two ways to run with thinking off, in order of preference:

1. **At the engine, for every client.** The engine keeps its shared sampling defaults in
   `<config>.shared-settings.json` and applies them to any request that does not carry its own:
   ```powershell
   Invoke-RestMethod -Method Post -Uri http://127.0.0.1:8080/settings `
     -ContentType 'application/json' -Body '{"defaults":{"reasoning_effort":"none"}}'
   ```
2. **Per call, from the harness.** Declare the effort on the provider's model row in the profile
   patch so the provider advertises it, then set `DSH_LOCAL_REASONING_EFFORT=off`:
   ```yaml
   - id: llm-pi-ai
     name: "@deepseek-ai/dsh-llm-pi-ai"
     config:
       providers:
         strata:
           models:
             - id: qwen3.8-flash-next-coder-iq1_m
               reasoningEfforts:
                 off: none
                 low: low
                 high: high
   ```

## Configuration

| Variable | Default | Effect |
|---|---|---|
| `DSH_LOCAL_PROVIDER` | `strata` | provider route for the delegated child |
| `DSH_LOCAL_MODEL` | `qwen3.8-flash-next-coder-iq1_m` | model id |
| `DSH_LOCAL_REASONING_EFFORT` | *(empty)* | per-call effort; empty omits the field (see above) |
| `DSH_LOCAL_STRIP_TOOLS` | `1` | `0` keeps the child's inherited tool surface |
| `DSH_LOCAL_CHILD_PERSONA` | a two-line tool-model persona | shadows the child's `deployment:persona-prefix` |
| `DSH_LOCAL_MAX_TOKENS` | `4096` | per-delegation cap; `0` omits it |
| `DSH_DELEGATE_TIMEOUT_MS` | `120000` | wall-clock budget for ONE child run; past it the child is aborted and reported as `did not finish`, and not retried. Read per call |
| `DSH_STRATA_HOST` / `DSH_STRATA_PORT` | `127.0.0.1` / `8080` | engine address, also used by the preflight |
| `DSH_SKIP_ENGINE_PROBE` | unset | `1` skips the preflight (tests) |
| `DSH_DELEGATE_OUTPUT_CHARS` | `500` | raw-answer echo size per task; a longer answer is also written to `outputFile` |
| `DSH_DELEGATE_OUTPUT_DIR` | unset (`<tmp>/dsh-delegate-out-*`) | where full answers are written; one directory per batch |
| `DSH_VERIFY_PYTHON` (or `CVISION_PYTHON`) | `python` | interpreter for `python_exec` |

There is no image-specific knob. A picture travels as a harness attachment, so the deployment's own
attachment limits (image count per message, aggregate bytes, accepted media types) apply, and a
refused batch is reported per task rather than thrown.

## Files

| File | Role |
|---|---|
| `cordis.patch.yml` | **Generated.** The preset declaration: the shipped `standard` plugin list verbatim, then the one added row |
| `local-delegate.mjs` | The added capability: verifiers, `delegate_batch` (text + images), the routing guide |
| `local-delegate.selftest.mjs` | 178 deterministic cases, each pinning a behaviour or a defect; ten mutations of the module (a kind dropped from the table, the positive-acceptance half of `prove` reverted, the payload never persisted, `citation` back to single-line, `wholeWord` dropped, boundaries tested on squashed text, the child predicate disabled, the section back to a plain string, the stop reason ignored, the batch footer dropped) are each caught by the case meant to catch them |
| `package.json` | Bundle manifest: `dsh.bundle.patch`, and the `exports` map the module subpath resolves through |
| `scripts/sync-install.mjs` | Copies this tree into the profile's pnpm copy (pnpm will not re-copy a changed non-manifest file) |
| `../../tools/build-local-delegate-preset.py` | Regenerates `cordis.patch.yml` from this build's own app.asar |
| `../../tools/dump-shipped-preset.py` | Prints a shipped preset's plugin list, for diffing |
| `../../tools/validate-preset-bundle.py` | Pre-install check: every package exists in this build, every local module resolves and is in `exports` |
| `../../tools/vision-check.py` | Standalone bridge: ask a running Strata engine about an image and get a machine verdict. Useful for probing the engine without a harness session |

## Running the self-test

```bash
node local-delegate.selftest.mjs
```

178 cases: fence tolerance, a malformed schema that must not pass everything,
`additionalProperties:false` and `minLength` enforced, integer vs number, a looping answer
reported as repetition rather than as malformed JSON, an empty answer blamed on the engine, the
gate never throwing on wrong-typed payloads, the `def`-extraction bug above, the exact
`SubagentStartRequest` shape (including *no* reasoning effort by default), registration through
`ctx.effect`, `delegate_batch` end to end against a fake provider (retry-once, no abort,
numbered ids, dispose on every path), and the image path: the block is `type: 'image'` with a
durable attachment ref and **never** `image_url`, nothing is committed when one path in a batch is
bad, a readable image with no attachment service FAILS instead of silently going text-only, and a
bad path fails its own task without being retried and without aborting the tasks after it.

Beyond those: the kind table is checked against the source (`checkInner`'s `case` labels, the
description, both `kind` enums, and the README must all agree — the check that would have caught the
five invisible kinds); `prove` is checked on **both** halves (a gate that rejects the right answer is
not proven, and the same for a `python_check` that always raises); every derivable positive is
checked against its own gate, plus the two false-alarm rules (`closedShape`/`json_order`,
`duplicateItem`/`set_eq`) and a schema with no instance; and the payload path is checked end to end
(the file holds the answer byte for byte, the echo stays verbatim, and a short answer leaves no file
behind). Each of those was verified to have discriminating power by mutating the module and requiring
the matching case to fail.

Four more came from the same discipline. `wholeWord` was added because `covers` passed a false
answer, and its boundary test runs on space-preserving text rather than on `squash` (the case for
that catches a mutation which would otherwise be invisible). `citation`'s `span` was added because
single-line matching called a real two-line quotation fake, and `span: 1` is pinned as the strict
alternative. The child-prompt suppression is pinned from both sides — the guide must be present for a
top-level agent and absent for a child, by header depth and by runtime depth — plus a case that an
unreadable context keeps it. And the stop-reason rule is pinned with a *passing* answer that must
fail anyway, which is the only shape that proves the stop reason outranks the verifier.

The suite drives `apply` with a minimal fake context on purpose: `import` proves a module
evaluates, never that its handlers run.

## Using it

The preset is chosen when a session is **created**, not in an existing session's composer: the
control is the `conversation.hero.agentPreset` slot on the New Session screen. Start a new chat,
pick **Local Delegate**, and the session's catalog gains `verify_task` and `delegate_batch`.

A delegation-shaped first request looks like this:

> 把这段文本按行抽出第一个词，然后跑一遍；如果本地模型答错了就自己接过来做。
> （then paste the lines inline)

The agent is expected to call `delegate_batch` with an inline input and a `json_equals` verifier,
read the `PASS`/`FAIL`, and only fall back to itself on `FAIL`.

For a picture, the same call with a path and a reading-shaped verifier:

> 这张截图里写了什么？用本地模型读，读错了你自己接过来。
> `images: ["C:\...\shot.png"]`, `verify: { kind: "all_of", expected: ["MEN WALK ON MOON", "SAMPLE 42 DELTA"] }`

## Installing and editing

The bundle is installed into the `desktop` profile as a `file:` dependency:

```powershell
# from the DSH GUI / agent: plugin_manager install_bundle
# target: file:C:\Users\14339\Desktop\git\Strata\dsh-preset-local-delegate
```

Then **edit here and sync**, never edit the installed copy:

```powershell
node scripts/sync-install.mjs          # copy this tree into the profile's pnpm copy
node scripts/sync-install.mjs --check  # exit 1 when the installed copy is stale
```

The sync script exists because of a measured trap. pnpm keys a `file:` directory dependency by
its **manifest**, not its contents: after `README.md` was added, a re-install printed "Already up
to date" and the profile copy still lacked the file. So editing `local-delegate.mjs` — a
non-manifest file — and re-running the install leaves the harness running the **old** module
while the source tree shows the new one, and the obvious signal ("I reinstalled it") actively
lies about which code is live.

**A new session is not a reload — the process is.** Measured 2026-10-02, same machine: DSH started at
`18:12:02`; `local-delegate.mjs` was rewritten at `18:16:32` and synced (source and installed copy
byte-identical); a **new session opened at 18:26** still ran the 18:12 module. Two independent
witnesses: every `delegate_batch` tool description still read `default 1` where the file read
`default 0`, and a probe dispatched with **no** `retries` argument reported `attempts=2 · 1 retried`
— the old default — where this revision reports `attempts=1 · 0 retried`. The routing GUIDE, by
contrast, *is* re-evaluated every turn, so it shows the new text while the tool bindings stay old:
that mismatch is exactly how this trap convinces a careful reader that the reload happened. **Restart
DSH itself, not just the session, and tell them apart with behaviour rather than with prose:**

> **probe** — dispatch one task whose gate must FAIL (e.g. ask for `[1,2,3]` and verify
> `json_equals "[4,5,6]"`), pass no `retries`, and read the result line: `attempts=1 · 0 retried`
> means this process loaded the current file; `attempts=2 · 1 retried` means it did not. Cost: one
> or two ~0.3 s local generations.

Before installing, run the two checks:

```powershell
python tools/build-local-delegate-preset.py --check
python tools/validate-preset-bundle.py dsh-preset-local-delegate
```

`cordis.patch.yml` is generated from this build's app.asar. After a harness upgrade, regenerate
it and diff against `python tools/dump-shipped-preset.py standard --body-only` — that diff is the
whole claim of this preset, so it should only ever be the one added row.

## Honest boundaries

These are stated rather than hidden, in the same spirit as the measurements above.

- **The DSH source checkout next door is NOT the build that runs.** The desktop app is **0.2.0-rc.2**
  (`…\DeepSeek Harness\resources\app.asar`); `..\deepseek-harness` is checked out at
  `dsh-v0.1.7-rc.2`. So every harness-internal claim this preset leans on was re-verified **inside the
  running build**, and the file/line references elsewhere in this README are indicative only. What was
  checked in `app.asar`, with its own words:
  - **the section `text` callback** (what the child suppression depends on): the build resolves
    `text: typeof section.text === "function" ? section.text(context) : section.text`, and its own
    `plan:policy` section is registered exactly that way and reads `context.agent.session`;
  - **the child predicate**: `AgentOptions.subagentDepth?: number`, and the session header's
    `readonly origin?: 'subagent'`, `readonly parentSession?: SessionId`,
    `readonly delegationDepth?: number`;
  - **the stop-reason vocabulary**: `SubagentStopReasonMap = { completed, aborted, error,
    'max-tokens', refusal }`, and `SubagentResult` carries `stopReason` plus an optional
    `diagnostic` (which is why an unfinished run's FAIL can quote the provider's own reason);
  - **the preset row**: `PresetDefinition = { id, name?, description?, order?, plugins }` — no length
    limit on `name`/`description`, which is what let the legacy sibling preset say so in its own
    roster entry. A deployment's roster is not a file: it is the `@deepseek-ai/dsh-agent-preset`
    entries of the startup patch stack (`dsh.profile.bundles` order, then the profile's own patch,
    then the home layer), and `agent-preset-registry.selectedDefault` is what a *new* session gets
    (`defaultId = selectedDefault ?? default`). `tools/check-profile-roster.py` composes exactly
    that stack from the files — resolving bundles from the profile's `node_modules` and then from
    the **running `app.asar`** — and reports the rows plus whether the effective default still
    resolves, which is the failure a hand-edited manifest invites. It proved the removal of the
    legacy sibling preset on this machine (5 rows, no `hybrid-router`) and it has teeth: a mutation
    putting the legacy preset back is reported as a 6th row. That legacy bundle was then deleted from
    the profile (it was not loaded any more), but **only after being archived**
    (`dsh-preset-hybrid.removed-2026-10-02.zip` in the repo root) — it held a 25,327-byte
    `router-hybrid.mjs` that existed in **no** other copy, not even in its own bundled `.git`
    (HEAD has the older 23,692-byte version, uncommitted work on top). Unzip it to re-run that
    positive control.
    **Removing a preset is not just a manifest edit, and the file-level check cannot see why.** A
    session records `agentPreset` in its header, and the workspace client does not send a preset when
    you click "new session" (`sessions.create({ workspaceId })`) — it *reuses* a blank session in that
    workspace instead. So a blank session that recorded the removed id makes **every** new session fail
    with `agent-preset/not-found: Unknown agent preset: <id>`, while `check-profile-roster.py` reports a
    perfectly healthy 5-row roster: measured here on 2026-10-02, right after the removal, on a 341-byte
    blank session with 4 records and no conversation. `tools/session-headers.mjs` finds those
    (`--preset <removed id> --blank`; 41 of the 42 `hybrid-router` sessions were subagent children and
    harmless, 1 was blank and fatal), and `tools/session-set-preset.mjs` repoints one header — dry-run
    by default, rewriting frame 0 of the zstd frame chain and leaving every later frame byte-for-byte
    untouched, with a backup and a frame-level re-read to verify.
  A claim read only from that checkout is a claim about a *different* version, and this preset has
  already been bitten once by exactly that class of mistake.

- **The child no longer pays for this preset's own routing guide — solved inside the module.**
  Two measurements first. `toolFilter: { allow: [] }` does exactly what it claims: delegations from a
  session on this preset read `prompt 3522` and `prompt 3576 tokens` in the engine log, against a
  **12,401**-token baseline without the strip, so the tool schemas are gone. But what remained was
  mostly the child's *inherited prompt sections*, and this preset's own GUIDE is 6,679 characters =
  **1,633 prompt tokens** (measured through the engine's `usage.prompt_tokens`), about **46%** of the
  ~3,540-token child prompt — paid on every single delegation, for text a child that cannot call
  `delegate_batch` can do nothing with. The harness cannot fix this: `applyChildComposition` joins the
  parent's preset *generation* (read out of the **running build**, see the version boundary below), so
  a plugin's `apply` is never re-run for a child, and the only per-child overrides are
  `deployment:persona-prefix` and a tool restriction. The fix is the section's own `text` callback —
  the shape `plan-mode` already uses for its policy section. It is a FUNCTION now and returns `''`
  when the request belongs to a delegated child. The predicate is the harness's own depth rule
  (`max(session.header.delegationDepth, options.subagentDepth)`, zero for a top-level agent), read
  defensively without importing the package, and anything unreadable keeps the guide: hiding it from
  the top-level agent would remove the routing rules this preset exists for, while showing it to a
  child only costs tokens. **Closed — measured from a session that loaded this revision**: one
  `delegate_batch` task with its text inline read `strata serve: prompt 1963 tokens = 0 reused +
  1963 read` in the engine log. The `0 reused` is a cold prefill, not a cache miss: the top-level
  agent's prompt is not shared with anything, and the guide is the only thing that changed. 1,963
  lands inside the predicted 1,800–2,000 band, and the arithmetic closes against the
  tool-strip-only numbers above: 3,522 − 1,633 ≈ 1,889 ≈ 1,963. Re-measured on the restarted app the
  same day: `prompt 1952 tokens` for a one-step text task, so the suppression survives the restart.
  **Third session** (app started 19:02:48, module identity probed as new first via
  `attempts=1 · 0 retried`): `prompt 1587 tokens = 0 reused + 1587 read` for the same one-task text
  shape. All three land far below the tool-strip-only 3,522 and inside the predicted band. The
  exact figure drifts between sessions (1,963 / 1,952 / 1,587, ~370 tokens of spread) and that drift
  is *not* the guide — the guide is 1,633 tokens, and it is the one thing these sessions share as
  absent; the spread tracks other session-level prompt content and was not investigated further.
- **A `delegate_batch` task has no tools — by this preset's own choice, not by the engine's limit.**
  A delegated *child* does inherit its parent's composition, and on this engine a child called
  `read` and answered from the file, then called `glob` and `read_image` and read a picture
  correctly — two tool steps, 0 API tokens. `delegate_batch` strips them because its shapes are
  text in / text out and the inherited schemas cost ~10k extra prompt tokens (13,023 with them,
  2,780 without, and a 5,606 ms cold prefill). When a task genuinely needs tools, call the
  `subagent` tool with the same provider and model instead: it inherits tools, its first step is
  ~5.6 s and later steps ~1 s through the prefix cache, and it carries **no verifier**, so gate
  the answer with `verify_task` yourself. Red line: delegate the *perception* (a file read, a
  screenshot read, a reading-shaped answer), never a *sequence of actions* — a wrong click has no
  deterministic judge.
- **Interface note for the tool-using path.** An earlier revision of this file said the local
  model "has no tool loop". That is true of the engine's own HTTP API and false of a delegated
  child, because the harness supplies the loop. The strip above is a cost decision, not a
  capability claim.
- **`images:` was BROKEN end to end, and the suite could not see it — the shape sent to the store was
  the wire shape.** Running the delegation this section used to ask for (it was the last unmeasured
  path) failed instantly, on every image, with **zero engine calls**:

  ```text
  1.ocr-plain: FAIL ❌ — Unsupported or malformed image data.
  — 0/2 PASS · 0.0 s of local compute
  ```

  The message comes from the attachment store (`AttachmentError(…, "INVALID_IMAGE")` in the running
  build), which decodes with `sharp`. The build's own declaration says why:

  ```ts
  export interface SaveImageAttachment { data: Uint8Array; mediaType: ImageMediaType; name?: string }
  ```

  `data` must be **raw bytes**. This module sent `data: buf.toString('base64')`, which is the RPC
  *wire* shape — and the harness's own adapter between the two proves it, because it converts exactly
  that: `saveInput() { return { data: decodeBase64(image.data), … } }`. The plugin had skipped the
  decode step, so the store handed a base64 string to `sharp` and refused the batch.
  **The self-test was worse than silent — it pinned the bug**: one assertion required
  `data === PNG_1PX.toString('base64')` and another required `typeof data === 'string'`, so 190 green
  tests coexisted with a feature that could not work at all. Both are now inverted to assert bytes
  (`Buffer`/`Uint8Array`, `Buffer.compare` against the fixture) with the build's declaration cited
  above them, and a mutation (re-encoding to base64) fails exactly those two assertions and nothing
  else. What earlier measurements *had* established stands: the **engine** reads all five fixtures
  (6/6, `all_of` needles, shape/digit binding, a photo description), and the old wrong block shape was
  caught live — but that verified the engine and the request shape, never this store contract.
  **Confirmed after the app was restarted onto this revision** (2026-10-02, the same delegation as
  above): `1.ocr-plain-image: PASS ✅ — all 2 found (8232 ms)`, with `MEN WALK ON MOON / SAMPLE 42
  DELTA` in the echo, and the engine log shows the request (`prompt 2469 tokens = 0 reused + 2469
  read` — a cold prefill). The picture reaches the engine now. The same run also showed what a child
  with nothing to do costs: 6 steps and 5 tool calls before it answered — see *What one image
  delegation actually costs* above, and note that the restart is what made any of this measurable:
  a *new session* in the old process still ran the base64 module, which is why the delegation kept
  failing after the fix had been written and synced. **Re-confirmed on a later app start**
  (2026-10-02): `PASS ✅ — all 2 found (1454 ms)` on a fresh process whose module identity had been
  probed as new, with `prompt 2079 tokens = 0 reused + 2079 read` in the engine log — a cold prefill
  that carries the image, on a run that cost **1.5 s** and one step, so the 6-step / 120-second
  outcomes in the table above are the child's behaviour varying, not a property of the image path.
- **`mk-test-images.py` draws a CIRCLE, not an ellipse.** Its `d.ellipse([60,160,260,360])` is a
  200×200 box. Two people (and one checker) have now been misled by the word in the filename: the
  local model answers "circle", which is geometrically correct, so a verifier looking for "ellipse"
  fails a right answer. Check the shape that is actually drawn.
- **`outputSchema` is deliberately unused.** The `spawn` provider supports it and it would remove
  the fence-parsing problem entirely, but it is implemented as a tool call plus an instruction —
  which is exactly what `toolFilter: { allow: [] }` strips. The measured, working path is a
  prompt plus a fence-tolerant verifier.
- **Delegated children are composed from the parent's preset — and that is NOT harmless.**
  `applyChildComposition` calls `agentPresets.composeFrom(childCtx, parent.ctx)`, so a child still
  sees this preset's own scoped tools — `verify_task`, `delegate_batch`, and, measured,
  **`subagent` and `list_subagent_models`** — even under `toolFilter: { allow: [] }`. The strip
  yields a child with no *host* tools, not a tool-less child. An earlier revision of this file
  called that "harmless here — the local model cannot call them". It is not harmless: the child
  called `subagent` **169 times** and `list_subagent_models` 3 times in a single turn and produced
  an unbounded loop (the runaway below). A `deny` list cannot fix that — the harness rejects it
  outright (measured, see below) — so a per-run **budget** bounds the damage instead, and nothing
  *removes* the tool from a child: only the harness could do that.

- **A `delegate_batch` child can call `subagent`, and that produced an unbounded loop (measured).**
  On a letter-count task — "Output ONLY raw JSON, no code fence, no prose: the JSON number of times
  the letter `a` appears in the string …" — the local child never answered. It re-delegated the very
  task it had been given, calling `subagent` 169 times and `list_subagent_models` 3 times inside one
  turn, and walked the entire `reasoning_effort` ladder (`medium` ×40, `low`/`none`/`minimal` ×21
  each, `high`/`xhigh`/`max` ×20 each) chasing an error it could not escape: this engine advertises
  **no** reasoning effort, so every attempt returned
  `provider "strata" model "qwen3.8-flash-next-coder-iq1_m" does not support reasoning effort "X"`.
  The child's own transcript records the shape exactly — 173 `step/start`, 173 `step/end`, 172
  `assistant/message`, 172 `tool/call`, 172 `tool/result`, **169 of the results errors** — spanning
  **341 s** and **24,500 output tokens**, with its prompt growing ~193 tokens per step from 1,970 to
  **34,627** (the engine log shows the growth and the near-total prefix reuse, ~1.7 s per step).
  Nothing in this module stopped it: `retries` bounds re-runs, not the steps inside one run, so the
  plugin sat on `run.result` until a human aborted the turn. Two guards contained it, and both were
  luck rather than design — the route policy rejected the first attempt
  (`child LLM route "deepseek/deepseek-chat" is not allowed for this Session`) and the harness
  refused depth 2 (`subagent depth 2 exceeds maxDepth 1`, ×4). **Zero** nested children were
  created, so the loop stayed sterile; it still pinned the engine for 5.7 minutes and cost the turn.

  **Fixed by a budget — and the other obvious fix had to be reverted, which is the interesting part.**
  1. A **wall-clock budget per child run** (`DSH_DELEGATE_TIMEOUT_MS`, default 120 s) — the real fix.
     The harness offers no step cap to borrow (no `maxSteps`/`maxTurns` anywhere in the running
     build), so this is the plugin's own bound: past it the child is aborted *and* the plugin stops
     waiting (`Promise.race`, so a child that ignores its signal cannot keep the caller hostage), the
     existing "a run that did not finish is not an answer" path reports it, and it is marked
     **unretryable** because a budget overrun reproduces — retrying would buy the same waste twice.
     Proved to have teeth by mutation: against a child whose `result` never settles, the shipped
     module returns in **157 ms** with `stop=aborted`, `attempts=1`, disposed; with the ten lines of
     budget logic spliced out, the same call **hangs** (still waiting at 2.5 s, i.e. forever). The
     self-test carries both the hanging-child case and a no-leak check that the tiny test budget does
     not stick to later delegations.
     **Confirmed live, end to end** — a 200-character verbatim-copy task ran away and was cut off:
     the child was created at `17:53:01.388`, its last step began at `+119.2 s`, its `turn/end`
     arrives at **`+120.018 s`** with reason `{"kind":"aborted","reason":{"kind":"parent"}}`, and the
     engine logs its last request at `+120.077 s`. So the budget does not merely release the caller —
     the abort reaches the child and stops it within 18 ms. The verdict was
     `FAIL ❌ — the child did not finish: stop=aborted … (120027 ms)` with **`attempts=1`**: the
     `unretryable` half held, so the batch did not pay the same 120 s twice.
  2. **`deny` does not work and was removed** — do not re-add it. It is the obvious companion
     (`deny: ['subagent', …]` beside `allow: []`) and it does not merely fail to restrict, it breaks
     the *whole delegation path*. `tools.restrict()` validates every denied name against the GLOBAL
     tool registry and refuses the request outright. Measured, verbatim:

     ```text
     delegation error: tools.restrict() names unknown global tools "subagent", "subagent_codex",
     "subagent_claude_code", "list_subagent_models", "wait_agent", "ralph"; known global tools:
     ask_user_question, click, … , subagent_fork, … , verify_task, workflow, write
     ```

     Every task failed in ~5 ms (`attempts=3`, `0.0 s of local compute`) — not one task, the path.
     Two things follow, and the second inverts the guess the list was built on: `toolFilter` cannot
     name the tool that caused the runaway, because `subagent` is registered by this preset's **own**
     composition and is therefore not global; and the global delegation tools it *can* name
     (`subagent_fork`, `list_agents`, `send_message`, `interrupt_agent`, `workflow`, `verify_task`,
     `delegate_batch`) are already gone under `allow: []`, so such a list is pure decoration even when
     it is spelled correctly. **There is no way for this plugin to take `subagent` out of a child's
     hands — only the harness could.** The budget is the bound; the filter is exactly `{ allow: [] }`
     and the self-test now pins that a `deny` key reappearing is a regression, not a hardening.

  The lesson generalises past this one option: an unmeasured filter argument is not a cheap
  precaution here, it is a way to break every delegation at once. The budget was measured before it
  was believed; the `deny` list was believed before it was measured, and cost a turn.

- **The un-strippable tool list is a systemic tax, not one exotic failure.** Because a child keeps
  `subagent`/`list_subagent_models`, this model *reaches for them* on tasks that do not need them.
  Measured on a 200-character copy task: **110 steps, 109 tool calls — `list_subagent_models` ×104,
  `subagent` ×4, `run_subagent` ×1** (that last name is not even in this preset's patch), ending only
  when the budget aborted it. The mechanism is worse than the first incident: those calls
  **succeeded**, so there was no error to break the cycle — 104 successful discovery results, each
  appended to the context, each one inviting another call. The earlier run looped on *errors*
  (169 refusals); this one looped on *successes*. Two consequences worth planning for: a simple task
  can spend seconds wandering before it answers (a 160-character copy took 11.4 s and several steps,
  where one generation is ~2 s), and a task it cannot do may burn the entire budget instead of
  failing cleanly. Sizing rule: keep delegated tasks small enough that a budget-sized loss is cheap,
  and set `DSH_DELEGATE_TIMEOUT_MS` deliberately (it is read per call, so a launch environment can
  shorten it for an experiment without touching the module).
- **The sibling preset's roster label is read from a copy somebody has to sync by hand.** The
  label `Hybrid Router (legacy — pick Local Delegate for gated local work)` had been written into
  `<profile>/bundles/dsh-preset-hybrid/cordis.patch.yml` and left there: the copy DSH actually
  loads, `<profile>/node_modules/dsh-preset-hybrid/cordis.patch.yml`, still said plain
  `Hybrid Router`, so the roster would have kept showing the old label no matter how many times
  anyone looked at it. The bundle ships its own `scripts/sync-installs.mjs` (dry run by default);
  the only file that differed was `cordis.patch.yml` — every module was already byte-identical — so
  `--write` copied that one file and then reported `All targets already match this tree`. Two
  consequences worth keeping: a label change needs a **restart** (roster rows are read at startup),
  and the third copy the script writes, `$DSH_HOME/.agent-presets/hybrid-router/`, is read by
  nobody — the running build says so in its own words: *"Nothing reads that directory any more."*

- **The guide's semantic-version warning is conservative, and this engine disagreed with it.** The
  routing guide tells the caller not to delegate semantic-version ordering, on the strength of a
  measured 5/5 local failure rate (3/5 with the thinking channel on). From a session that loaded
  this revision, two such tasks came back correct on the first attempt and passed:
  `["3.10","2.7","3.9","2.11"]` → `["2.7","2.11","3.9","3.10"]` and
  `["1.12","1.2","1.9","1.10"]` → `["1.2","1.9","1.10","1.12"]`. Two samples do not retire a rule
  backed by ten, so the guide keeps it; but a task refused on that rule alone is worth one re-check
  against whatever engine is actually loaded.

- **A harness upgrade can invalidate the base list.** That is what the generator is for; do not
  hand-edit `cordis.patch.yml`.
- **The verifier is the safety property, not the model.** A transport fault can produce fluent
  text that answers a different question, and the local model has no way to know. If you cannot
  write the checker, the task does not belong on this path.

## License

No license file is included. Add one before reuse outside the author's own deployment.
