#!/usr/bin/env node
/**
 * subagent-trace.mjs — read the on-disk record of a DSH subagent (or any session).
 *
 * DSH writes every session — the parent and each delegated child alike — to
 *   <DSH_HOME>/sessions/<workspace-slug>/<sessionId>/session.v4.jsonl.zstd
 * as a stream of APPENDED zstd frames, one JSONL payload per frame. That file is
 * the only place a delegated child's steps are visible: the parent model gets the
 * child's final answer and a messages channel, but not its step-by-step work.
 *
 * Two traps this script exists to handle:
 *   1. `zlib.zstdDecompressSync()` decodes only the FIRST frame (measured: 239 of
 *      26116 bytes, 299 bytes out). The frames must be walked one at a time.
 *   2. Every event carries a millisecond timestamp (often inside `data`), so the
 *      timeline can show *where the child stalled* — the difference between
 *      "it failed" and "it burned the budget on step 2".
 *
 * Usage:
 *   node subagent-trace.mjs --last [N]            recent sessions, newest first
 *   node subagent-trace.mjs <id-prefix>           timeline summary
 *   node subagent-trace.mjs <id-prefix> --watch   follow a RUNNING child
 *   node subagent-trace.mjs <id-prefix> --raw     decompressed JSONL (pipe to grep)
 *   node subagent-trace.mjs <id-prefix> --json    one raw JSON event per line
 *   node subagent-trace.mjs --last 1 --follow     follow whatever is newest
 *
 * Options:
 *   --last [N]       list the N most recent sessions (default 10)
 *   --watch          poll and print only newly appended events
 *   --follow         like --watch, but keep waiting after turn/end
 *   --interval MS    watch poll interval (default 500)
 *   --tail N         show only the last N rendered lines
 *   --full           do not truncate event payloads
 *   --all-events     include usually-folded events (system/message, request/*, ...)
 *   --raw | --json   dump payload instead of rendering a timeline
 *   --root DIR       DSH home (default $DSH_HOME, else ~/.dsh)
 *   --no-color       disable ANSI colour
 *
 * Exit codes: 0 ok · 2 usage/lookup error · 3 the record could not be decoded.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";

const RECORD_RE = /^session\.v\d+\.jsonl\.zstd$/;

const USAGE = `subagent-trace — read a DSH subagent's on-disk session record

  node subagent-trace.mjs --last [N]            recent sessions, newest first
  node subagent-trace.mjs <id-prefix>           timeline summary
  node subagent-trace.mjs <id-prefix> --watch   follow a RUNNING child
  node subagent-trace.mjs <id-prefix> --raw     decompressed JSONL (pipe to grep)
  node subagent-trace.mjs <id-prefix> --json    one raw JSON event per line

Options:
  --last [N]     list N most recent sessions (default 10)
  --watch        poll and print only newly appended events
  --follow       like --watch, but keep waiting after turn/end
  --interval MS  watch poll interval (default 500)
  --tail N       show only the last N rendered lines
  --full         do not truncate event payloads
  --all-events   include usually-folded events (system/message, request/*, ...)
  --raw --json   dump payload instead of rendering a timeline
  --root DIR     DSH home (default $DSH_HOME, else ~/.dsh)
  --no-color     disable ANSI colour
`;

/* ------------------------------------------------------------------ cli -- */
function die(msg, code = 2) {
  process.stderr.write(`subagent-trace: ${msg}\n`);
  process.exit(code);
}

const opt = {
  watch: false, follow: false, raw: false, json: false, full: false,
  allEvents: false, tail: 0, last: 0, root: null, interval: 500, color: null,
};
const positional = [];
{
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => {
      const v = argv[++i];
      if (v === undefined) die(`${a} needs a value`);
      return v;
    };
    if (a === "-h" || a === "--help") { process.stdout.write(USAGE); process.exit(0); }
    else if (a === "--watch") opt.watch = true;
    else if (a === "--follow") { opt.watch = true; opt.follow = true; }
    else if (a === "--raw") opt.raw = true;
    else if (a === "--json") opt.json = true;
    else if (a === "--full") opt.full = true;
    else if (a === "--all-events") opt.allEvents = true;
    else if (a === "--no-color") opt.color = false;
    else if (a === "--tail") opt.tail = Number(val()) || 0;
    else if (a === "--interval") opt.interval = Math.max(50, Number(val()) || 500);
    else if (a === "--root") opt.root = val();
    else if (a === "--last") {
      opt.last = 10;
      if (argv[i + 1] !== undefined && /^\d+$/.test(argv[i + 1])) opt.last = Number(argv[++i]);
    } else if (/^--last=\d+$/.test(a)) opt.last = Number(a.split("=")[1]);
    else if (a.startsWith("-")) die(`unknown option ${a}\n\n${USAGE}`);
    else positional.push(a);
  }
}

const ROOT = opt.root || process.env.DSH_HOME || path.join(os.homedir(), ".dsh");
const SESSIONS = path.join(ROOT, "sessions");
if (!fs.existsSync(SESSIONS)) die(`no sessions directory at ${SESSIONS} (use --root)`, 2);
if (typeof zlib.createZstdDecompress !== "function")
  die("this Node has no zstd support (need Node >= 22.15 / 23.4); upgrade Node", 3);

/* ---------------------------------------------------------------- colour -- */
const useColor = opt.color === null ? Boolean(process.stdout.isTTY && !process.env.NO_COLOR) : opt.color;
const paint = (code, s) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : String(s));
const dim = (s) => paint("2", s);
const bold = (s) => paint("1", s);
const cyan = (s) => paint("36", s);
const green = (s) => paint("32", s);
const red = (s) => paint("31", s);
const yellow = (s) => paint("33", s);

/* ------------------------------------------------------------- discovery -- */
function listRecords() {
  const out = [];
  for (const slug of fs.readdirSync(SESSIONS)) {
    const slugDir = path.join(SESSIONS, slug);
    let entries;
    try { entries = fs.readdirSync(slugDir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const dir = path.join(slugDir, e.name);
      let files;
      try { files = fs.readdirSync(dir); } catch { continue; }
      const rec = files.find((f) => RECORD_RE.test(f));
      if (!rec) continue;
      const file = path.join(dir, rec);
      let st;
      try { st = fs.statSync(file); } catch { continue; }
      out.push({ id: e.name, slug, dir, file, mtime: st.mtimeMs, size: st.size });
    }
  }
  out.sort((a, b) => b.mtime - a.mtime);
  return out;
}

function resolveOne(prefix) {
  const all = listRecords();
  const hits = all.filter((r) => r.id.startsWith(prefix) || r.id.includes(prefix));
  if (hits.length === 0) {
    die(`no session whose id matches "${prefix}"\n` +
        `       try: node subagent-trace.mjs --last 15`, 2);
  }
  if (hits.length > 1) {
    const exact = hits.find((r) => r.id === prefix);
    if (exact) return exact;
    die(`"${prefix}" matches ${hits.length} sessions:\n` +
        hits.slice(0, 10).map((r) => `         ${r.id}  (${fmtTime(r.mtime)})`).join("\n"), 2);
  }
  return hits[0];
}

/* ------------------------------------------------------------ zstd walker -- */
/** Decode exactly one zstd frame; resolves null on error (e.g. a half-written frame). */
function frameOnce(buf) {
  return new Promise((res) => {
    const s = zlib.createZstdDecompress();
    const chunks = [];
    let settled = false;
    s.on("data", (d) => chunks.push(d));
    s.on("error", () => { if (!settled) { settled = true; res(null); } });
    s.on("end", () => { if (!settled) { settled = true; res({ out: Buffer.concat(chunks), used: s.bytesWritten }); } });
    s.end(buf);
  });
}

/**
 * Walk EVERY appended frame. A single zstdDecompressSync() would stop after the
 * first one, silently truncating the record.
 */
async function readRecord(file) {
  const buf = fs.readFileSync(file);
  let off = 0, frames = 0, partial = false;
  const parts = [];
  while (off < buf.length) {
    const r = await frameOnce(buf.subarray(off));
    if (!r || !r.used) { partial = true; break; }
    parts.push(r.out);
    off += r.used;
    frames++;
  }
  const text = Buffer.concat(parts).toString("utf8");
  const lines = text.split("\n").filter((l) => l.trim().length);
  const events = [];
  for (const l of lines) {
    try { events.push(JSON.parse(l)); } catch { partial = true; }
  }
  return { buf, frames, partial, lines, events, consumed: off };
}

/* -------------------------------------------------------------- rendering -- */
const clip = (s, n) => {
  let x = String(s ?? "").replace(/\s+/g, " ").trim();
  if (x.length > n) x = x.slice(0, n) + "…";
  return x;
};
const P = (j) => (j && typeof j === "object" && j.data && typeof j.data === "object" ? j.data : j);
const T = (j) => {
  const p = P(j);
  const t = j.time ?? j.ts ?? j.timestamp ?? p.time ?? p.ts ?? j.createdAt ?? null;
  return typeof t === "number" ? t : null;
};
const fmtTime = (t) => {
  const d = new Date(t);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};
const contentText = (msg) =>
  (msg?.content ?? []).map((c) => (typeof c === "string" ? c : c.text ?? (c.type === "tool-call" ? `[call ${c.name}]` : ""))).join(" ");

function summarize(j, ctx) {
  const p = P(j);
  const N = opt.full ? 1e9 : 200;
  switch (j.type) {
    case "session":
      return { tag: "session", detail: `origin=${p.origin ?? "-"} depth=${p.delegationDepth ?? "-"} preset=${p.agentPreset ?? "-"}`, tone: "bold" };
    case "subagent/descriptor":
      return { tag: "descriptor", detail: `mode=${p.mode ?? "?"} spawn=${p.provider ?? p.agentProvider ?? "?"} label="${p.label ?? ""}"` };
    case "subagent/model-selection-policy":
      return opt.allEvents ? { tag: "model-policy", detail: clip(JSON.stringify(p.allowedModels ?? p), N) } : null;
    case "turn/start": return { tag: "turn/start", detail: `turn=${p.turn ?? "?"}` };
    case "turn/end": return { tag: "turn/end", detail: `reason=${p.reason?.kind ?? p.reason ?? "?"}`, tone: "bold" };
    case "step/start": return { tag: "step/start", detail: `step=${p.step ?? "?"}` };
    case "step/end": return { tag: "step/end", detail: `step=${p.step ?? "?"}` };
    case "assistant/attempt": return { tag: "attempt", detail: clip(JSON.stringify(p), N), tone: "yellow" };
    case "assistant/message": {
      const c = p.message?.content ?? [];
      const tc = c.find((x) => x && x.type === "tool-call");
      const tx = c.find((x) => x && x.type === "text");
      if (tc) {
        ctx.calls.set(tc.id ?? tc.callId, tc.name);
        return { tag: "model -> call", detail: `${tc.name} ${clip(tc.arguments ?? "", opt.full ? 1e9 : 140)}` };
      }
      if (tx) return { tag: "model -> text", detail: clip(tx.text, N) };
      return { tag: "model -> ?", detail: clip(JSON.stringify(c), N) };
    }
    case "tool/call": {
      ctx.calls.set(p.callId, p.name);
      return opt.allEvents ? { tag: "tool/call", detail: `${p.name} ${clip(p.arguments ?? "", opt.full ? 1e9 : 160)}` } : null;
    }
    case "tool/result": {
      const src = p.message?.source ?? {};
      const name = ctx.calls.get(src.callId) ?? src.name ?? src.kind ?? "tool";
      const txt = contentText(p.message);
      const bad = p.message?.isError === true || /^\s*(error|exception)\b/i.test(txt) || /not found|denied|no such/i.test(txt.slice(0, 200));
      return {
        tag: "tool <- result",
        detail: `${name} ${txt.length ? `(${txt.length}B) ` : ""}${clip(txt, N)}`,
        tone: bad ? "red" : "green",
      };
    }
    case "agent/inbox/spliced": {
      const ins = p.inserted ?? [];
      const txt = ins.flatMap((x) => x.content ?? []).map((c) => c.text ?? "").join(" ");
      if (!txt.trim()) return opt.allEvents ? { tag: "inbox", detail: `-${p.removedCount ?? 0}` } : null;
      return { tag: "inbox", detail: clip(txt, N), tone: "dim" };
    }
    case "workspace/changes":
      return { tag: "workspace", detail: clip(JSON.stringify(p), N) };
    case "session/title":
      return opt.allEvents ? { tag: "title", detail: clip(p.title, N) } : null;
    default:
      return opt.allEvents ? { tag: j.type ?? "?", detail: clip(JSON.stringify(p), N) } : null;
  }
}

function renderHeader(rec, evs, frames, partial) {
  const h = evs.find((j) => j.type === "session") ?? {};
  const hp = P(h);
  const ctxEv = evs.find((j) => j.type === "request/context");
  const model = ctxEv ? `${P(ctxEv).provider}/${P(ctxEv).model}` : (evs.find((j) => j.type === "subagent/model-selection-policy")?.data?.allowedModels?.[0]
    ? `${evs.find((j) => j.type === "subagent/model-selection-policy").data.allowedModels[0].provider}/${evs.find((j) => j.type === "subagent/model-selection-policy").data.allowedModels[0].model}`
    : "-");
  const lines = [
    bold(`session  : ${rec?.id ?? hp.id ?? "?"}`),
    `cwd      : ${hp.cwd ?? "-"}`,
    `origin   : ${hp.origin ?? "-"}   depth=${hp.delegationDepth ?? "-"}   preset=${hp.agentPreset ?? "-"}`,
  ];
  if (hp.parentSession) lines.push(`parent   : ${hp.parentSession}`);
  lines.push(`model    : ${model}`);
  lines.push(`frames   : ${frames}${partial ? yellow(" (last frame incomplete — still being written?)") : ""}   events: ${evs.length}`);
  if (rec?.file) lines.push(dim(`file     : ${rec.file}`));
  return lines.join("\n");
}

function renderEvents(evs, ctx, from) {
  const out = [];
  for (let i = from; i < evs.length; i++) {
    const j = evs[i];
    const t = T(j);
    if (t !== null && ctx.t0 === null) ctx.t0 = t;
    const s = summarize(j, ctx);
    if (!s) continue;
    let stamp = "";
    if (t !== null) stamp = `+${((t - ctx.t0) / 1000).toFixed(3)}s`;
    else stamp = dim("     ·  ");
    const tag = String(s.tag).padEnd(14);
    const paintedTag = s.tone === "red" ? red(tag) : s.tone === "green" ? cyan(tag)
      : s.tone === "yellow" ? yellow(tag) : s.tone === "dim" ? dim(tag) : s.tone === "bold" ? bold(tag) : tag;
    out.push(`${stamp.padStart(11)}  ${paintedTag}  ${s.detail}`);
  }
  return out;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ modes -- */
async function modeList(n) {
  const all = listRecords();
  if (all.length === 0) die("no session records found", 2);
  const picked = all.slice(0, n);
  const rows = [];
  for (const r of picked) {
    let info = { frames: "?", lines: "?", origin: "-", depth: "-", preset: "-", parent: "" };
    try {
      const { events, frames } = await readRecord(r.file);
      const h = events.find((j) => j.type === "session");
      const hp = h ? P(h) : {};
      info = {
        frames, lines: events.length,
        origin: hp.origin ?? "-", depth: hp.delegationDepth ?? "-",
        preset: hp.agentPreset ?? "-", parent: hp.parentSession ? `parent=${hp.parentSession.slice(0, 20)}` : "",
      };
    } catch { /* leave as unknown */ }
    rows.push([
      fmtTime(r.mtime),
      r.id.slice(0, 8),
      `${info.origin} d${info.depth}`,
      String(info.preset),
      String(info.frames).padStart(5) + "f",
      String(info.lines).padStart(4) + "e",
      String(Math.round(r.size / 1024)).padStart(4) + "K",
      dim(info.parent),
      dim(r.slug.replace(/^--|--$/g, "")),
    ]);
  }
  const head = ["when", "id", "origin", "preset", "frames", "events", "size", "parent", "workspace"];
  const widths = head.map((h, i) => Math.max(h.length, ...rows.map((r) => stripAnsi(r[i]).length)));
  const line = (cells) => cells.map((c, i) => c + " ".repeat(Math.max(0, widths[i] - stripAnsi(c).length))).join("  ");
  process.stdout.write(bold(line(head)) + "\n");
  for (const r of rows) process.stdout.write(line(r) + "\n");
  process.stdout.write(dim(`\n${all.length} session record(s) under ${SESSIONS}\n`) +
    dim(`inspect one with: node subagent-trace.mjs <id-prefix>\n`));
}
const stripAnsi = (s) => String(s).replace(/\x1b\[[0-9;]*m/g, "");

async function modeDump(rec, rawMode) {
  const { lines } = await readRecord(rec.file);
  if (rawMode) {
    process.stdout.write(lines.join("\n") + "\n");
    return;
  }
  // --json : one NORMALISED event per line (type/tag/detail + relative ms), for jq-style use.
  const ctx = { t0: null, calls: new Map() };
  const out = [];
  for (const l of lines) {
    let j;
    try { j = JSON.parse(l); } catch { continue; }
    const t = T(j);
    if (t !== null && ctx.t0 === null) ctx.t0 = t;
    const s = summarize(j, ctx);
    if (!s) continue;
    out.push(JSON.stringify({
      t, dt: t !== null ? Number(((t - ctx.t0) / 1000).toFixed(3)) : null,
      type: j.type, tag: s.tag, detail: s.detail,
    }));
  }
  process.stdout.write(out.join("\n") + "\n");
}

async function modeTimeline(rec) {
  const ctx = { t0: null, calls: new Map() };
  const { events, frames, partial } = await readRecord(rec.file);
  process.stdout.write(renderHeader(rec, events, frames, partial) + "\n\n");
  let rendered = renderEvents(events, ctx, 0);
  if (opt.tail > 0) rendered = rendered.slice(-opt.tail);
  process.stdout.write(rendered.join("\n") + (rendered.length ? "\n" : ""));

  if (!opt.watch) return;

  let printed = events.length;
  let announcedEnd = false;
  for (;;) {
    await sleep(opt.interval);
    let snap;
    try { snap = await readRecord(rec.file); } catch (e) { process.stdout.write(dim(`\n[read error: ${e.message}]\n`)); continue; }
    if (snap.events.length > printed) {
      const fresh = renderEvents(snap.events, ctx, printed);
      printed = snap.events.length;
      if (fresh.length) process.stdout.write(fresh.join("\n") + "\n");
      for (const j of snap.events) if (j.type === "turn/end") announcedEnd = true;
    }
    if (announcedEnd && !opt.follow) {
      process.stdout.write(dim("\n[turn ended — stopping. use --follow to keep watching]\n"));
      return;
    }
  }
}

/* ------------------------------------------------------------------- main -- */
async function main() {
  if (opt.last > 0 && positional.length === 0) return modeList(opt.last);

  let rec;
  if (positional.length > 0) {
    rec = resolveOne(positional[0]);
  } else if (opt.watch) {
    const all = listRecords();
    if (!all.length) die("no session records found", 2);
    rec = all[0];
  } else {
    process.stdout.write(USAGE);
    process.exit(0);
  }

  if (opt.raw || opt.json) return modeDump(rec, opt.raw);
  return modeTimeline(rec);
}

main().catch((e) => die(e?.stack ?? String(e), 3));
