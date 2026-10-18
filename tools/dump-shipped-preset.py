#!/usr/bin/env python3
"""Dump one shipped DSH agent preset declaration out of app.asar, verbatim.

WHY. A new preset that is "the standard preset plus X" must start from the shipped
body VERBATIM, not from a paraphrase: the shipped presets are the known-good
compositions for THIS build, and a renamed or dropped row fails at activation.

WHY THE OBVIOUS SEARCH FAILS. `preset-standard` appears in the archive nine times and
only ONE of them is the declaration:

  * seven are documentation snippets, several of which literally show `plugins: []`
    or the single comment line "# the shipped list with your changes" - a naive
    "longest block containing plugins:" picks a doc page;
  * the real one is NESTED, `- insert:` at column 0 with the declaration at indent 4,
    so a `^- id: preset-...` anchor never matches it.

So the anchor is the marker line at ANY indent, and the terminator is the next list
item at the SAME indent - which is exactly how YAML delimits a sibling entry.

Read-only.

    python tools/dump-shipped-preset.py standard --out standard.yml
    python tools/dump-shipped-preset.py standard --body-only --out standard.body.yml
"""
from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

DEFAULT_ASAR = Path(r"C:\Users\14339\AppData\Local\Programs\DeepSeek Harness\resources\app.asar")

MARKER = re.compile(r"^([ \t]*)-[ \t]*id:[ \t]*preset-([a-z0-9-]+)[ \t]*$", re.M)


def span_by_indent(text: str, start: int, indent: int) -> str:
    """The declaration that begins at `start`, by INDENTATION, not by byte budget.

    Two terminators were wrong before this one:

      * a fixed 40000-byte window truncated `standard`, the largest preset;
      * "the next sibling list item at the same indent" never fired, because this
        declaration is the ONLY item of its enclosing `- insert:` list, so the span ran
        to the end of the archive (8.2 MB) and swallowed every later file.

    What actually ends a YAML mapping nested in a list is the first following line whose
    indent is SHALLOWER than the mapping's own key column and which is not blank or a
    comment. The declaration's keys sit at `indent + 2`, so the block ends at the first
    line indented <= indent.
    """
    lines = text[start:].splitlines(keepends=True)
    keep = [lines[0]]
    for ln in lines[1:]:
        if not ln.strip():
            keep.append(ln)
            continue
        cur = len(ln) - len(ln.lstrip())
        if cur <= indent:
            break
        keep.append(ln)
    return "".join(keep).rstrip() + "\n"


def blocks_for(text: str, preset: str) -> list[tuple[int, str]]:
    """(offset, span) for every `- id: preset-<preset>` whose span is a real declaration."""
    out: list[tuple[int, str]] = []
    for m in MARKER.finditer(text):
        if m.group(2) != preset:
            continue
        # the marker line starts a list item; pass the DASH column, so the item's own keys
        # (one level deeper) are kept and a sibling item at the dash column terminates
        blk = span_by_indent(text, m.start(), len(m.group(1)))
        if "plugins:" in blk:
            out.append((m.start(), blk))
    return out


def plugin_rows(blk: str) -> int:
    return len(re.findall(r"^[ \t]*-[ \t]*id:", blk, re.M))


def dedent_body(blk: str) -> str:
    """The `plugins:` value, dedented back to column 0 so it can be re-emitted at any indent."""
    body = blk.split("plugins:", 1)[1]
    lines = [ln for ln in body.splitlines() if ln.strip()]
    if not lines:
        return ""
    pad = min(len(ln) - len(ln.lstrip()) for ln in lines)
    return "".join((ln[pad:] if len(ln) >= pad else ln) + "\n" for ln in body.splitlines()).lstrip("\n")


def main() -> int:
    # Shipped bodies carry arrows, box glyphs and CJK; a GBK console would raise
    # UnicodeEncodeError on print() and lose the dump entirely.
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:  # noqa: BLE001
        pass

    ap = argparse.ArgumentParser()
    ap.add_argument("preset", help="e.g. standard, ptc, minimal, cordis")
    ap.add_argument("--asar", default=str(DEFAULT_ASAR))
    ap.add_argument("--out", default="")
    ap.add_argument("--body-only", action="store_true",
                    help="emit only the `plugins:` body, dedented back to column 0")
    ap.add_argument("--list", action="store_true", help="list every candidate and exit")
    a = ap.parse_args()

    text = Path(a.asar).read_bytes().decode("utf-8", "replace")
    blocks = blocks_for(text, a.preset)
    if not blocks:
        raise SystemExit(f"no shipped preset named {a.preset!r} carrying a plugins: list")

    if a.list:
        for off, blk in blocks:
            print(f"  offset {off:>10}  bytes {len(blk):>7}  rows {plugin_rows(blk):>4}")
        return 0

    # The declaration is the candidate with the most plugin ROWS; size alone picks a doc page,
    # and one doc snippet is larger than a small preset.
    off, best = max(blocks, key=lambda p: plugin_rows(p[1]))
    if len(blocks) > 1:
        print(f"note: {len(blocks)} candidate spans; chose offset {off} with {plugin_rows(best)} rows")

    out = dedent_body(best) if a.body_only else best

    print(f"preset      : {a.preset}")
    print(f"bytes       : {len(out)}")
    print(f"lines       : {len(out.splitlines())}")
    print(f"plugin rows : {plugin_rows(out)}")
    print("-" * 70)
    print(out if len(out) < 6000 else out[:3000] + "\n... [truncated in console] ...\n")
    if a.out:
        Path(a.out).write_text(out, encoding="utf-8")
        print(f"wrote {a.out}  ({len(out)} B)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
