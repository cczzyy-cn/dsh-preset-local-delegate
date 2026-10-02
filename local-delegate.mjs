/**
 * local-delegate — the one capability this preset adds to the shipped `standard` preset:
 * delegate a DETERMINISTICALLY VERIFIABLE subtask to the local model, then gate the answer
 * behind a deterministic verifier before it is used.
 *
 *     classify -> can I write a deterministic checker?
 *         no  -> keep it on DeepSeek (do not delegate)
 *         yes -> delegate_batch to the local engine (0 API tokens)
 *                  -> verify_task / per-task verifier
 *                        PASS -> accept            FAIL -> escalate to DeepSeek
 *
 * WHY THE GATE IS THE WHOLE DESIGN. A wrong local answer that is accepted silently is a
 * correctness bug; a wrong local answer that is *rejected by a verifier* costs the local
 * compute AND a DeepSeek round trip, i.e. more than never delegating. So the entry condition
 * for this path is "I can write the checker", not "this looks easy".
 *
 * MEASURED FACTS THIS MODULE IS BUILT ON (see README.md for the table and the sources):
 *   - the engine's own sampling default is GREEDY, which is the 6/6 configuration;
 *   - the thinking channel is ON by default and buys nothing on these task classes;
 *   - the child's inherited tool schemas are most of its prompt (measured 12,401 tokens for a
 *     3-line input), and the local model cannot call tools at all;
 *   - the local engine is MULTIMODAL, so a task may carry `images` (see the image block comment
 *     below for the wire shape, which is NOT the obvious one and fails silently when wrong).
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { writeFileSync, readFileSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { join, extname, basename } from 'node:path'
import { tmpdir } from 'node:os'
import net from 'node:net'

export const name = 'local-delegate'
export const inject = ['tools', 'systemPrompt', 'subagents', 'attachments']

/**
 * Is this request being assembled for a DELEGATED CHILD rather than the top-level agent?
 *
 * The predicate is the harness's own definition of delegation depth
 * (`@deepseek-ai/dsh-subagent/depth.ts`: `max(session.header.delegationDepth, options.subagentDepth)`,
 * zero for a top-level agent). It is read defensively and without importing the package, because a
 * preset bundle does not depend on the harness's internals — and a wrong answer here must fail
 * toward SHOWING the guide: hiding it from the top-level agent silently removes the routing rules
 * this preset exists for, while showing it to a child only costs tokens.
 *
 * A second, independent signal is the session header a delegated child is created with
 * (`childSessionMeta`): `origin: 'subagent'` plus the parent's session id. It is only ever used to
 * ADD evidence.
 */
export function isDelegatedChild(context) {
  try {
    const agent = context && context.agent
    if (!agent) return false
    const header = agent.session?.header
    const fromHeader = header?.delegationDepth
    const fromOptions = agent.options?.subagentDepth
    const depth = Math.max(
      typeof fromHeader === 'number' ? fromHeader : 0,
      typeof fromOptions === 'number' ? fromOptions : 0,
    )
    if (depth > 0) return true
    return header?.origin === 'subagent' && typeof header?.parentSession === 'string'
  } catch {
    return false
  }
}

/**
 * Stop reasons that mean the child did NOT finish, from the harness's `SubagentStopReason`.
 *
 * This matters more than bookkeeping. `delegate_batch` used to read only `output` and ignore the
 * stop reason, so a child that hit its token ceiling or was aborted still produced text — and a
 * PARTIAL answer that satisfies the gate is accepted as a verified one. A summary covering half the
 * symbols still "covers" them; a truncated JSON array is still an array. Only `completed` (or a
 * provider that reports no reason at all) is a finished answer.
 */
const NON_COMPLETED_STOPS = new Set(['max-tokens', 'aborted', 'error', 'refusal', 'blocked', 'cancelled', 'interrupted'])

/** The local route. `strata` is the provider row the deployment registers for its engine. */
const LOCAL_PROVIDER = process.env.DSH_LOCAL_PROVIDER || 'strata'
const LOCAL_MODEL = process.env.DSH_LOCAL_MODEL || 'qwen3.8-flash-next-coder-iq1_m'

/**
 * Per-call reasoning effort, or '' for "leave it to the provider".
 *
 * Default is '' on purpose: the `strata` provider advertises no reasoning efforts, and asking
 * for one is rejected before the request is sent —
 *   provider "strata" model "qwen3.8-flash-next-coder-iq1_m" does not support reasoning effort "none"
 * (measured 2026-10-01 against the live harness). To delegate with thinking OFF, either declare
 * the effort in the provider config or set the engine's shared default; README.md has both.
 */
const REASONING_EFFORT = process.env.DSH_LOCAL_REASONING_EFFORT || ''

/**
 * Strip every host tool from the delegated child.
 *
 * This is a COST decision, not a capability claim. An earlier revision of this comment said the
 * local model "has no tool loop": that is true of the engine's own HTTP API and FALSE of a
 * delegated child, because the harness supplies the loop. Measured (2026-10-01, 0 API tokens): a
 * child on `strata/qwen3.8-flash-next-coder-iq1_m` called `read` and answered from the file, and
 * called `glob` then `read_image` and read a picture correctly — two tool steps.
 *
 * The reason to strip anyway: a 3-line, 12-token task produced a **13,023-token** prompt with the
 * inherited schemas (2,780 without) and a **5,606 ms** cold prefill, because the child inherits the
 * parent's whole preset composition and every tool schema with it. When a task genuinely needs
 * tools, call the `subagent` tool with this provider and model instead — it inherits them, costs
 * ~1 s per step after the first, and carries NO verifier, so gate its answer with `verify_task`.
 *
 * `{ allow: [] }` is legal and means "keep none": `tools.restrict` only rejects the `{}` case
 * (read out of this harness's own bundled source — `allow === void 0 && deny === void 0` throws,
 * an empty `allow` set does not).
 *
 * THE PRESET'S OWN SCOPED TOOLS SURVIVE IT, AND THAT IS NOT HARMLESS. `toolFilter` is documented in
 * the running build as a "per-child **global**-tool restriction", and this preset's own
 * `cordis.patch.yml` registers `@deepseek-ai/dsh-tool-subagent` (toolName `subagent`, plus
 * `subagent_fork`/`subagent_codex`/`subagent_claude_code`) and the subagent-control list tool — so
 * those arrive in the child as preset-scoped tools, not global ones, and `allow: []` does not touch
 * them. An earlier revision of this comment ended "which is harmless: it still cannot call them".
 * Measured 2026-10-02: a child called `subagent` **169 times** in one turn, re-delegating the task
 * it had been given, and looped for 341 s / 24,500 output tokens until a human aborted the turn
 * (169 of 172 tool results were errors — the engine advertises no reasoning effort, so each retry
 * with a different effort was refused and the model kept permuting the parameter). The bound that
 * holds is the wall-clock budget below; the tool itself cannot be taken away from the child, and the
 * comment that follows (why there is no `deny` list) is the measurement that proves it.
 */
const STRIP_CHILD_TOOLS = process.env.DSH_LOCAL_STRIP_TOOLS !== '0'

/**
 * WHY THERE IS NO `deny` LIST BESIDE `allow: []` — a measured dead end, kept so nobody re-tries it.
 *
 * The obvious companion to the budget is `deny: ['subagent', ...]` on the same filter. It does not
 * work, and the harness says so in one line. `tools.restrict()` validates every denied name against
 * the GLOBAL tool registry and refuses the whole request when one is unknown — measured verbatim:
 *
 *   delegation error: tools.restrict() names unknown global tools "subagent", "subagent_codex",
 *   "subagent_claude_code", "list_subagent_models", "wait_agent", "ralph"; known global tools:
 *   ask_user_question, click, … , subagent_fork, … , verify_task, workflow, write
 *
 * Two things follow, and the second one inverts the guess this list was built on:
 *   1. `toolFilter` cannot name the tool that caused the runaway. `subagent` is registered by THIS
 *      preset's own composition, so it is not a global tool and no filter can restrict it.
 *   2. `subagent_fork`, `list_agents`, `send_message`, `interrupt_agent`, `workflow`, `verify_task`
 *      and `delegate_batch` ARE global — and every one of them is already gone under `allow: []`,
 *      so a `deny` list of global names would be pure decoration anyway.
 *
 * A wrong name does not degrade gracefully either: with such a list, EVERY task failed in ~5 ms
 * (`attempts=3`, `0.0 s of local compute`) — the whole delegation path, not just one task. So the
 * correct filter is exactly `{ allow: [] }`, and the self-test pins that (a `deny` key reappearing
 * here is a regression, not a hardening).
 */

/** Replaces the `deployment:persona-prefix` section for the child only. */
const CHILD_PERSONA = process.env.DSH_LOCAL_CHILD_PERSONA
  || 'You are a fast local tool model. You transform the exact text you are given and return only'
  + ' the requested output. You have no tools and cannot read files: everything you need is in'
  + ' the message. Never explain, never apologize, never add a code fence unless asked.'

/** Bounded cap for one delegation. Keeps a runaway generation from eating the local GPU. */
const MAX_TOKENS = Number(process.env.DSH_LOCAL_MAX_TOKENS || 4096)

/**
 * The wall-clock budget for ONE child run — the bound the harness does not provide.
 *
 * `maxTokens` caps a single *generation*, which is not the same thing as capping a *run*: the child
 * is a full agent loop, and a child that answers in many short steps never trips the token ceiling.
 * The running build offers no step cap at all (no `maxSteps`/`maxTurns`/`maxIterations` anywhere in
 * `app.asar`), and `retries` bounds re-runs rather than the steps inside one run. So before this
 * budget existed, the only thing above a looping child was the operator: measured 2026-10-02, one
 * `count-a` delegation re-delegated itself 169 times, ran 341 s and burned 24,500 output tokens
 * (prompt growing ~193 tokens per step, 1,970 → 34,627) until a human aborted the turn.
 *
 * Past the budget the child is aborted AND the plugin stops waiting for it — both, because a child
 * that ignores its signal must not be able to keep the caller hostage. The verdict then reuses the
 * path that already exists ("a run that did not finish is not an answer") and is marked
 * unretryable: running out of budget reproduces, so a retry would buy the same waste again.
 *
 * Read per call rather than at module load, so the self-test can drive it without a second process.
 */
function childBudgetMs() {
  const raw = Number(process.env.DSH_DELEGATE_TIMEOUT_MS || 120000)
  return Number.isFinite(raw) && raw > 0 ? raw : 120000
}

/** Bounded slice of a raw answer that per-task results carry back to the caller. */
const OUTPUT_CHARS = Number(process.env.DSH_DELEGATE_OUTPUT_CHARS || 500)

const ENGINE_HOST = process.env.DSH_STRATA_HOST || '127.0.0.1'
const ENGINE_PORT = Number(process.env.DSH_STRATA_PORT || 8080)

const VERIFY_PYTHON = process.env.DSH_VERIFY_PYTHON || process.env.CVISION_PYTHON || 'python'

/**
 * THE single kind table. Every surface that names a kind is generated from it — the `verify_task`
 * description, the `verify.kind` enums, and the self-test's check that the three agree.
 *
 * WHY IT IS A TABLE AND NOT THREE STRINGS. It was three strings, and they drifted: `checkInner`
 * implemented SIXTEEN kinds while the `verify_task` description still listed ELEVEN, so the five
 * kinds that need no expected answer — `covers`, `subset_of`, `union_eq`, `citation`,
 * `python_check`, the ones this preset exists for — were invisible to the model that has to choose
 * a verifier. The GUIDE section mentioned them; the tool contract did not. A capability the caller
 * cannot see is a capability that is not there.
 */
export const VERIFIER_KINDS = [
  { id: 'json_equals', summary: 'deep equality against `expected`' },
  { id: 'json_order', summary: 'array of objects ordered by `field`, compared with `expected`' },
  { id: 'set_eq', summary: 'set equality (order and duplicates irrelevant)' },
  { id: 'count', summary: 'array length equals `expected`' },
  { id: 'schema', summary: 'JSON Schema subset: type/enum/required/properties/items/additionalProperties/minLength/maxLength/pattern/minimum/maximum' },
  { id: 'exact', summary: 'trimmed string equality' },
  { id: 'regex', summary: 'pattern match' },
  { id: 'contains', summary: 'literal substring' },
  { id: 'all_of', summary: 'every needle in `expected` (array, or "a|b") appears, case- and punctuation-insensitive' },
  { id: 'compile', summary: 'the answer parses as JavaScript' },
  { id: 'python_exec', summary: 'extracts a `def` block and runs it with your `assert` expressions' },
  { id: 'covers', summary: 'every needle appears (optionally only in `field`) — judged on what the answer OMITS, so the needles may be machine-derived' },
  { id: 'subset_of', summary: 'nothing outside the allowed set `expected`: an invented element FAILS, a missing one does not' },
  { id: 'union_eq', summary: "the answer's groups cover `expected` exactly — a partition is validated from the universe alone" },
  { id: 'citation', summary: 'every claim carries {file,line,quote} and the quote really occurs at that line; the claim itself is never judged' },
  { id: 'python_check', summary: 'an arbitrary Python invariant, with the answer bound to `answer`' },
]

/** The ids, in table order. */
export const VERIFIER_KIND_IDS = VERIFIER_KINDS.map((k) => k.id)

/** One line naming every kind, generated so it cannot drift from the implementation. */
export const KIND_LINE = VERIFIER_KIND_IDS.join(' | ')

const GUIDE =
  '\n\nLocal delegation (the local engine costs 0 API tokens; use it wherever a machine can check the answer):\n'
  + `- Route: subagent provider="${LOCAL_PROVIDER}" model="${LOCAL_MODEL}" — a local Strata engine on ${ENGINE_HOST}:${ENGINE_PORT}. `
  + 'Prefer delegate_batch, which delegates and verifies in one call.\n'
  + '- The entry condition is NOT "this looks easy", it is "I can write a deterministic checker". Verifiable shapes: code that runs (python_exec/compile), '
  + 'JSON structure (json_equals/json_order/schema/set_eq/count), exact values, regex, contains.\n'
  + '- FIVE KINDS NEED NO ANSWER FROM YOU, which is what unlocks the work the comparison kinds could not reach: '
  + '`covers` (the answer is judged on what it OMITS, so the needles can be machine-derived and a summary becomes checkable), '
  + '`subset_of` (nothing outside an allowed set — the anti-hallucination check), '
  + '`union_eq` (a partition is validated from the universe alone, so a classification task needs no human to say which item goes where), '
  + '`citation` (the claim is never judged, only its evidence: every claim carries {file,line,quote} and the quote must really occur at that line — this is how a summary or a code review becomes gateable), '
  + 'and `python_check` (an arbitrary Python invariant; the answer arrives as `answer`). Reach for these FIRST: they remove the old precondition of computing the answer before delegating.\n'
  + '- PROVE THE GATE BEFORE SPENDING THE DELEGATION. Pass `prove: true` (or `prove: {positive, semantics, ...}`) on a task and the plugin mutates a known-good answer and requires the verifier to reject every mutant, '
  + 'AND to accept the known-good answer itself — a gate that rejects everything is as powerless as one that accepts everything, and is refused the same way. `prove: true` derives the positive example from `expected` for most kinds; `python_exec`/`python_check`/`regex`/`citation` need `prove.positive` from you. '
  + 'A gate with no discriminating power is reported instead of being used, so a decorative verifier costs nothing. Switch on a `semantics` flag only when the mutant really is wrong — a false alarm condemns a gate that is fine.\n'
  + '- READ THE WHOLE ANSWER. A task verdict that PASSes carries only a short `raw` echo; when the answer is longer, the plugin WRITES the full answer to disk and returns `outputFile` (with bytes and sha256). Read that file instead of re-running the task — a delegated child has no tools, so it cannot write the file itself.\n'
  + '- WHEN THE LOCAL MODEL NEEDS TOOLS, CALL `subagent` INSTEAD OF `delegate_batch`. `delegate_batch` strips every tool on purpose (measured: a 13,023-token prompt with the inherited schemas and a 5,606 ms cold prefill, versus 2,780 tokens stripped), because its shapes are text in / text out. '
  + 'But a delegated child DOES inherit tools — the harness supplies the loop — measured on `strata/qwen3.8-flash-next-coder-iq1_m`: a child used `read` and answered from the file, and used `glob` then `read_image` to read a picture correctly, both for 0 API tokens. '
  + 'So for "open these files" or "read this screenshot", call `subagent(provider="strata", model="qwen3.8-flash-next-coder-iq1_m")`: ~5.6 s for the first step, then ~1 s per step through the prefix cache. It carries NO verifier, so gate the answer with `verify_task` yourself before using it.\n'
  + '- `subagent` DEFAULTS TO BACKGROUND (`run_in_background: true`): it then returns an id immediately, NOT the answer, and the result arrives later as a separate message. Do NOT poll `job_output` or `job_list` with that id — background jobs are a different mechanism and report `unknown job`. '
  + 'Pass `run_in_background: false` to block and get the result in the tool result instead. A delegated child never sees this guide, so if you delegate a task that itself calls `subagent`, put "pass run_in_background: false" in that task prompt. '
  + 'Measured: the same nested call left unset returned an id and the child burned two steps on `job_output` then `job_list`; with `run_in_background: false` it returned the answer directly.\n'
  + '- RED LINE on the tool-using path: delegate STEPS a machine can check (reading files, reading a screenshot, a reading-shaped answer), never a SEQUENCE OF ACTIONS. A click has no deterministic judge — a wrong click is silent, and no verifier can tell it from a right one. Perception can be delegated; agency cannot.\n'
  + '- For a LARGE job, plan on DeepSeek first, batch the mechanical parts to local (extraction, transforms, dedupe, formatting, per-item summaries, candidate scoring), '
  + 'then SYNTHESIZE on DeepSeek. DeepSeek keeps multi-step reasoning, anything causal across files, and every word the user reads.\n'
  + '- Give the local model the INPUT INLINE, never "go read the file": it has no tools. Keep each task under ~40 input rows / ~4K chars and split anything larger — '
  + 'a 47-row extraction task degenerated into a verbatim loop here, and the same input split in two passed first try.\n'
  + '- CAPACITY IS NOT ADVERTISED — QUERY IT, DO NOT GUESS. `list_subagent_models` returns only a name and the advertised reasoning efforts: no context window, no output cap, no modalities. '
  + 'The engine reports its real window as `max_context` at GET http://' + ENGINE_HOST + ':' + ENGINE_PORT + '/health, and the per-call output cap is `maxTokens` (beside `contextWindow`) on the provider model row in the profile patch. '
  + 'The engine NEVER truncates: it fails with 400 `CONTEXT_WINDOW_EXCEEDED` when `prompt + maxTokens > window`, so the hard prompt ceiling is `contextWindow - maxTokens`, and a window the harness over-reports also stops compaction from ever firing. '
  + 'Measured: a 65536 window with the adapter default maxTokens of 32768 put that ceiling at 32768 and failed a 32987-token request. Check these before sizing a large delegation.\n'
  + '- EVERY CHILD RUN HAS A WALL-CLOCK BUDGET (`DSH_DELEGATE_TIMEOUT_MS`, default 120 s). Past it the run is aborted and reported as `the child did not finish`, and it is NOT retried, because a budget overrun reproduces. This exists because a child can loop: measured, one re-delegated its own task 169 times and ran 341 s before a human aborted it. A task that legitimately needs longer than the budget is a task that is too big — split it, or raise that value.\n'
  + '- Ask for raw output. The local model is correct but polite: it wraps answers in ``` fences even when told not to. The verifiers strip fences, but writing '
  + '"Output ONLY raw JSON, no code fence, no prose" in the prompt still measurably reduces noise.\n'
  + '- VISION IS LOCAL TOO. The engine is multimodal: give a task an `images: ["<absolute path>"]` and the local model reads the picture (OCR, screenshots, '
  + '"what digit is in the shape", "describe sky/sun/ground"). Check a reading answer with `all_of` (expected = the strings that must all appear, case and '
  + 'punctuation ignored). Measured on this engine: 0.7-2.5 s per image, and image tokens scale with resolution (256x192 to 78, 640x480 to 330, 1280x960 to '
  + '1002), so a repeat of the same image is nearly free through the prefix cache while a NEW large image costs a second or two of prefill. Two traps: the '
  + 'engine reads images but cannot draw or edit them, and it cannot see anything you did not hand it - you must resolve the path and pass it. '
  + 'Name the shape the way it GEOMETRICALLY is: a square bounding box drawn as a circle is not an ellipse, and a correct reading that says "circle" must not '
  + 'be failed by a checker looking for "ellipse".\n'
  + '- A local result is usable only after its verifier PASSES. On FAIL or on any doubt, escalate to DeepSeek. Never ship an unverified local answer. `delegate_batch` does NOT resend on a FAIL by default (`retries: 0`): a blind resend never recovered in 10 same-shape observations, and since this engine is not reproducible a resend is a different sample, not a replay. If a task failed, the fix is to CHANGE something — split the input, or ask it differently — because a second identical failure means the task was not local-shaped.\n'
  + '- DO NOT DELEGATE ORDERING BY SEMANTIC VERSION OR BY MIXED NUMERIC TEXT. Measured 5 runs each: sorting 3.10, 2.7, 3.9, 2.11 locally failed 5/5 with thinking off and 3/5 with it on, '
  + 'always the same way — "3.10" is parsed as the number 3.1 and then sorted lexicographically to [2.11, 2.7, 3.1, 3.9]. That is a 1.89-bit quantisation limit, not a prompt bug. '
  + 'Plain string and plain number ordering is fine. RE-MEASURED 2026-10-02 on this same engine id: 2/2 tasks of exactly this shape came back CORRECT on the first attempt, so treat this as a caution rather than a prohibition — the gate catches a wrong order and the attempt costs only local compute.\n'
  + '- The engine is already greedy (temperature 0) by default, which is the measured 6/6 sampling configuration. Do not introduce a `sampling` block in the engine config: '
  + 'sampled delegations failed a verifier one run in six. But GREEDY HERE DOES NOT MEAN REPRODUCIBLE: re-measured 2026-10-02, one identical prompt sent three times produced different answers every time (86/50/44, 321/46/57 and 49/48/54 generated tokens across three probe tasks), so a retry is a DIFFERENT answer, not a replay — never assume a re-send returns what the last one did.\n'
  + '- Thinking buys nothing here. Extraction, counting, arithmetic and runnable code all passed 5/5 with the thinking channel off, and turning it on only tripled latency. '
  + 'This deployment already has it OFF at the engine (shared setting `reasoning_effort: none`; measured 471 -> 210 generated tokens and 5.99 s -> 2.28 s on one identical task). If delegations still feel slow, split the task - never weaken the checker.\n'
  + '- LANGUAGE: the local model mixes Chinese and English in prose (~60% Chinese) and drifts further if the engine is resampled. That is fine for intermediate results — '
  + 'DeepSeek owns the final wording. Reply to the user in the SAME language as their message (default: 中文/Chinese), including any narration about what you delegated.'

/**
 * What a DELEGATED CHILD is told, instead of the GUIDE.
 *
 * The original design sent the child NOTHING, on the assumption recorded at the section below: "a
 * delegated child has no tools here and cannot delegate". Raising `maxDepth` above 1 falsified that
 * assumption — a child CAN call `subagent` now — and the measured failures are exactly the ones these
 * three notes prevent: one child spent 33 of its 34 steps cycling between a hallucinated tool and a
 * depth-refused `subagent`, and another burned two steps polling `job_output`/`job_list` with a
 * subagent id it had been handed. Each of those costs a 120 s budget that is never retried.
 *
 * Deliberately ~10x shorter than GUIDE: a child needs the two traps, not the routing policy, which
 * belongs to its parent.
 */
const CHILD_GUIDE =
  '\n\nYou are a DELEGATED CHILD; your parent owns the routing policy. Three notes are yours:\n'
  + '- Do the task you were given. Do NOT call `list_subagent_models` to hunt for another model to hand the work to, and do not try to re-delegate the whole task — you are the executor.\n'
  + '- If a step genuinely needs `subagent`, pass `run_in_background: false` so the answer returns in the tool result. With the default (true) it returns only an id, and polling `job_output`/`job_list` for that id fails with `unknown job`. Measured: a child that left it unset burned two steps that way.\n'
  + '- Never poll `job_output`/`job_list` for a subagent id.\n'

function textOf(result) {
  return (result?.output ?? [])
    .filter((b) => b && b.type === 'text')
    .map((b) => b.text ?? '')
    .join('')
}

/**
 * Lightweight JSON Schema subset validator: type / enum / string length and pattern / numeric
 * bounds / required / properties / items / additionalProperties.
 *
 * `additionalProperties: false` and `minLength` must not be ignored: a schema that reads as
 * strict must not accept payloads it forbids, or the gate is decorative.
 */
export function matchesSchema(value, schema) {
  if (schema == null || typeof schema !== 'object' || Array.isArray(schema)) return true
  const t = schema.type
  if (t) {
    // JSON Schema semantics: 'integer' is a number with no fractional part, so 1.5 must FAIL it.
    if (t === 'integer') {
      if (typeof value !== 'number' || !Number.isInteger(value)) return false
    } else if (t === 'number') {
      if (typeof value !== 'number') return false
    } else if (t === 'array') {
      if (!Array.isArray(value)) return false
    } else if (t === 'object') {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
    } else if (t === 'null') {
      if (value !== null) return false
    } else if (typeof value !== t) {
      return false
    }
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((x) => JSON.stringify(x) === JSON.stringify(value))) return false
  if (typeof value === 'string') {
    if (Number.isInteger(schema.minLength) && value.length < schema.minLength) return false
    if (Number.isInteger(schema.maxLength) && value.length > schema.maxLength) return false
    if (typeof schema.pattern === 'string') {
      try { if (!new RegExp(schema.pattern).test(value)) return false } catch { return false }
    }
  }
  if (typeof value === 'number') {
    if (typeof schema.minimum === 'number' && value < schema.minimum) return false
    if (typeof schema.maximum === 'number' && value > schema.maximum) return false
  }
  if (Array.isArray(value)) {
    return schema.items ? value.every((x) => matchesSchema(x, schema.items)) : true
  }
  if (value !== null && typeof value === 'object') {
    const props = schema.properties && typeof schema.properties === 'object' ? schema.properties : {}
    for (const [key, sub] of Object.entries(props)) {
      if (key in value && !matchesSchema(value[key], sub)) return false
    }
    if (Array.isArray(schema.required)) for (const key of schema.required) if (!(key in value)) return false
    const extra = schema.additionalProperties
    if (extra === false) {
      for (const key of Object.keys(value)) if (!(key in props)) return false
    } else if (extra && typeof extra === 'object') {
      for (const key of Object.keys(value)) if (!(key in props) && !matchesSchema(value[key], extra)) return false
    }
  }
  return true
}

function deepEqual(a, b) {
  if (a === b) return true
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => deepEqual(x, b[i]))
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const ka = Object.keys(a); const kb = Object.keys(b)
    return ka.length === kb.length && ka.every((k) => deepEqual(a[k], b[k]))
  }
  return false
}

/**
 * Strip a Markdown code fence before parsing.
 *
 * The local model is correct but polite: asked for "only JSON", Strata still answers inside
 * ```json ... ```. A raw JSON.parse() then reports `invalid JSON` and a *correct* answer is
 * scored as a failure, which escalates to DeepSeek and costs more than not delegating at all.
 * Every JSON-parsing verifier goes through this; bare answers are unaffected.
 */
function stripFence(s) {
  const m = String(s ?? '').match(/```(?:json|JSON)?\s*([\s\S]*?)```/)
  return (m ? m[1] : String(s ?? '')).trim()
}

/**
 * Case- and punctuation-insensitive form, for the `all_of` reading verifier.
 *
 * Whitespace collapses to nothing rather than to a single space so that a line break inside a
 * needle ("MEN WALK ON MOON" read back as two lines) cannot fail on layout alone.
 */
function squash(s) {
  return String(s ?? '').toLowerCase().replace(/[^0-9a-z\u4e00-\u9fff]+/g, '')
}

/**
 * A 1.89-bit local model degenerates into a verbatim loop under long inputs. The caller must be
 * told to split the input, not left hunting for a formatting bug: without this, a looping answer
 * is reported as `invalid JSON`, which reads like the model formatted badly.
 */
export function looksDegenerate(s) {
  const text = String(s ?? '')
  if (text.length < 200) return false
  const lines = text.split('\n').map((l) => l.trim()).filter((l) => l !== '')
  if (lines.length >= 8) {
    let longest = 1
    let run = 1
    for (let i = 1; i < lines.length; i += 1) {
      if (lines[i] === lines[i - 1]) {
        run += 1
        if (run > longest) longest = run
      } else run = 1
    }
    if (longest >= 6) return true
  }
  if (text.length > 4000 && new Set(lines).size / Math.max(lines.length, 1) < 0.15) return true
  return false
}

/** True when something is listening on host:port. */
export function probeEngine(host, port, timeoutMs = 1500) {
  return new Promise((resolve) => {
    let socket
    try {
      socket = net.connect({ host, port })
    } catch {
      resolve(false)
      return
    }
    const settle = (ok) => {
      try { socket.destroy() } catch { /* already closed */ }
      resolve(ok)
    }
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => { settle(true) })
    socket.once('timeout', () => { settle(false) })
    socket.once('error', () => { settle(false) })
  })
}

/**
 * Fail fast when the local engine is down.
 *
 * Without this, a dead engine produces N identical `invalid JSON` verdicts and the caller has to
 * guess why. One actionable error is worth more than N misleading rows.
 */
export async function assertLocalEngine() {
  if (process.env.DSH_SKIP_ENGINE_PROBE === '1') return
  if (await probeEngine(ENGINE_HOST, ENGINE_PORT)) return
  throw new Error(
    `delegate_batch: local engine unreachable at ${ENGINE_HOST}:${ENGINE_PORT} — start Strata first, `
    + 'otherwise every task fails with a misleading `invalid JSON`. Set DSH_SKIP_ENGINE_PROBE=1 to bypass.',
  )
}

/**
 * Read image files into the wire form the harness attachment store admits.
 *
 * WHY AN ATTACHMENT AND NOT AN OpenAI `image_url` BLOCK. The obvious shape is wrong here, and it
 * fails SILENTLY, which is the worst way to be wrong:
 *
 *   - `@deepseek-ai/dsh-llm-pi-ai` serializes a user message by switching on `block.type`. Its only
 *     image case is `case "image"`, and it reads `block.attachment.attachmentId`, then emits
 *     `{type:"image", data:<base64 from the attachment store>, mimeType}` on the wire;
 *   - a block of any other type hits `default: break` and is DROPPED without an error.
 *
 * So `{type:'image_url', image_url:{...}}` produces a request with no picture in it at all, and the
 * local model answers about whatever else is in the prompt. This was observed live before the shape
 * was corrected. The harness's canonical block is `{type:'image', attachment: ref}` where `ref` is a
 * durable `{attachmentId, mediaType, width, height}` from `ctx.attachments`.
 *
 * Split in two on purpose: `inspectImages` is pure and synchronous, so a bad path or extension is
 * reported BEFORE any file is read or any attachment is committed. A half-stored batch would leave
 * unreachable objects behind and still have to fail.
 */
const IMAGE_MIME = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.gif': 'image/gif',
}

export function inspectImages(images) {
  const list = Array.isArray(images) ? images : (images == null || images === '' ? [] : [images])
  return list.map((p) => {
    const file = String(p)
    const mediaType = IMAGE_MIME[extname(file).toLowerCase()]
    if (!mediaType) {
      throw new Error(
        `images: unsupported image extension for ${JSON.stringify(file)} — use one of `
        + `${Object.keys(IMAGE_MIME).join(', ')}`,
      )
    }
    let buf
    try {
      buf = readFileSync(file)
    } catch (e) {
      throw new Error(`images: cannot read ${JSON.stringify(file)} — ${String((e && e.message) || e)}`)
    }
    // `data` must be RAW BYTES — not base64. The running build declares
    // `SaveImageAttachment { data: Uint8Array; mediaType: ImageMediaType; name?: string }`, and the
    // store decodes that buffer with sharp. Base64 belongs to the RPC *wire* format, where the
    // harness's own adapter converts it (`saveInput` does `data: decodeBase64(image.data)`) before
    // calling this same `saveImages`. This module used to hand the wire shape straight to the store,
    // so EVERY `images:` delegation died with `Unsupported or malformed image data.` in ~0 ms and
    // never reached the engine — and the self-test pinned base64, so a green suite hid it.
    // Buffer is a Uint8Array, so this satisfies the declared type as-is.
    return { data: buf, mediaType, name: basename(file) }
  })
}

/**
 * Write a delegated answer to disk, verbatim, and describe it.
 *
 * The id is slugged into the filename so a batch is readable by eye, and truncated so a long
 * description cannot exceed the path limit. Nothing is deleted afterwards: the file IS the
 * deliverable the caller reads, and a retry overwrites its own file rather than adding another.
 */
export function persistAnswer(dir, id, text) {
  const safe = String(id).replace(/[^0-9A-Za-z._-]+/g, '_').replace(/^[._]+/, '').slice(0, 64) || 'task'
  const file = join(dir, `${safe}.txt`)
  writeFileSync(file, text, 'utf8')
  return {
    file,
    bytes: Buffer.byteLength(text, 'utf8'),
    sha256: createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16),
  }
}

/**
 * The verification gate, with a contract: it NEVER throws.
 *
 * A verifier that throws is worse than one that fails: delegate_batch calls this for every task,
 * and an escaping exception aborts the WHOLE batch, so task 1 could kill tasks 2..N. Every kind
 * guards its own input type and the switch is wrapped, so any surprise lands as
 * `{ok:false, detail}` — a payload the gate simply rejects.
 */
export function check(kind, content, expected, field, asserts) {
  try {
    return checkInner(kind, content, expected, field, asserts)
  } catch (e) {
    return {
      ok: false,
      detail: `${kind} verifier raised ${(e && e.constructor && e.constructor.name) || 'Error'}: ${String((e && e.message) || e)}`,
    }
  }
}

/** Lowercase, punctuation to spaces: the form boundary matching needs (squash removes the spaces). */
function spaced(s) {
  return String(s ?? '').toLowerCase().replace(/[^0-9a-z\u4e00-\u9fff]+/g, ' ').trim()
}

function isWordChar(ch) {
  return ch !== '' && /[0-9a-z_]/.test(ch)
}

/**
 * Does `needle` occur in `haystack`, which the caller has already lowercased?
 *
 * `wholeWord` is the difference between an answer that mentions `read` and one that only mentions
 * `reader` — measured on this preset: without it, `covers` for the needle `read` PASSED the answer
 * "the reader is here", which is exactly the false PASS this whole design exists to prevent. Word
 * characters are ASCII (letters, digits, underscore); CJK text has no word boundaries, so a Chinese
 * needle still matches inside a longer run, which is the honest behaviour rather than a fake promise.
 */
export function matchesNeedle(haystack, needle, wholeWord) {
  const text = String(haystack ?? '')
  const n = String(needle ?? '')
  if (n === '') return false
  if (!wholeWord) return text.includes(n)
  let from = 0
  for (;;) {
    const at = text.indexOf(n, from)
    if (at < 0) return false
    const before = at === 0 ? '' : text[at - 1]
    const after = text[at + n.length] === undefined ? '' : text[at + n.length]
    if (!isWordChar(before) && !isWordChar(after)) return true
    from = at + 1
  }
}

/**
 * The needles a text gate looks for, and whether each must stand alone.
 *
 * `expected` may be an array, a `"a|b"` string, or an object `{needles: [...], wholeWord: true}`.
 * The object form exists because "mentions `read`" and "mentions `reader`" are different questions
 * and a gate that cannot state the difference is a gate that passes the wrong answer. `wholeWord` is
 * opt-in, so every existing caller keeps the lenient behaviour it asked for.
 */
export function needleSpec(expected) {
  let raw = expected
  if (typeof raw === 'string') { try { raw = JSON.parse(raw) } catch { raw = String(raw) } }
  const list = (value) => {
    if (Array.isArray(value)) return value.map(String).filter((s) => s !== '')
    if (typeof value === 'string' && value !== '') {
      return (value.includes('|') ? value.split('|') : [value]).map(String).filter((s) => s !== '')
    }
    return []
  }
  if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) {
    return { needles: list(raw.needles), wholeWord: raw.wholeWord === true }
  }
  return { needles: list(raw), wholeWord: false }
}

function checkInner(kind, content, expected, field, asserts) {
  const c = String(content ?? '')
  if (c.trim() === '') return { ok: false, detail: 'empty output (engine offline, or the task returned nothing)' }
  if (looksDegenerate(c)) return { ok: false, detail: 'degenerate repetition — split the input and retry' }
  const cj = stripFence(c)                                  // fence-tolerant form, for JSON kinds
  const E = (s) => { try { return JSON.parse(String(s)) } catch { return s } }
  switch (kind) {
    case 'json_equals': {
      let d; try { d = JSON.parse(cj) } catch { return { ok: false, detail: 'invalid JSON' } }
      return { ok: deepEqual(d, E(expected)), detail: 'json_equals' }
    }
    case 'json_order': {
      let d; try { d = JSON.parse(cj) } catch { return { ok: false, detail: 'invalid JSON' } }
      if (!Array.isArray(d)) return { ok: false, detail: 'not an array — json_order needs a JSON array of objects' }
      if (!field) return { ok: false, detail: 'json_order needs a field name (the property to order by)' }
      const order = Array.isArray(E(expected)) ? E(expected) : []
      return { ok: deepEqual(d.map((x) => x[field]), order), detail: `order=${JSON.stringify(d.map((x) => x[field]))}` }
    }
    case 'set_eq': {
      let d; try { d = JSON.parse(cj) } catch { return { ok: false, detail: 'invalid JSON' } }
      if (!Array.isArray(d)) return { ok: false, detail: 'not an array — set_eq compares sets of array elements' }
      const expRaw = E(expected)
      if (!Array.isArray(expRaw)) return { ok: false, detail: 'expected is not an array — set_eq needs an array to compare against' }
      const s1 = JSON.stringify([...new Set(d)].sort()); const s2 = JSON.stringify([...new Set(expRaw)].sort())
      return { ok: s1 === s2, detail: 'set_eq' }
    }
    case 'count': {
      let d; try { d = JSON.parse(cj) } catch { return { ok: false, detail: 'invalid JSON' } }
      if (!Array.isArray(d)) return { ok: false, detail: 'not an array' }
      const n = Number(expected)
      return { ok: d.length === n, detail: `len=${d.length}` }
    }
    case 'schema': {
      let d; try { d = JSON.parse(cj) } catch { return { ok: false, detail: 'invalid JSON' } }
      const sch = E(expected)
      // A malformed schema must not make every payload PASS: a gate that cannot fail is worse
      // than no gate.
      if (sch === null || typeof sch !== 'object' || Array.isArray(sch)) {
        return { ok: false, detail: 'schema is not a JSON object — a malformed schema must not pass' }
      }
      return { ok: matchesSchema(d, sch), detail: 'schema' }
    }
    case 'exact': return { ok: c.trim() === String(expected).trim(), detail: `got=${JSON.stringify(c.trim())}` }
    case 'regex': {
      // An invalid pattern is a caller mistake, not a model failure: FAIL it with a readable
      // reason instead of letting `new RegExp` throw out of the gate.
      let re
      try { re = new RegExp(String(expected)) } catch (e) { return { ok: false, detail: 'invalid regex pattern: ' + String((e && e.message) || e) } }
      return { ok: re.test(c), detail: 'regex' }
    }
    case 'contains': return { ok: c.includes(String(expected)), detail: 'contains' }
    case 'all_of': {
      // The reading-shaped verifier. A vision or transcript answer is prose: "The digit 3 is inside
      // the circle" must pass a check for "3" and "circle" without the caller knowing the exact
      // phrasing, and must fail for an object that is not in the image at all.
      //
      // punctuation and case are squashed, so "MEN WALK ON MOON" matches "Men walk on moon." and a
      // hyphenated "e-mail" matches "email". `contains` stays strict on purpose: the two are
      // different questions and a caller who wants the strict one should not be silently given the
      // lenient one.
      const spec = needleSpec(expected)
      if (spec.needles.length === 0) {
        return { ok: false, detail: 'all_of needs an array of strings (or a string), and a non-empty one at that' }
      }
      const low = squash(c)
      const spacedText = spec.wholeWord ? spaced(c) : ''
      const missing = spec.needles.filter((n) => (spec.wholeWord
        // `wholeWord` needs the SPACES that `squash` throws away, or "the reader" fuses into
        // "thereader" and a legitimate needle of `reader` fails its own boundary test.
        ? !matchesNeedle(spacedText, spaced(n), true)
        : !low.includes(squash(String(n)))))
      return {
        ok: missing.length === 0,
        detail: missing.length === 0
          ? `all ${spec.needles.length} found`
          : `${missing.length}/${spec.needles.length} not found: ${JSON.stringify(missing.map(String))}`,
      }
    }
    case 'compile': {
      // stripFence first: a fenced ```js block is not parseable and would be a false FAIL.
      try { new Function(stripFence(c)); return { ok: true, detail: 'compile-ok (js)' } }
      catch (e) { return { ok: false, detail: String((e && e.message) || e) } }
    }
    case 'python_exec': {
      const cf = stripFence(c)
      const code = extractDefBlock(cf)
      if (code === null) return { ok: false, detail: 'no def block' }
      const asrt = Array.isArray(asserts) ? asserts : (expected ? [expected] : [])
      if (asrt.length === 0) return { ok: false, detail: 'python_exec needs asserts' }
      const dir = mkdtempSync(join(tmpdir(), 'local-delegate-verify-'))
      const f = join(dir, 'probe.py')
      try {
        writeFileSync(f, code + '\n' + asrt.map((a) => `assert (${a})`).join('\n'), 'utf8')
        execFileSync(VERIFY_PYTHON, [f], { stdio: 'pipe' })
        return { ok: true, detail: 'python-exec ok' }
      } catch (e) { return { ok: false, detail: String((e && e.message) || e) } }
      finally { try { rmSync(dir, { recursive: true, force: true }) } catch { /* best effort */ } }
    }
    case 'covers': {
      // Coverage-shaped: every needle in `expected` must appear in the answer, and the answer is
      // judged on what it FAILS to mention rather than on an exact match. This is the shape that
      // makes a summary verifiable WITHOUT knowing the summary — the needles are the symbol names
      // a machine already extracted, so the caller never has to compute the answer first.
      const spec = needleSpec(expected)
      if (spec.needles.length === 0) {
        return { ok: false, detail: 'covers needs an array of needles (or a "a|b" string), and a non-empty one at that' }
      }
      let haystack = c
      if (field) {
        // With a field name the needle must appear in that field of a JSON payload, so a needle
        // that merely shows up in prose elsewhere cannot satisfy it.
        let d; try { d = JSON.parse(cj) } catch { return { ok: false, detail: 'invalid JSON (covers with a field needs a JSON payload)' } }
        const rows = Array.isArray(d) ? d : [d]
        const values = []
        for (const row of rows) {
          const value = row !== null && typeof row === 'object' ? row[field] : undefined
          if (typeof value === 'string') values.push(value)
          else if (Array.isArray(value)) for (const item of value) if (typeof item === 'string') values.push(item)
        }
        haystack = values.join('\n')
      }
      const low = haystack.toLowerCase()
      const missing = spec.needles.filter((n) => !matchesNeedle(low, String(n).toLowerCase(), spec.wholeWord))
      return {
        ok: missing.length === 0,
        detail: missing.length === 0
          ? `all ${spec.needles.length} covered`
          : `${missing.length}/${spec.needles.length} missing: ${JSON.stringify(missing.slice(0, 6).map(String))}`,
      }
    }
    case 'subset_of': {
      // Anti-hallucination, and deliberately one-directional: every element the answer reports must
      // come from a set the caller can compute, while a MISSING element is not an error. This is
      // the shape of "which of these are X", where a subset is the right answer — and it is the
      // check that the measured function-index gate lacked.
      let d; try { d = JSON.parse(cj) } catch { return { ok: false, detail: 'invalid JSON' } }
      if (!Array.isArray(d)) return { ok: false, detail: 'not an array — subset_of compares a set of elements' }
      const allowed = E(expected)
      if (!Array.isArray(allowed)) return { ok: false, detail: 'expected is not an array — subset_of needs the allowed set' }
      const key = (v) => JSON.stringify(v)
      const pool = new Set(allowed.map(key))
      const stray = d.filter((item) => !pool.has(key(item)))
      return {
        ok: stray.length === 0,
        detail: stray.length === 0
          ? `all ${d.length} inside the allowed set`
          : `${stray.length} outside the allowed set: ${JSON.stringify(stray.slice(0, 4))}`,
      }
    }
    case 'union_eq': {
      // The partition verifier, and the one that removes `expected` from a classification task.
      // The answer groups items into buckets; the CALLER supplies only the universe, so no human
      // has to know which bucket each item belongs to. The union must equal the universe exactly,
      // so a dropped item, an invented one, and an item filed twice are all caught.
      let d; try { d = JSON.parse(cj) } catch { return { ok: false, detail: 'invalid JSON' } }
      const universe = E(expected)
      if (!Array.isArray(universe)) return { ok: false, detail: 'expected is not an array — union_eq needs the universe to cover' }
      let groups
      if (Array.isArray(d)) groups = d
      else if (d !== null && typeof d === 'object') groups = Object.values(d)
      else return { ok: false, detail: 'the answer is neither an array of groups nor an object of groups' }
      const flat = []
      for (const group of groups) {
        if (!Array.isArray(group)) return { ok: false, detail: 'every group must be an array' }
        for (const item of group) flat.push(item)
      }
      const key = (v) => JSON.stringify(v)
      const got = new Set(flat.map(key))
      const want = new Set(universe.map(key))
      const missing = [...want].filter((item) => !got.has(item))
      const extra = [...got].filter((item) => !want.has(item))
      const duplicated = flat.length !== got.size
      const clean = missing.length === 0 && extra.length === 0 && !duplicated
      return {
        ok: clean,
        detail: clean
          ? `union equals the universe (${got.size} items, none filed twice)`
          : `missing ${missing.length}${missing.length ? `: ${JSON.stringify(missing.slice(0, 3))}` : ''}; `
            + `extra ${extra.length}${extra.length ? `: ${JSON.stringify(extra.slice(0, 3))}` : ''}`
            + `${duplicated ? '; an item is filed under two groups' : ''}`,
      }
    }
    case 'citation': {
      // Citation gating: the CLAIM is never judged, only its evidence. A model may still be wrong
      // about what the code means, but it may not invent a quotation, point at the wrong line, or
      // spend one quotation on several claims. `expected` is a JSON config, not an answer:
      //   { root?, files?, lines?, minQuote?, tolerance?, minClaims?, require? }
      let d; try { d = JSON.parse(cj) } catch { return { ok: false, detail: 'invalid JSON — citation needs a JSON report' } }
      const cfg = E(expected)
      if (cfg === null || typeof cfg !== 'object' || Array.isArray(cfg)) {
        return { ok: false, detail: 'citation needs a JSON config object as expected' }
      }
      if (!Array.isArray(d)) return { ok: false, detail: 'the report must be a JSON array of claims' }
      const minClaims = Number.isInteger(cfg.minClaims) ? cfg.minClaims : 1
      if (d.length < minClaims) return { ok: false, detail: `only ${d.length} claims, fewer than the required ${minClaims}` }
      const minQuote = Number.isInteger(cfg.minQuote) ? cfg.minQuote : 20
      const tolerance = Number.isInteger(cfg.tolerance) ? cfg.tolerance : 1
      // How many consecutive lines the quotation may cover. The subject of a code review is a
      // STATEMENT, and a statement is rarely one line: single-line matching reported every
      // multi-line citation as fabricated — measured before this: a two-line quotation from a
      // two-line file FAILED as `the evidence is fake`. `span: 1` restores the strict rule.
      const span = Number.isInteger(cfg.span) && cfg.span > 0 ? cfg.span : 3
      const root = typeof cfg.root === 'string' && cfg.root !== '' ? cfg.root : process.cwd()
      const allowed = Array.isArray(cfg.files) ? cfg.files.map(String) : null
      const window = Array.isArray(cfg.lines) && cfg.lines.length === 2 ? cfg.lines : null
      const used = new Set()
      const covered = new Set()
      for (const claim of d) {
        if (claim === null || typeof claim !== 'object' || Array.isArray(claim)) return { ok: false, detail: 'every claim must be an object' }
        const evidence = claim.evidence
        if (evidence === null || typeof evidence !== 'object' || Array.isArray(evidence)) {
          return { ok: false, detail: 'every claim needs an evidence object' }
        }
        const file = evidence.file
        const line = evidence.line
        if (typeof file !== 'string' || file === '') return { ok: false, detail: 'evidence.file must be a non-empty string' }
        if (!Number.isInteger(line)) return { ok: false, detail: `evidence.line must be an integer (got ${JSON.stringify(line)})` }
        if (allowed !== null && !allowed.includes(file)) return { ok: false, detail: `evidence.file ${JSON.stringify(file)} is not in the allowed list` }
        if (window !== null && (line < window[0] || line > window[1])) {
          return { ok: false, detail: `evidence.line ${line} is outside the given range ${window[0]}-${window[1]}` }
        }
        let text
        try { text = readFileSync(join(root, file), 'utf8') } catch { return { ok: false, detail: `evidence.file cannot be read: ${file}` } }
        const lines = text.split(/\r?\n/)
        if (line < 1 || line > lines.length) return { ok: false, detail: `evidence.line ${line} is outside ${file} (${lines.length} lines)` }
        const needle = squashText(evidence.quote)
        if (needle.length < minQuote) return { ok: false, detail: `the quote is too short (${needle.length} < ${minQuote} characters)` }
        let found = false
        for (let offset = -tolerance; offset <= tolerance && !found; offset += 1) {
          const start = line - 1 + offset
          if (start < 0 || start >= lines.length) continue
          // The window STARTS where the claim says it does and may continue forward, so a quotation
          // still has to begin on the cited line (±tolerance) rather than anywhere nearby.
          for (let width = 1; width <= span && start + width <= lines.length && !found; width += 1) {
            if (squashText(lines.slice(start, start + width).join(' ')).includes(needle)) found = true
          }
        }
        if (!found) return { ok: false, detail: `the evidence is fake: the quote is not in ${file}:${line} (±${tolerance})` }
        const ref = `${file}|${line}|${needle}`
        if (used.has(ref)) return { ok: false, detail: `the same evidence is reused for more than one claim (${file}:${line})` }
        used.add(ref)
        covered.add(file)
      }
      const notCovered = (Array.isArray(cfg.require) ? cfg.require.map(String) : []).filter((file) => !covered.has(file))
      if (notCovered.length > 0) return { ok: false, detail: `coverage is too thin, never cited: ${notCovered.join(', ')}` }
      return { ok: true, detail: `${d.length} claims, every citation resolves, ${covered.size} file(s) covered` }
    }
    case 'python_check': {
      // The general escape hatch: an arbitrary invariant, written by the caller, actually run.
      // `expected` is Python source; the answer is bound to `answer` (parsed JSON when it parses,
      // otherwise the raw text) and the run must raise nothing. This is what removes the old
      // precondition that the caller already knows the answer — any property expressible in Python
      // is now checkable, including ones no enumerated kind could state.
      const source = String(E(expected) ?? '')
      if (source.trim() === '') return { ok: false, detail: 'python_check needs Python source as expected' }
      const dir = mkdtempSync(join(tmpdir(), 'local-delegate-check-'))
      const answerFile = join(dir, 'answer.txt')
      const scriptFile = join(dir, 'check.py')
      try {
        writeFileSync(answerFile, stripFence(c), 'utf8')
        writeFileSync(scriptFile, [
          'import json, sys',
          'raw = open(sys.argv[1], encoding="utf-8").read()',
          'try:',
          '    answer = json.loads(raw)',
          'except Exception:',
          '    answer = raw',
          source,
        ].join('\n'), 'utf8')
        execFileSync(VERIFY_PYTHON, [scriptFile, answerFile], { stdio: 'pipe' })
        return { ok: true, detail: 'python-check ok' }
      } catch (e) {
        // An empty stderr is a TRUTHY Buffer, so `(e.stderr) || (e.message)` selected it and the
        // verdict read `python-check FAIL — ` with no reason at all. Prefer stderr only when it has
        // something in it; otherwise fall back to the message.
        const stderr = String((e && e.stderr) || '')
        const text = stderr.trim() !== '' ? stderr : String((e && e.message) || e)
        return { ok: false, detail: text.split('\n').filter((l) => l.trim() !== '').slice(-3).join(' | ') || 'the check raised' }
      } finally { try { rmSync(dir, { recursive: true, force: true }) } catch { /* best effort */ } }
    }
    default: return { ok: false, detail: `unknown kind ${kind}` }
  }
}

/* ------------------------------------------------------------------------------------------ *
 * Mutation proof: a gate is trusted only after the machine has tried to break it.
 *
 * The old design asked "does the gate accept the right answer?" — which a gate that accepts
 * EVERYTHING answers perfectly. This asks the other half: given a known-good answer, the machine
 * derives known-bad ones and requires the gate to reject every one. That number is discriminating
 * power, and it needs no human to know the true answer, which is what removes the precondition
 * that kept so much work on DeepSeek.
 * ------------------------------------------------------------------------------------------ */

/**
 * Whitespace-normalized form, for comparing a quotation with the line it cites.
 *
 * An optional "NN:" prefix is dropped, so a model that copies the line number into `quote` is
 * being obedient rather than wrong — the excerpt it was handed carries them.
 */
function squashText(s) {
  return String(s ?? '').replace(/^\s*\d+\s*[:：]\s*/, '').replace(/\s+/g, ' ').trim()
}

/**
 * The proof's positive example now comes from `positiveFromVerify`, which derives one for every kind
 * where that is possible (twelve of the sixteen, against three before: `json_equals`/`set_eq`/`exact`
 * were the only kinds whose `expected` doubled as an answer). A kind that cannot be derived —
 * `python_exec`, `python_check`, `regex`, `citation` — still needs `prove.positive` from the caller.
 */

/** The fabricated name: deterministic and unmistakable. */
const INVENTED_NAME = 'zzforgeinvented0001'

/**
 * Every mutable position in a JSON value, addressed by a path, root first.
 * @param value - the answer.
 * @param path - internal.
 * @param out - internal.
 * @returns the positions.
 */
export function collectMutationTargets(value, path = [], out = []) {
  if (Array.isArray(value)) {
    out.push({ path, kind: 'array', value })
    value.forEach((item, index) => collectMutationTargets(item, [...path, index], out))
  } else if (value !== null && typeof value === 'object') {
    out.push({ path, kind: 'object', value })
    for (const [key, item] of Object.entries(value)) collectMutationTargets(item, [...path, key], out)
  } else if (typeof value === 'number') out.push({ path, kind: 'number', value })
  else if (typeof value === 'boolean') out.push({ path, kind: 'boolean', value })
  else if (typeof value === 'string') out.push({ path, kind: 'string', value })
  return out
}

function setMutationPath(root, path, value) {
  if (path.length === 0) return value
  let cursor = root
  for (const key of path.slice(0, -1)) cursor = cursor[key]
  cursor[path[path.length - 1]] = value
  return root
}

/**
 * The operators. Each is one way an answer can be wrong, and each carries the reason it is wrong
 * so a leaked mutant reports itself as a defect rather than as an id.
 *
 * `semantics` is the caller's honest judgement about whether the mutant is really wrong: an
 * operator that would produce an EQUIVALENT mutant must stay off, because a false alarm condemns
 * a gate that is actually fine.
 */
export const MUTATION_OPERATORS = [
  { id: 'empty', kinds: ['array', 'object'], reason: 'the answer was emptied',
    apply: (a, t) => setMutationPath(JSON.parse(JSON.stringify(a)), t.path, Array.isArray(t.value) ? [] : {}) },
  { id: 'truncate', kinds: ['array'], reason: 'the answer was cut short',
    apply: (a, t) => t.value.length < 2 ? undefined : setMutationPath(JSON.parse(JSON.stringify(a)), t.path, t.value.slice(0, Math.max(1, Math.floor(t.value.length / 2)))) },
  { id: 'dropItem', kinds: ['array'], reason: 'one entry was dropped',
    apply: (a, t) => { if (t.value.length === 0) return undefined; const n = t.value.slice(); n.splice(0, 1); return setMutationPath(JSON.parse(JSON.stringify(a)), t.path, n) } },
  { id: 'duplicateItem', kinds: ['array'], reason: 'one entry was counted twice',
    apply: (a, t) => { if (t.value.length === 0) return undefined; const n = t.value.slice(); n.splice(1, 0, JSON.parse(JSON.stringify(t.value[0]))); return setMutationPath(JSON.parse(JSON.stringify(a)), t.path, n) } },
  { id: 'addLookalike', kinds: ['array'], semantics: 'hasIdentityField',
    reason: 'an entry was invented from a name that really occurs in the source (the hardest kind to catch)',
    apply: (a, t, ctx) => {
      const field = ctx.identityField
      const pool = ctx.closedVocabulary
      if (typeof field !== 'string' || !Array.isArray(pool) || t.value.length === 0) return undefined
      const sample = t.value[0]
      if (sample === null || typeof sample !== 'object' || typeof sample[field] !== 'string') return undefined
      const seen = new Set(t.value.map((item) => item && item[field]))
      const name = pool.find((candidate) => !seen.has(candidate))
      if (name === undefined) return undefined
      const next = t.value.slice()
      next.push({ ...JSON.parse(JSON.stringify(sample)), [field]: name })
      return setMutationPath(JSON.parse(JSON.stringify(a)), t.path, next)
    } },
  { id: 'perturbNumber', kinds: ['number'], reason: 'a number was changed',
    apply: (a, t) => setMutationPath(JSON.parse(JSON.stringify(a)), t.path, t.value + 1) },
  { id: 'shiftFar', kinds: ['number'], reason: 'a position was moved far from where it belongs',
    apply: (a, t) => setMutationPath(JSON.parse(JSON.stringify(a)), t.path, t.value + 1000) },
  { id: 'invertBoolean', kinds: ['boolean'], reason: 'a boolean was flipped',
    apply: (a, t) => setMutationPath(JSON.parse(JSON.stringify(a)), t.path, !t.value) },
  { id: 'perturbString', kinds: ['string'], semantics: 'closedVocabulary',
    reason: 'a name was altered by one character',
    apply: (a, t) => t.value === '' ? undefined : setMutationPath(JSON.parse(JSON.stringify(a)), t.path, `${t.value}x`) },
  { id: 'invent', kinds: ['string'], semantics: 'closedVocabulary',
    reason: 'a name was invented: it exists nowhere in the source',
    apply: (a, t) => t.value === INVENTED_NAME ? undefined : setMutationPath(JSON.parse(JSON.stringify(a)), t.path, INVENTED_NAME) },
  // The mutant a TEXT-shaped gate needs. `covers` and `all_of` are judged on what the answer omits,
  // so the way to break them is to leave one needle out — and the needles come from the verifier's
  // own `expected`, injected by proveGate. Without this, a prose positive has NO applicable operator
  // (the string operators are gated behind `closedVocabulary`), the mutator finds nothing to break,
  // and every omission-checking gate reports "nothing was proven" — i.e. the kinds that need no
  // expected answer were the exact ones that could not be proven at all.
  { id: 'omitNeedle', kinds: ['string'],
    reason: 'something that had to be mentioned was left out',
    apply: (a, t, ctx) => {
      const needles = Array.isArray(ctx.needles) ? ctx.needles.map(String).filter((n) => n !== '') : []
      if (needles.length === 0) return undefined
      const text = String(t.value)
      for (const needle of needles) {
        if (text.includes(needle)) {
          return setMutationPath(JSON.parse(JSON.stringify(a)), t.path, text.split(needle).join(''))
        }
      }
      return undefined
    } },
  { id: 'relabelEnum', kinds: ['string'], semantics: 'hasEnums',
    reason: 'an enum label was swapped for a legal but wrong one',
    apply: (a, t, ctx) => {
      const offers = (ctx.enumAlternatives || {})[t.path[t.path.length - 1]]
      if (!Array.isArray(offers)) return undefined
      const replacement = offers.find((offer) => offer !== t.value)
      return replacement === undefined ? undefined : setMutationPath(JSON.parse(JSON.stringify(a)), t.path, replacement)
    } },
  { id: 'dropField', kinds: ['object'], reason: 'a required field was dropped',
    apply: (a, t) => { const keys = Object.keys(t.value); if (keys.length === 0) return undefined; const n = JSON.parse(JSON.stringify(t.value)); delete n[keys[0]]; return setMutationPath(JSON.parse(JSON.stringify(a)), t.path, n) } },
  { id: 'addField', kinds: ['object'], semantics: 'closedShape', reason: 'a field that does not belong was added',
    apply: (a, t) => { const n = JSON.parse(JSON.stringify(t.value)); n.forgeExtra = 1; return setMutationPath(JSON.parse(JSON.stringify(a)), t.path, n) } },
  { id: 'wrapFence', whole: true, semantics: 'textAnswer', reason: 'the JSON was wrapped in a code fence',
    apply: (a) => '```json\n' + JSON.stringify(a) + '\n```' },
]

/**
 * KINDS WHOSE GATE DOES NOT LOOK AT THE ANSWER'S STRUCTURE.
 *
 * `positiveFromVerify` already refuses to DERIVE a positive for exactly these four (see its doc
 * comment): each carries a program or an evidence report that only the caller can write. They must be
 * excluded from structural MUTATION too, and `citation` is the reason this constant exists. A citation
 * positive is JSON, so the generic operators DID fire on it — `perturbNumber` changed a line number,
 * `dropField` removed a field — and the citation gate correctly ignores both, because it judges whether
 * the quoted text really sits at that file:line. The proof therefore reported
 * `accepts 2/6 wrong answers` against a gate that was fine: a false alarm arriving by a different door
 * than the `semantics` flags guard. Skipping mutation turns those four into an honest
 * "cannot be certified automatically", which is what the caller needs to hear.
 */
export const UNSTRUCTURED_KINDS = ['python_exec', 'python_check', 'regex', 'citation']

/**
 * Derive the known-bad answers from one known-good one.
 * @param answer - the known-good answer.
 * @param config - { operators?, semantics?, identityField?, closedVocabulary?, enumAlternatives? }.
 * @returns deterministic mutants: [{id, reason, path, payload}], none equal to the answer.
 */
export function mutateAnswer(answer, config = {}) {
  const enabled = new Set(Array.isArray(config.operators) && config.operators.length > 0
    ? config.operators
    : MUTATION_OPERATORS.map((operator) => operator.id))
  const semantics = config.semantics || {}
  const targets = collectMutationTargets(answer)
  const mutants = []
  for (const operator of MUTATION_OPERATORS) {
    if (!enabled.has(operator.id)) continue
    if (operator.semantics !== undefined && semantics[operator.semantics] !== true) continue
    const candidates = operator.whole === true
      ? [{ path: [], kind: 'whole', value: answer }]
      : targets.filter((target) => operator.kinds.includes(target.kind))
    // Every candidate is tried, not just the first: an operator whose real target sits deeper
    // (an enum field, an array carrying an identity field) would otherwise be silently skipped.
    let path
    let payload
    for (const candidate of candidates) {
      const result = operator.apply(answer, candidate, config)
      if (result === undefined) continue
      if (deepEqual(result, answer)) continue
      path = candidate.path
      payload = result
      break
    }
    if (payload === undefined) continue
    mutants.push({ id: operator.id, reason: operator.reason, path, payload })
  }
  return mutants
}

/** The needles a text gate looks for, read out of its own `expected` (object form included). */
export function needlesFrom(kind, expected) {
  if (kind !== 'covers' && kind !== 'all_of') return []
  return needleSpec(expected).needles
}

/** A value that may arrive as a JSON string (tool args), as a JSON value (a task object), or as text. */
export function positiveValue(value) {
  if (typeof value !== 'string') return value
  try { return JSON.parse(value) } catch { return value }
}

/**
 * A minimal instance that satisfies the schema subset `matchesSchema` implements, or null when the
 * schema is too loose to derive one.
 *
 * Returning an instance that does NOT satisfy the schema is not dangerous: `proveGate` verifies the
 * positive, so a bad derivation is reported as a failed proof instead of silently blessing the gate.
 */
export function minimalInstance(schema) {
  if (schema === null || typeof schema !== 'object' || Array.isArray(schema)) return null
  if (Array.isArray(schema.enum) && schema.enum.length > 0) return schema.enum[0]
  const t = schema.type
  if (t === 'object' || (t === undefined && schema.properties)) {
    const props = schema.properties && typeof schema.properties === 'object' ? schema.properties : {}
    const out = {}
    for (const key of (Array.isArray(schema.required) ? schema.required : [])) {
      const sub = key in props
        ? props[key]
        : (schema.additionalProperties && typeof schema.additionalProperties === 'object' ? schema.additionalProperties : null)
      out[key] = sub ? minimalInstance(sub) : 'x'
      if (out[key] === null) return null
    }
    return out
  }
  if (t === 'array') {
    if (!schema.items) return ['x']
    const item = minimalInstance(schema.items)
    return item === null ? null : [item]
  }
  if (t === 'integer') return Number.isFinite(schema.minimum) ? Math.ceil(schema.minimum) : 1
  if (t === 'number') return Number.isFinite(schema.minimum) ? schema.minimum : 1
  if (t === 'string') {
    const n = Number.isInteger(schema.minLength) && schema.minLength > 1 ? schema.minLength : 1
    const s = 'x'.repeat(n)
    if (typeof schema.pattern === 'string') {
      try { if (!new RegExp(schema.pattern).test(s)) return null } catch { return null }
    }
    return s
  }
  if (t === 'boolean') return true
  if (t === 'null') return null
  return null
}

/**
 * A known-good answer derived from the verifier's own configuration, for the kinds where that is
 * possible — which is what makes `prove` usable by default instead of opt-in.
 *
 * THREE SHAPES OF `expected` are handled, and all three are already in this module: it IS the answer
 * (`json_equals`/`set_eq`/`exact`), it is a constraint the answer must satisfy (`count`/`schema`/
 * `union_eq`/`subset_of`), or it is what a text gate must find (`covers`/`all_of`). `json_order` is
 * the interesting one: `expected` is the desired order of the `field` values, so the answer is that
 * same sequence of objects.
 *
 * `undefined` means "not derivable": `python_exec`, `python_check`, `regex` and `citation` carry a
 * program or an evidence report, and only the caller can write those.
 */
export function positiveFromVerify(verify) {
  const v = verify || {}
  const kind = String(v.kind || '')
  const raw = positiveValue(v.expected)
  switch (kind) {
    case 'json_equals': case 'set_eq': case 'exact':
      return raw                                            // expected IS the answer
    case 'json_order': {
      if (!Array.isArray(raw) || typeof v.field !== 'string' || v.field === '') return undefined
      return raw.map((value) => ({ [v.field]: value }))
    }
    case 'count': {
      const n = Number(v.expected)
      return Number.isInteger(n) && n >= 0 ? Array.from({ length: n }, (_, i) => `item ${i + 1}`) : undefined
    }
    case 'contains':
      return typeof raw === 'string' && raw !== '' ? raw : undefined
    case 'covers': case 'all_of': {
      const needles = needlesFrom(kind, v.expected)
      return needles.length > 0 ? needles.join('\n') : undefined
    }
    case 'subset_of':
      return Array.isArray(raw) ? raw.slice() : undefined    // the whole allowed set is inside itself
    case 'union_eq':
      return Array.isArray(raw) && raw.length > 0 ? [raw.slice()] : undefined   // one bucket holding the universe
    case 'schema': {
      const instance = minimalInstance(raw)
      return instance === null ? undefined : instance
    }
    case 'compile':
      return 'const answer = 1'
    default:
      return undefined
  }
}

/** Why a proof failed, in the caller's terms. Shared so both tools say the same thing. */
export function proofWhy(proof, positiveSource) {
  // ORDER MATTERS AND IT IS LOAD-BEARING. A gate that rejects the RIGHT answer is the most serious
  // finding there is, so it is checked FIRST. A kind with no structural operator (UNSTRUCTURED_KINDS)
  // ALWAYS reports total === 0, so testing total first would hide a broken gate behind an innocent
  // "cannot certify this kind" — and the caller would ship a gate that fails every delegation.
  if (proof.positiveOk === false) {
    if (positiveSource === 'derived') {
      // Two very different faults land here, and the caller cannot tell them apart without being told:
      // the derivation may be impossible (a schema with no instance, a regex `x` cannot satisfy), or the
      // gate may be rejecting the right answer. Say so, and say how to settle it.
      return `the verifier does not accept the positive example the plugin DERIVED from \`expected\` (${proof.positiveDetail}) — `
        + 'either the constraint has no instance the plugin can build (an unsatisfiable schema, a pattern it cannot satisfy), '
        + 'or the gate rejects the right answer. Pass prove.positive explicitly to tell the two apart.'
    }
    return `the verifier does not accept the caller's positive example (${proof.positiveDetail}) — it rejects the right answer `
      + 'too, so every delegation through it would fail and escalate'
  }
  if (proof.total === 0) {
    // Telling the caller "nothing to break" for a kind that can NEVER be broken automatically sends it
    // hunting for a bug that is not there. Name those kinds (single source: UNSTRUCTURED_KINDS).
    if (UNSTRUCTURED_KINDS.includes(proof.kind)) {
      return `\`${proof.kind}\` has no structural mutant operator and its positive example cannot be derived, so `
        + '`prove` can never certify it — that is expected, not a defect. Check it by hand instead: the gate must '
        + 'PASS a known-good answer and REJECT a deliberately wrong one.'
    }
    return 'the mutator found nothing to break, so nothing was proven'
  }
  // The only combination left is an ACCEPTED positive whose mutants were all rejected, and callers filter
  // `proven` before asking why — so leakage is the only honest thing left to name.
  return `the verifier accepts ${proof.leaked.length}/${proof.total} wrong answers: ${proof.leaked.map((l) => l.id).join(', ')}`
}

/**
 * Prove one gate: it must accept the good answer AND reject every mutant.
 *
 * @param options - { kind, expected, field, asserts, positive, config? }.
 * @returns { total, leaked, positiveOk, positiveDetail, discrimination, proven }.
 */
export function proveGate(options) {
  const o = options || {}
  const config = { ...(o.config || {}) }
  // `covers`/`all_of` are the kinds whose positive is prose, and prose has no applicable operator
  // unless the mutator knows what the gate was looking for. Those needles come from `expected`, so
  // the caller never has to know them (see the `omitNeedle` operator).
  if (!Array.isArray(config.needles) || config.needles.length === 0) {
    const needles = needlesFrom(o.kind, o.expected)
    if (needles.length > 0) config.needles = needles
  }
  // Four kinds get NO structural mutation: their gate does not read the answer's structure, so every
  // mutant the generic operators can build for them is either meaningless or actively misleading —
  // `citation` demonstrated the latter. They fall through to `total === 0`, which is the honest report.
  const mutants = UNSTRUCTURED_KINDS.includes(String(o.kind || '')) ? [] : mutateAnswer(o.positive, config)
  const leaked = []
  for (const mutant of mutants) {
    const text = typeof mutant.payload === 'string' ? mutant.payload : JSON.stringify(mutant.payload)
    const verdict = check(o.kind, text, o.expected, o.field, o.asserts)
    if (verdict.ok === true) leaked.push({ id: mutant.id, reason: mutant.reason, detail: verdict.detail })
  }
  // THE OTHER HALF OF THE PROOF, and it was missing. Rejecting every mutant is worthless if the gate
  // also rejects the RIGHT answer: a gate that fails everything scores discrimination 1.0, and every
  // delegation through it burns local compute and then escalates — strictly worse than no gate. The
  // weak half was measured before this check existed: `json_equals` against a deliberately wrong
  // `expected`, and a `python_check` whose source always raises, both reported proven:true.
  const positiveText = typeof o.positive === 'string' ? o.positive : JSON.stringify(o.positive)
  const positiveVerdict = check(o.kind, positiveText, o.expected, o.field, o.asserts)
  return {
    kind: String(o.kind || ''),
    total: mutants.length,
    leaked,
    positiveOk: positiveVerdict.ok === true,
    positiveDetail: positiveVerdict.detail,
    discrimination: mutants.length === 0 ? 0 : (mutants.length - leaked.length) / mutants.length,
    // Zero mutants is NOT a pass: it means the mutator found nothing to break, so nothing was proven.
    proven: mutants.length > 0 && leaked.length === 0 && positiveVerdict.ok === true,
  }
}

/**
 * Build the exact SubagentStartRequest for one delegated task. Pure, so the self-test can pin
 * both branches without restarting the process to change an environment variable.
 *
 * The three things worth pinning are (a) the local route, (b) that NO reasoning effort is sent
 * unless one is configured — the `strata` provider rejects an effort it does not advertise, and
 * that rejection happens before the request leaves the harness — and (c) that the child's tool
 * surface is stripped, because the local model cannot call tools and the schemas are most of
 * its prompt.
 */
export async function buildChildRequest(opts) {
  const o = opts || {}
  // `images` is read and committed eagerly so a bad path is reported by the caller rather than
  // escaping as an exception out of `subagents.start` (which would abort the whole batch — the
  // contract the verifier gate already keeps). `childRequest` turns `imageError` into a per-task FAIL.
  let blocks = []
  let imageError = ''
  try {
    const inputs = inspectImages(o.images)
    if (inputs.length > 0) {
      const attachments = o.attachments
      if (!attachments || typeof attachments.saveImages !== 'function') {
        throw new Error(
          'images: the attachment service is not mounted, so a picture cannot be put into the child '
          + 'request. (The pi-ai adapter only serializes `{type:"image", attachment}` blocks.)',
        )
      }
      // One batch call: the store validates count/aggregate-byte/media limits before committing any
      // member, so a refused batch publishes nothing.
      const refs = await attachments.saveImages(inputs)
      blocks = refs.map((attachment) => ({ type: 'image', attachment }))
    }
  } catch (e) {
    imageError = String((e && e.message) || e)
  }
  // `o.prompt` is the historical string form, kept because the self-test and any external caller
  // pin it; `o.text` is the same thing under the name the content block uses.
  const text = String(o.text ?? o.prompt ?? '')
  return {
    label: o.label,
    parent: o.parent,
    prompt: [{ type: 'text', text }, ...blocks],
    agentOptions: {
      provider: o.provider || LOCAL_PROVIDER,
      model: o.model || LOCAL_MODEL,
      ...(o.maxTokens > 0 ? { maxTokens: o.maxTokens } : {}),
      ...(o.reasoningEffort ? { reasoningEffort: o.reasoningEffort } : {}),
    },
    ...(o.stripTools ? { toolFilter: { allow: [] } } : {}),
    ...(o.persona ? { persona: o.persona } : {}),
    signal: o.signal,
    ...(imageError ? { imageError } : {}),
  }
}

/** The request this preset actually sends, from the resolved module configuration. */
export function childRequest(exec, id, prompt, images, attachments, signal) {
  return buildChildRequest({
    label: id,
    parent: exec?.agent,
    prompt,
    images,
    attachments,
    // The caller's signal by default; `delegate_batch` passes this attempt's budget-combined signal.
    signal: signal ?? exec?.signal,
    provider: LOCAL_PROVIDER,
    model: LOCAL_MODEL,
    reasoningEffort: REASONING_EFFORT,
    maxTokens: MAX_TOKENS,
    stripTools: STRIP_CHILD_TOOLS,
    persona: CHILD_PERSONA,
  })
}

/**
 * The leading `def ...` block of an answer, or null.
 *
 * The obvious one-liner is a trap:
 *
 *     /def\s+\w+\s*\([\s\S]*?(?=\n(?!\s)|\Z)/
 *
 * JavaScript has no `\Z`. An unrecognized escape in a regex is an IDENTITY escape, so `\Z`
 * matches a literal "Z" — the alternative never fires, and for the ordinary shape (a definition
 * whose indented body runs to the end of the answer) the lookahead can never be satisfied at
 * all. The verifier then reported `no def block` for perfectly good code. This was carried over
 * from an earlier implementation and only surfaced when this suite added a positive
 * `python_exec` case; a line scan has no such trap.
 */
function extractDefBlock(text) {
  const lines = String(text ?? '').split('\n')
  const start = lines.findIndex((l) => /^\s*def\s+\w+\s*\(/.test(l))
  if (start < 0) return null
  let end = lines.length
  for (let i = start + 1; i < lines.length; i += 1) {
    if (lines[i].trim() === '') continue
    // a non-blank, non-indented line ends the function and starts whatever follows it
    if (!/^\s/.test(lines[i])) { end = i; break }
  }
  return lines.slice(start, end).join('\n').replace(/\s+$/, '')
}

/**
 * Register a tool so the preset can be unmounted cleanly.
 *
 * `ctx.effect` ties the registration to this plugin's lifetime; registering bare leaves no
 * disposer, so a preset recompose would leave the old tools behind. The fallback exists because
 * the self-test drives `apply` with a minimal fake ctx — without it the test could not exercise
 * the real registration path at all.
 */
function registerTool(ctx, def) {
  if (typeof ctx.effect === 'function') return ctx.effect(() => ctx.tools.register(def))
  return ctx.tools.register(def)
}

export function apply(ctx) {
  registerTool(ctx, {
    name: 'verify_task',
    description:
      'Deterministic verification gate for a delegated result (0 API tokens). '
      + `kind: ${KIND_LINE}. `
      + 'Use after delegating a verifiable subtask to the local model, and escalate to DeepSeek when ok===false. '
      + 'The last five need NO expected answer from you: `covers` (judged on what the answer omits, so the needles may '
      + 'be machine-derived), `subset_of` (nothing outside the allowed set), `union_eq` (a partition, validated from the '
      + 'universe alone), `citation` (the claim is never judged, only whether the quotation is real), `python_check` '
      + '(an arbitrary Python invariant). all_of (expected = an array, or "|"-separated string) is the reading-shaped '
      + 'kind: it passes when every needle appears in the answer, ignoring case and punctuation, which is how a '
      + 'vision/OCR answer is checked. '
      + 'covers/all_of also accept expected as {"needles": [...], "wholeWord": true} when a needle must not be satisfied '
      + 'by a longer word (`read` vs `reader`). citation takes expected as a config object: '
      + '{root, files, lines, minQuote, tolerance, span, minClaims, require}. '
      + 'Pass `prove` to prove the gate before spending a delegation: the plugin derives known-bad answers from a '
      + 'known-good one and refuses a gate that accepts any of them, or one that rejects the good answer itself.',
    parameters: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: VERIFIER_KIND_IDS, description: `one of: ${KIND_LINE}` },
        content: { type: 'string', description: 'the result text to check' },
        expected: { type: 'string', description: 'expected value (json/string/number/regex/schema) as needed' },
        field: { type: 'string', description: 'for json_order: the field name to order by; for covers: the field the needles must appear in' },
        asserts: { type: 'array', items: { type: 'string' }, description: 'for python_exec: assertion expressions to append' },
        prove: {
          type: 'object',
          additionalProperties: true,
          description:
            'Prove this gate before using it: {positive? (the known-good answer; defaults to a value derived from '
            + '`expected` and `kind` when that is possible), operators?, semantics? (hasIdentityField/hasEnums/'
            + 'closedVocabulary/closedShape/textAnswer), identityField?, closedVocabulary?, enumAlternatives?}. '
            + 'ok===false with "no power" means the gate is decorative or rejects the right answer — fix it, do not use it.',
        },
      },
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object', properties: { ok: { type: 'boolean' }, detail: { type: 'string' } }, additionalProperties: false },
      render: (_a, v) => [{ type: 'text', text: `verify: ${v.ok ? 'PASS ✅' : 'FAIL ❌'} — ${v.detail}` }],
    },
    timeoutMs: 30000,
    execute: async (args) => {
      const kind = String(args.kind)
      if (args.prove && typeof args.prove === 'object') {
        const fromCaller = args.prove.positive !== undefined
        const positive = fromCaller
          ? positiveValue(args.prove.positive)
          : positiveFromVerify({ kind, expected: args.expected, field: args.field })
        if (positive === undefined) {
          return {
            ok: false,
            detail: 'prove: no positive example — pass prove.positive (the known-good answer), or use a kind whose '
              + 'positive is derivable from `expected`.',
          }
        }
        const proof = proveGate({
          kind, expected: args.expected, field: args.field, asserts: args.asserts, positive, config: args.prove,
        })
        if (!proof.proven) return { ok: false, detail: `prove: gate has no power — ${proofWhy(proof, fromCaller ? 'caller' : 'derived')}` }
      }
      return check(kind, args.content, args.expected, args.field, args.asserts)
    },
  })

  registerTool(ctx, {
    name: 'delegate_batch',
    description:
      'Delegate self-contained, deterministic-verifiable subtasks to the LOCAL model (0 API tokens) and verify each one. '
      + 'Each task: {description, prompt, images?, prove?, verify?{kind,expected,field,asserts}}. Returns per-task {id, ok, detail, output, attempts}. '
      + 'Runs sequentially on one local engine. Keep the mechanical parts here and the synthesis on DeepSeek. '
      + `verify.kind is one of: ${KIND_LINE}. `
      + 'For a PASS whose answer is longer than the echoed slice, the FULL answer is written to `outputFile` (with bytes '
      + 'and sha256): read that file instead of redoing the work — a delegated child has no tools here, so it cannot write it itself. '
      + 'A task with `images` (absolute paths to png/jpg/jpeg/webp/gif) sends that picture to the local engine, which is '
      + 'multimodal: use it for OCR, screenshot reading and "what shape/number/colour" questions. The file is read and '
      + 'registered as a harness attachment by the CALLER, so a relative path means what the caller\'s cwd says. The local '
      + 'engine reads images only — it cannot draw, and it cannot see a file it was not handed.',
    parameters: {
      type: 'object',
      properties: {
        tasks: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              description: { type: 'string' },
              prompt: { type: 'string' },
              images: {
                type: 'array',
                items: { type: 'string' },
                description: 'paths to image files to send with this task (png/jpg/jpeg/webp/gif)',
              },
              prove: {
                type: 'object',
                additionalProperties: true,
                description:
                  'Prove the verifier before spending a delegation: the plugin derives known-bad answers from a '
                  + 'known-good one and requires the verifier to reject every one. A gate that accepts any mutant is '
                  + 'reported instead of running the task, so a decorative verifier costs nothing. '
                  + '{positive? (defaults to verify.expected for json_equals/set_eq/exact), operators?, semantics? '
                  + '(hasIdentityField/hasEnums/closedVocabulary/closedShape/textAnswer), identityField?, '
                  + 'closedVocabulary?, enumAlternatives?}',
              },
              verify: {
                type: 'object',
                additionalProperties: true,
                properties: {
                  kind: { type: 'string', enum: VERIFIER_KIND_IDS, description: `one of: ${KIND_LINE}` },
                  expected: { type: 'string', description: 'expected value (json/string/number/regex/schema/config) as needed' },
                  field: { type: 'string', description: 'for json_order: the field to order by; for covers: the field the needles must appear in' },
                  asserts: { type: 'array', items: { type: 'string' }, description: 'for python_exec: assertion expressions to append' },
                },
              },
            },
            additionalProperties: false,
          },
        },
        retries: { type: 'integer', description: 'retry a task whose verifier FAILED, up to 3 times (default 0: report the FAIL and escalate instead — measured, no retry ever recovered in 10 same-shape observations, and a looping retry can cost a whole DSH_DELEGATE_TIMEOUT_MS budget)' },
      },
      required: ['tasks'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          results: { type: 'array', items: { type: 'object', additionalProperties: true } },
        },
        additionalProperties: false,
      },
      render: (_a, v) => {
        const lines = (v.results || []).map((r) => {
          // The per-task facts a caller needs to judge the path itself: how long the local model
          // took, whether a retry was spent, and whether the child actually finished.
          const facts = [
            r.attempts > 1 ? `attempts=${r.attempts}` : '',
            Number.isFinite(r.ms) ? `${r.ms} ms` : '',
            r.stop && r.stop !== 'completed' && r.stop !== 'unknown' ? `stop=${r.stop}` : '',
          ].filter(Boolean).join(', ')
          const head = `${r.id}: ${r.ok === null ? 'NO_VERIFIER' : (r.ok ? 'PASS ✅' : 'FAIL ❌')} — ${r.detail || ''}${facts ? ` (${facts})` : ''}`
          // Echo a bounded slice of the raw answer — verbatim, not whitespace-collapsed, so a JSON
          // payload stays readable — plus the path of the full answer when it was longer than the
          // echo. The verdict line alone makes the caller pay for a model call it can never read.
          const body = r.output ? `\n    raw: ${String(r.output)}` : ''
          const saved = r.outputFile
            ? `\n    full: ${r.outputFile} (${r.bytes} bytes, sha256 ${r.sha256})`
            : (r.outputFileError ? `\n    full: NOT SAVED — ${r.outputFileError}` : '')
          return head + body + saved
        })
        // The batch footer carries the two numbers that decide whether this path is worth using:
        // wall time spent locally, and whether retrying ever RECOVERED anything. A retry that never
        // recovers is a purchase made twice, and this is where that becomes visible instead of
        // being an article of faith.
        const rows = v.results || []
        // Sum what the path ACTUALLY cost, retries included. `r.ms` is the last attempt only, so
        // summing it understates a retried task by the whole cost of the attempts it threw away —
        // measured 2026-10-02: a batch that really spent ~253 s printed `240.1 s of local compute`,
        // and the 13 s it hid was exactly the retried attempts. `r.spentMs` accumulates them.
        const costOf = (r) => (Number.isFinite(r.spentMs) ? r.spentMs : (Number.isFinite(r.ms) ? r.ms : 0))
        const totalMs = rows.reduce((n, r) => n + costOf(r), 0)
        const passed = rows.filter((r) => r.ok === true).length
        const retried = rows.filter((r) => (r.attempts || 0) > 1).length
        const recovered = rows.filter((r) => (r.attempts || 0) > 1 && r.ok === true).length
        const footer = rows.length
          ? `— ${passed}/${rows.length} PASS · ${(totalMs / 1000).toFixed(1)} s of local compute`
            + (retried ? ` · ${retried} retried, ${recovered} recovered` : '')
          : ''
        return [{ type: 'text', text: [...lines, footer].filter(Boolean).join('\n') }]
      },
    },
    timeoutMs: 600000,
    execute: async (args, exec) => {
      const subagents = ctx.get('subagents')
      if (!subagents) throw new Error('delegate_batch: no subagents service')
      const list = subagents.list?.() ?? []
      const transport = list.includes('spawn') ? 'spawn' : list[0]
      if (!transport) throw new Error('delegate_batch: no subagent provider registered')
      const tasks = Array.isArray(args.tasks) ? args.tasks : []
      await assertLocalEngine()
      // DEFAULT 0 — the FAIL is the answer, and the caller escalates. This was 1 (a blind local
      // resend) until it was measured: across 10 same-shape observations (`retried > 0`) nothing was
      // ever `recovered`, and since this engine is NOT byte-deterministic a retry is a genuinely
      // different sample rather than a replay — so the old rationale ("the same purchase twice") was
      // wrong in both directions. Three further facts settled it: a resend is what the README advises
      // AGAINST (change the question or split the input — only the caller can do that, the plugin
      // cannot); the preset's contract is "FAIL escalates to DeepSeek", so a silent local re-buy is
      // the wrong default; and with the child's un-strippable tool list a retry can now loop and cost
      // a full DSH_DELEGATE_TIMEOUT_MS budget (measured twice). A caller who really wants a resample
      // can still ask: `retries: 1..3`.
      const retries = Number.isInteger(args.retries) && args.retries >= 0 ? Math.min(args.retries, 3) : 0
      const results = []
      // One directory per batch, created only when something actually needs writing, so a batch of
      // short answers leaves nothing behind.
      let outDir = null
      const ensureOutputDir = () => {
        if (outDir === null) {
          const base = process.env.DSH_DELEGATE_OUTPUT_DIR
          if (base) mkdirSync(base, { recursive: true })
          outDir = mkdtempSync(join(base || tmpdir(), 'dsh-delegate-out-'))
        }
        return outDir
      }
      for (const [index, t] of tasks.entries()) {
        if (exec?.signal?.aborted) throw new Error('aborted')
        // Number the ids: a bare description collides when the same file is delegated twice.
        const id = `${index + 1}.${String(t.description || 'task')}`
        const images = Array.isArray(t.images) ? t.images : []
        let last = { id, ok: false, detail: 'not run', output: '', attempts: 0 }
        // Local compute this task has burned so far, across every attempt (see the footer note).
        let spentMs = 0
        // Prove the gate BEFORE spending a delegation on it. A gate that accepts a wrong answer has
        // no power, and this is the cheapest place to find that out: the local model is never
        // called, and nothing gets escalated either. The positive example may be given outright, or
        // taken from `verify.expected` when that IS the answer (json_equals / set_eq / exact).
        if (t.prove && t.verify && typeof t.verify === 'object') {
          const proofConfig = (typeof t.prove === 'object' && t.prove !== null) ? t.prove : {}
          const kindName = String(t.verify.kind || '')
          const fromCaller = proofConfig.positive !== undefined
          const positive = fromCaller
            ? positiveValue(proofConfig.positive)
            : positiveFromVerify(t.verify)
          if (positive === undefined) {
            results.push({
              id, ok: false, attempts: 0, output: '',
              detail: 'prove: no positive example — pass prove.positive (a known-good answer this verifier must '
                + 'accept), or use a kind whose positive is derivable from `expected`.',
            })
            continue
          }
          const proof = proveGate({
            kind: kindName,
            expected: t.verify.expected,
            field: t.verify.field,
            asserts: t.verify.asserts,
            positive,
            config: proofConfig,
          })
          if (!proof.proven) {
            results.push({
              id, ok: false, attempts: 0, output: '',
              detail: `prove: gate has no power — ${proofWhy(proof, fromCaller ? 'caller' : 'derived')}`,
            })
            continue
          }
        }
        for (let attempt = 1; attempt <= retries + 1; attempt += 1) {
          let out = ''
          let stop = ''
          let diagnostic = ''
          const startedAt = Date.now()
          // ONE child run must not be able to hold the caller for as long as it likes. The budget
          // aborts the child AND unblocks this loop: see `childBudgetMs`. `budgetFired` is read
          // after the await, so the verdict can say *why* the run ended and refuse to retry it.
          const budgetMs = childBudgetMs()
          const budget = new AbortController()
          let budgetTimer
          let budgetFired = false
          try {
            const attemptSignal = exec?.signal && typeof AbortSignal.any === 'function'
              ? AbortSignal.any([exec.signal, budget.signal])
              : budget.signal
            const req = await childRequest(exec, id, String(t.prompt || ''), images, ctx.get('attachments'), attemptSignal)
            // A bad image path is the CALLER's mistake and cannot fix itself: report it as this
            // task's FAIL and move on, rather than letting it escape and take tasks 2..N with it.
            if (req.imageError) {
              last = { id, ok: false, detail: req.imageError, output: '', attempts: attempt, unretryable: true }
              break
            }
            const run = await subagents.start(transport, req)
            // dispose() must run even when the run rejects, or a failed task leaks its child
            // for the rest of the session.
            try {
              // A sentinel rather than a `null` check: whatever `run.result` resolves to is a
              // SubagentResult, and only the timer can produce this value.
              const BUDGET_EXPIRED = Symbol('budget-expired')
              const raced = await Promise.race([
                run.result,
                new Promise((resolve) => {
                  budgetTimer = setTimeout(() => {
                    budgetFired = true
                    budget.abort()
                    resolve(BUDGET_EXPIRED)
                  }, budgetMs)
                }),
              ])
              if (raced === BUDGET_EXPIRED) {
                // The child ignored (or outlived) its signal. Report it as unfinished rather than
                // waiting, and let dispose() below tear the run down.
                out = ''
                stop = 'aborted'
                diagnostic = `no finished answer within this preset's ${budgetMs} ms child budget`
              } else {
                out = textOf(raced)
                stop = String(raced?.stopReason ?? '')
                // `SubagentResult.diagnostic` (present in the running build's own declaration) is the
                // provider's own explanation of an unfinished run. It costs nothing to carry and is the
                // difference between "stop=error" and "stop=error: engine refused the request".
                diagnostic = String(raced?.diagnostic ?? '')
              }
            } finally {
              clearTimeout(budgetTimer)
              try { await run.dispose() } catch { /* already gone */ }
            }
            // Defense in depth: check() already guarantees it never throws, but this call is the
            // one that gates the WHOLE batch.
            const v = t.verify && typeof t.verify === 'object' ? t.verify : null
            let chk
            try {
              chk = v
                ? check(String(v.kind || ''), out, v.expected, v.field, v.asserts)
                : { ok: null, detail: 'no verifier — result is unverified' }
            } catch (e) {
              chk = { ok: false, detail: 'verifier error: ' + String((e && e.message) || e) }
            }
            // THE VERIFIER IS NOT ENOUGH BY ITSELF. A child that hit its token ceiling, was aborted,
            // or errored still returns text, and a PARTIAL answer can satisfy a gate perfectly well
            // (a summary covering half the symbols still covers them). So the stop reason is checked
            // BEFORE the verdict and outranks it: only a finished run may pass.
            if (NON_COMPLETED_STOPS.has(stop)) {
              // Name the remedy that fits the reason. A budget stop is the one case the operator can
              // act on without guessing: the child was still going when the clock ran out.
              const remedy = budgetFired
                ? `; the child was still running when this preset's ${budgetMs} ms budget expired and was aborted`
                  + ' — split the task, or raise DSH_DELEGATE_TIMEOUT_MS'
                : (stop === 'max-tokens' ? `; split the task, or raise DSH_LOCAL_MAX_TOKENS (now ${MAX_TOKENS})` : '')
              last = {
                id,
                ok: false,
                detail: `the child did not finish: stop=${stop}${diagnostic ? ` (${diagnostic})` : ''} — a partial answer is never accepted, not even when `
                  + `it satisfies the verifier${remedy}`,
                output: out.slice(0, OUTPUT_CHARS),
                attempts: attempt,
                stop,
                ...(diagnostic ? { diagnostic } : {}),
                ms: Date.now() - startedAt,
                // A ceiling hit and a budget overrun both reproduce exactly; an abort or a transport
                // error may not, so only those two are kept off the retry path. Without this, a
                // looping child would be retried and burn its whole budget over again.
                ...(stop === 'max-tokens' || budgetFired ? { unretryable: true } : {}),
              }
            } else {
              last = {
                id, ok: chk.ok, detail: chk.detail, output: out.slice(0, OUTPUT_CHARS),
                attempts: attempt, stop: stop || 'unknown', ms: Date.now() - startedAt,
                ...(diagnostic ? { diagnostic } : {}),
              }
            }
          } catch (e) {
            last = {
              id, ok: false, detail: 'delegation error: ' + String((e && e.message) || e),
              output: out.slice(0, OUTPUT_CHARS), attempts: attempt, ms: Date.now() - startedAt,
            }
          }
          // THE ANSWER MUST SURVIVE THE VERDICT. `output` is a bounded echo, and the delegated child
          // has no tools, so before this a PASS whose answer exceeded the echo was UNREADABLE: the
          // caller had to redo the work on DeepSeek and the delegation had saved nothing. Persist the
          // full answer whenever the echo would truncate it, and hand back path + bytes + digest.
          // Written on a FAIL too — the raw answer is the evidence for why it failed.
          last.chars = out.length
          if (out.length > OUTPUT_CHARS) {
            try {
              const saved = persistAnswer(ensureOutputDir(), id, out)
              last.outputFile = saved.file
              last.bytes = saved.bytes
              last.sha256 = saved.sha256
            } catch (e) {
              last.outputFileError = String((e && e.message) || e)
            }
          }
          // What this task has cost so far, retries included — the batch footer sums THIS, not `ms`,
          // or a retried task looks cheaper than it was.
          spentMs += Number.isFinite(last.ms) ? last.ms : 0
          last.spentMs = spentMs
          // Retry only a real verification FAILURE: a success and a null verdict (no verifier
          // configured) both have nothing to retry for, and an unretryable caller error (a bad
          // image path) will reproduce exactly.
          if (last.ok !== false || last.unretryable || attempt > retries || exec?.signal?.aborted) break
          await new Promise((resolve) => setTimeout(resolve, 250))
        }
        results.push(last)
      }
      return { results }
    },
  })

  // REMOVED (measured 2026-10-02): an `engine_info` tool that HTTP-GETs `/health` and returns
  // `max_context`. It never worked in this harness, and the failure is worth recording precisely because
  // it READS like a schema problem and is not one:
  //
  //     Error: content.some is not a function
  //
  // It fires BEFORE the handler runs — a raw `GET /health` to the same URL succeeds in the same second,
  // so the engine is never involved — and it survived BOTH shapes that were tried:
  // `parameters: { properties: {} }` (empty, like the built-in no-argument tools appear to be) and
  // `parameters` carrying one real optional `timeoutMs`. Two candidate explanations were tested and
  // neither held, so the tool is WITHDRAWN rather than shipped as a trap that costs a restart per guess.
  // The knowledge it was meant to carry is not lost: the GUIDE tells the caller to read `max_context`
  // from the engine and to treat `contextWindow - maxTokens` as the prompt ceiling, and
  // `Invoke-RestMethod http://127.0.0.1:8080/health` answers it today. Re-adding it needs the
  // harness-side cause first, not another schema guess.

  ctx.systemPrompt.section({
    name: 'tool:local-delegate',
    order: 116.7,
    // A FUNCTION, not a string — the same shape plan-mode's own policy section uses, and the only
    // place a per-depth text can be chosen. This text is routing advice for the TOP-LEVEL agent: the
    // GUIDE measured 6,679 characters = **1,633 prompt tokens** when these comments were written
    // (more now, with the capacity and async notes), about half the child prompt, paid on EVERY
    // delegation — and a child cannot act on the routing policy anyway. So the full GUIDE never goes
    // to a child.
    // It used to send the child NOTHING, which rested on "a delegated child has no tools here and
    // cannot delegate" — true at maxDepth 1, false once nesting was allowed. The child now receives
    // CHILD_GUIDE: the two traps that cost whole budgets, at roughly a tenth of the length. A child
    // inherits its parent's whole composition — `applyChildComposition` joins the parent's preset
    // generation and can only shadow `deployment:persona-prefix` and restrict tools — so this text
    // callback is the only in-reach place to decide it.
    text: (context) => (isDelegatedChild(context) ? CHILD_GUIDE : GUIDE),
  })
}
